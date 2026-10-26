// The extractor (#36, SPEC.md "Nightly extraction", step 3): requests go to Claude Haiku 5.5
// through the Batch API, and the `jobs` table remembers the batch, so a poll that dies part way
// resumes without resubmitting. Results land in `candidates`; nothing reaches the vault here.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Database from "better-sqlite3";
import { cutRequests, type ExtractionRequest, forgetSubmitted, markSubmitted, MAX_REQUEST_CHARS, selectForExtraction } from "./extractInput.js";
import { EXTRACT_MODEL, EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM, ExtractionSchema, renderSource } from "./extractPrompt.js";

/** Counted, not estimated: under the 100k-token price step with the prompt's ~3k tokens of room. */
export const MAX_REQUEST_TOKENS = 97_000;
const MAX_OUTPUT_TOKENS = 16_000;
/** A request is never cut below this; a source that still counts over is sent as it is. */
const MIN_REQUEST_CHARS = 10_000;

export interface BatchParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
  output_config: { format: { type: "json_schema"; schema: Record<string, unknown> }; effort: "medium" };
}
export interface BatchRequest {
  custom_id: string;
  params: BatchParams;
}
export interface BatchUsage {
  input_tokens: number;
  output_tokens: number;
}
export interface BatchResult {
  custom_id: string;
  result: { type: "succeeded"; text: string; stop_reason: string | null; usage: BatchUsage } | { type: "errored" | "canceled" | "expired" };
}

/** The part of the Batch API the extractor uses; the seam the tests replace. */
export interface BatchClient {
  create(requests: BatchRequest[]): Promise<{ id: string }>;
  status(id: string): Promise<"in_progress" | "canceling" | "ended">;
  results(id: string): AsyncIterable<BatchResult>;
  countTokens(params: BatchParams): Promise<number>;
}

/** Always the real API: ANTHROPIC_BASE_URL may point at a proxy that rewrites content. */
export function anthropicBatchClient(apiKey: string): BatchClient {
  const client = new Anthropic({ apiKey, baseURL: "https://api.anthropic.com" });
  return {
    async create(requests) {
      return client.messages.batches.create({ requests });
    },
    async status(id) {
      return (await client.messages.batches.retrieve(id)).processing_status;
    },
    async *results(id) {
      for await (const r of await client.messages.batches.results(id)) {
        if (r.result.type === "succeeded") {
          const m = r.result.message;
          const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
          yield { custom_id: r.custom_id, result: { type: "succeeded", text, stop_reason: m.stop_reason, usage: { input_tokens: m.usage.input_tokens, output_tokens: m.usage.output_tokens } } };
        } else yield { custom_id: r.custom_id, result: { type: r.result.type } };
      }
    },
    async countTokens(params) {
      const { max_tokens: _, ...rest } = params;
      return (await client.messages.countTokens(rest)).input_tokens;
    },
  };
}

/** The JSON schema only: the SDK's parse function cannot travel in a batch request. */
const outputFormat = (() => {
  const { type, schema } = zodOutputFormat(ExtractionSchema);
  return { type, schema } as BatchParams["output_config"]["format"];
})();

export function requestParams(r: ExtractionRequest): BatchParams {
  return {
    model: EXTRACT_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content: renderSource(r.source, r.turns) }],
    output_config: { format: outputFormat, effort: "medium" },
  };
}

interface JobPayload {
  requests: Record<string, { sourceId: number; refs: Record<string, number> }>;
  usage?: BatchUsage;
}

const runningJob = (db: Database.Database) =>
  db.prepare("SELECT id, batch_id FROM jobs WHERE type = 'extract' AND state = 'running' ORDER BY id LIMIT 1").get() as { id: number; batch_id: string } | undefined;

/** Every request the next submit would send, cut by characters only (no API call): what `--dry-run` reports. */
export function planExtraction(db: Database.Database, opts: { from?: string } = {}) {
  const sources = selectForExtraction(db, opts);
  const requests = sources.flatMap((s) => cutRequests(s.sourceId, s.source, s.turns));
  return { sources, requests };
}

/** Submits one batch over every source whose input changed; null job when there is nothing to send. */
export async function submitExtraction(db: Database.Database, client: BatchClient, opts: { from?: string } = {}) {
  const running = runningJob(db);
  if (running) throw new Error(`an extraction batch is still running (job ${running.id}, ${running.batch_id}); run: brain extract poll`);
  const sources = selectForExtraction(db, opts);
  const batch: BatchRequest[] = [];
  const payload: JobPayload = { requests: {} };
  let inputTokens = 0;
  for (const s of sources) {
    // A source whose requests count over the limit is cut again, smaller, until each fits.
    let maxChars = MAX_REQUEST_CHARS;
    let counted: { r: ExtractionRequest; tokens: number }[];
    for (;;) {
      counted = [];
      for (const r of cutRequests(s.sourceId, s.source, s.turns, maxChars)) counted.push({ r, tokens: await client.countTokens(requestParams(r)) });
      const over = counted.filter((c) => c.tokens > MAX_REQUEST_TOKENS);
      if (!over.length) break;
      // Half the largest request that counted over: a dense source can be well under the character cap.
      const next = Math.floor(Math.max(...over.map((c) => c.r.chars)) / 2);
      if (next < MIN_REQUEST_CHARS) break;
      maxChars = next;
    }
    for (const { r, tokens } of counted) {
      batch.push({ custom_id: r.customId, params: requestParams(r) });
      payload.requests[r.customId] = { sourceId: s.sourceId, refs: Object.fromEntries(r.turns.map((t) => [t.ref, t.turnId])) };
      inputTokens += tokens;
    }
  }
  if (!batch.length) return { jobId: null, requests: 0, sources: 0, inputTokens: 0 };
  const { id: batchId } = await client.create(batch);
  const jobId = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO jobs (type, state, batch_id, started_at, payload) VALUES ('extract', 'running', ?, ?, ?)")
      .run(batchId, new Date().toISOString(), JSON.stringify(payload));
    for (const s of sources) markSubmitted(db, s.sourceId, s.inputSha256, Number(lastInsertRowid));
    return Number(lastInsertRowid);
  })();
  return { jobId, requests: batch.length, sources: sources.length, inputTokens };
}

/** Reads every ended batch into candidates. Safe to re-run: a result already stored is skipped. */
export async function pollExtraction(db: Database.Database, client: BatchClient) {
  const report = { ended: 0, running: 0, candidates: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0 };
  const jobs = db.prepare("SELECT id, batch_id, payload FROM jobs WHERE type = 'extract' AND state = 'running' ORDER BY id").all() as { id: number; batch_id: string; payload: string }[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO candidates (job_id, custom_id, ord, source_id, claim_json, model, prompt, batch_id, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
  );
  for (const job of jobs) {
    if ((await client.status(job.batch_id)) !== "ended") {
      report.running++;
      continue;
    }
    const payload = JSON.parse(job.payload) as JobPayload;
    const usage: BatchUsage = { input_tokens: 0, output_tokens: 0 };
    const failedSources = new Set<number>();
    let failed = 0;
    for await (const { custom_id, result } of client.results(job.batch_id)) {
      const req = payload.requests[custom_id];
      if (!req) continue;
      if (result.type !== "succeeded") {
        failedSources.add(req.sourceId);
        failed++;
        continue;
      }
      usage.input_tokens += result.usage.input_tokens;
      usage.output_tokens += result.usage.output_tokens;
      let parsed: ReturnType<typeof ExtractionSchema.safeParse> | null = null;
      try {
        parsed = result.stop_reason === "end_turn" ? ExtractionSchema.safeParse(JSON.parse(result.text)) : null;
      } catch {
        parsed = null;
      }
      if (!parsed?.success) {
        failedSources.add(req.sourceId);
        failed++;
        continue;
      }
      db.transaction(() => {
        parsed.data.claims.forEach((c, ord) => {
          const claim = { ...c, evidence: c.evidence.map((e) => ({ ref: e.turn, turn_id: req.refs[e.turn] ?? null, quote: e.quote })) };
          insert.run(job.id, custom_id, ord, req.sourceId, JSON.stringify(claim), EXTRACT_MODEL, EXTRACT_PROMPT_VERSION, job.batch_id);
        });
      })();
    }
    // The job is done only once every result is read: a poll that died above leaves it running.
    db.transaction(() => {
      if (failedSources.size) forgetSubmitted(db, job.id, [...failedSources]);
      db.prepare("UPDATE jobs SET state = 'done', finished_at = ?, payload = ? WHERE id = ?").run(new Date().toISOString(), JSON.stringify({ ...payload, usage }), job.id);
    })();
    report.ended++;
    report.failedRequests += failed;
    report.inputTokens += usage.input_tokens;
    report.outputTokens += usage.output_tokens;
    report.candidates += (db.prepare("SELECT count(*) AS n FROM candidates WHERE job_id = ?").get(job.id) as { n: number }).n;
  }
  return report;
}

