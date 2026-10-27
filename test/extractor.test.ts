import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { anthropicApiKey } from "../src/config.js";
import { openDb } from "../src/db.js";
import { selectForExtraction } from "../src/extractInput.js";
import { type BatchClient, type BatchRequest, type BatchResult, MAX_REQUEST_TOKENS, pollExtraction, submitExtraction } from "../src/extractor.js";
import { EXTRACT_MODEL, EXTRACT_PROMPT_VERSION, type ExtractedClaim } from "../src/extractPrompt.js";
import { migrate } from "../src/migrations.js";
import { type TurnRow, writeSource } from "../src/sources.js";
import { tmpDir } from "./helpers.js";

let db: ReturnType<typeof openDb>;

const turn = (externalUuid: string, role: string, text: string, ts: string): TurnRow => ({ externalUuid, parentUuid: null, role, ts, text, isSidechain: false, isInjected: false });
function source(external_id: string, turns: TurnRow[]): number {
  writeSource(
    db,
    { kind: "cc", external_id, title: external_id, project_hint: null, cwd: null, created_at: null, updated_at: "2026-10-10T00:00:00Z", raw_path: "raw", raw_sha256: "abc", parser_version: "test" },
    turns,
  );
  return (db.prepare("SELECT id FROM sources WHERE external_id = ?").get(external_id) as { id: number }).id;
}
const turnIdOf = (uuid: string) => (db.prepare("SELECT id FROM turns WHERE external_uuid = ?").get(uuid) as { id: number }).id;

export const claimOut = (over: Partial<ExtractedClaim> = {}): ExtractedClaim => ({
  kind: "project_fact",
  scope: "project:ai-brain",
  statement: "L'utilisateur utilise SQLite pour l'index.",
  statement_lang: "fr",
  origin: "user_stated",
  evidence: [{ turn: "T1", quote: "on part sur SQLite" }],
  time_expression: null,
  valid_from: null,
  valid_from_precision: "unknown",
  confidence: 0.9,
  sensitivity: "normal",
  decision: null,
  ...over,
});
const ok = (claims: ExtractedClaim[]): BatchResult["result"] => ({ type: "succeeded", text: JSON.stringify({ claims }), stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } });

/** A Batch API stand-in: records what was sent and serves the results a test sets. */
class FakeBatches implements BatchClient {
  created: BatchRequest[][] = [];
  ended = new Map<string, Record<string, BatchResult["result"]>>();
  failAfter = Infinity;
  tokens: (p: BatchRequest["params"]) => number = (p) => Math.ceil(JSON.stringify(p).length / 2.25);
  async create(requests: BatchRequest[]) {
    this.created.push(requests);
    return { id: `msgbatch_${this.created.length}` };
  }
  async status(id: string) {
    return this.ended.has(id) ? ("ended" as const) : ("in_progress" as const);
  }
  async *results(id: string): AsyncIterable<BatchResult> {
    let n = 0;
    for (const [custom_id, result] of Object.entries(this.ended.get(id) ?? {})) {
      if (n++ >= this.failAfter) throw new Error("socket hang up");
      yield { custom_id, result };
    }
  }
  async countTokens(params: BatchRequest["params"]) {
    return this.tokens(params);
  }
}

let fake: FakeBatches;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  fake = new FakeBatches();
});

const candidates = () => db.prepare("SELECT * FROM candidates ORDER BY id").all() as Record<string, unknown>[];
const jobState = () => (db.prepare("SELECT state FROM jobs WHERE type = 'extract'").get() as { state: string }).state;

describe("extraction batch", () => {
  it("a batch over a fixture slice comes back as parsed candidate claims", async () => {
    const s1 = source("s1", [turn("u1", "user", "Bon, on part sur SQLite, pas Postgres.", "2026-10-01T09:00:00Z"), turn("a1", "assistant", "Noted.", "2026-10-01T09:00:05Z")]);
    const sub = await submitExtraction(db, fake);
    expect(sub).toMatchObject({ requests: 1, sources: 1 });
    const req = fake.created[0]![0]!;
    expect(req.custom_id).toBe(`s${s1}-c1`);
    expect(req.params).toMatchObject({ model: EXTRACT_MODEL, max_tokens: 16000, output_config: { effort: "medium", format: { type: "json_schema" } } });
    expect(JSON.stringify(req.params.output_config)).not.toContain("parse");
    expect(req.params.messages[0]!.content).toContain('<turn id="T1" role="user"');

    fake.ended.set("msgbatch_1", { [`s${s1}-c1`]: ok([claimOut(), claimOut({ statement: "Second.", evidence: [{ turn: "T9", quote: "x" }] })]) });
    const r = await pollExtraction(db, fake);
    expect(r).toMatchObject({ ended: 1, running: 0, candidates: 2, failedRequests: 0, inputTokens: 1000, outputTokens: 100 });
    const c = candidates();
    expect(JSON.parse(c[0]!.claim_json as string).evidence).toEqual([{ ref: "T1", turn_id: turnIdOf("u1"), quote: "on part sur SQLite" }]);
    expect(JSON.parse(c[1]!.claim_json as string).evidence[0].turn_id).toBeNull();
    expect(c.map((x) => x.state)).toEqual(["new", "new"]);
    expect(jobState()).toBe("done");
  });

  it("stores prompt version, model and batch id on every candidate", async () => {
    const s1 = source("s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    await submitExtraction(db, fake);
    fake.ended.set("msgbatch_1", { [`s${s1}-c1`]: ok([claimOut(), claimOut()]) });
    await pollExtraction(db, fake);
    expect(candidates().every((r) => r.prompt === EXTRACT_PROMPT_VERSION && r.model === EXTRACT_MODEL && r.batch_id === "msgbatch_1" && r.source_id === s1)).toBe(true);
    expect(EXTRACT_PROMPT_VERSION).toBe("extract@v2");
  });

  it("a poll before the batch ends changes nothing", async () => {
    source("s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    await submitExtraction(db, fake);
    expect(await pollExtraction(db, fake)).toMatchObject({ ended: 0, running: 1, candidates: 0 });
    expect(jobState()).toBe("running");
  });

  it("an interrupted poll resumes from jobs without resubmitting", async () => {
    const s1 = source("s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    const s2 = source("s2", [turn("u2", "user", "Je garde Hono.", "2026-10-01T09:00:00Z")]);
    await submitExtraction(db, fake);
    fake.ended.set("msgbatch_1", { [`s${s1}-c1`]: ok([claimOut()]), [`s${s2}-c1`]: ok([claimOut({ statement: "Hono." })]) });
    fake.failAfter = 1;
    await expect(pollExtraction(db, fake)).rejects.toThrow(/socket hang up/);
    expect(jobState()).toBe("running");
    fake.failAfter = Infinity;
    const r = await pollExtraction(db, fake);
    expect(fake.created).toHaveLength(1);
    expect(candidates()).toHaveLength(2);
    expect(r.inputTokens).toBe(2000);
    expect(jobState()).toBe("done");
  });

  it("a source whose request errored is selected again next run", async () => {
    const s1 = source("s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    const s2 = source("s2", [turn("u2", "user", "Je garde Hono.", "2026-10-01T09:00:00Z")]);
    await submitExtraction(db, fake);
    fake.ended.set("msgbatch_1", { [`s${s1}-c1`]: { type: "errored" }, [`s${s2}-c1`]: ok([]) });
    expect((await pollExtraction(db, fake)).failedRequests).toBe(1);
    expect(selectForExtraction(db).map((s) => s.sourceId)).toEqual([s1]);
  });

  it("an unparsable result counts as failed, not as zero claims", async () => {
    const s1 = source("s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    await submitExtraction(db, fake);
    fake.ended.set("msgbatch_1", { [`s${s1}-c1`]: { type: "succeeded", text: '{"claims": [{"kind": "mood"}]}', stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
    expect(await pollExtraction(db, fake)).toMatchObject({ failedRequests: 1, candidates: 0 });
    expect(selectForExtraction(db)).toHaveLength(1);
  });

  it("re-cuts a request whose counted tokens pass MAX_REQUEST_TOKENS", async () => {
    source("s1", Array.from({ length: 4 }, (_, i) => turn(`u${i}`, "user", `${"mot ".repeat(2000)}${i}`, `2026-10-01T09:00:0${i}Z`)));
    let first = true;
    fake.tokens = () => {
      if (first) {
        first = false;
        return MAX_REQUEST_TOKENS + 1;
      }
      return 1000;
    };
    expect((await submitExtraction(db, fake)).requests).toBe(2);
    expect(fake.created[0]!.flatMap((r) => [...r.params.messages[0]!.content.matchAll(/<turn id="(T\d+)"/g)].map((m) => m[1]))).toEqual(["T1", "T2", "T3", "T4"]);
  });

  it("does not submit while another extract job is running", async () => {
    source("s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    await submitExtraction(db, fake);
    source("s2", [turn("u2", "user", "Je garde Hono.", "2026-10-01T09:00:00Z")]);
    await expect(submitExtraction(db, fake)).rejects.toThrow(/still running/);
    expect(fake.created).toHaveLength(1);
  });

  it("with nothing new, submits nothing", async () => {
    expect(await submitExtraction(db, fake)).toMatchObject({ jobId: null, requests: 0 });
    expect(fake.created).toHaveLength(0);
  });
});

describe("anthropicApiKey", () => {
  it("reads the key from the brain's env file, never the shell", () => {
    const home = tmpDir("brain-xdg-");
    mkdirSync(join(home, "glia"));
    writeFileSync(join(home, "glia", "env"), "ANTHROPIC_API_KEY=sk-test-123\n");
    expect(anthropicApiKey({ XDG_CONFIG_HOME: home, ANTHROPIC_API_KEY: "from-shell" })).toBe("sk-test-123");
    expect(() => anthropicApiKey({ XDG_CONFIG_HOME: tmpDir() })).toThrow(/glia\/env/);
  });
});
