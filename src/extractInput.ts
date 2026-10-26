// Extraction input (#35, SPEC.md "Nightly extraction", steps 1 and 2): which sources to send,
// what of their turns the model sees, and how a source is cut into requests. Injected spans,
// recalled claims and secrets never reach a request; quotes are later checked against this text.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { extractView, type RenderableSource } from "./extractPrompt.js";
import { scrubText } from "./scrub.js";

/** Artifacts (caa) are Claude's own output: nothing in them is the user's to claim. */
export const EXTRACT_KINDS = ["cc", "cai", "cad", "cap", "mem"] as const;
/**
 * About 80k tokens at the 2.25 characters per token measured by #32, plus about 3k tokens of
 * prompt and schema: under Haiku's 100k-token price step with room to spare.
 */
export const MAX_REQUEST_CHARS = 180_000;
/** Room for a turn's `<turn id=… role=… ts=…>` lines. */
const TURN_HEADER_CHARS = 200;

export interface RequestTurn {
  /** T1, T2, … numbered over the whole source, so a ref names the same turn in every request. */
  ref: string;
  turnId: number;
  role: string;
  ts: string | null;
  text: string;
}

export interface ExtractionRequest {
  /** s<sourceId>-c<n>: the Batch API's custom_id. */
  customId: string;
  sourceId: number;
  source: RenderableSource;
  turns: RequestTurn[];
  chars: number;
}

export interface SelectedSource {
  sourceId: number;
  inputSha256: string;
  source: RenderableSource;
  turns: RequestTurn[];
}

/** The statements of every claim served to a client: they come back in transcripts, and are never extracted again. */
export function recalledStatements(db: Database.Database): string[] {
  return (
    db.prepare("SELECT DISTINCT c.statement FROM claims c JOIN retrievals r ON r.claim_id = c.id ORDER BY c.statement").all() as { statement: string }[]
  ).map((r) => r.statement);
}

/** What the model sees of a turn: no injected spans, no recalled statement, scrubbed again. */
export function requestText(text: string, recalled: string[]): string {
  let t = extractView(text);
  // Longest first, so a statement holding a shorter one is removed whole.
  for (const s of [...recalled].sort((a, b) => b.length - a.length)) if (s.trim()) t = t.split(s.trim()).join("");
  return scrubText(t).value.trim();
}

/** Sources whose extraction input changed since they were last submitted, with their turns. */
export function selectForExtraction(db: Database.Database, opts: { from?: string } = {}): SelectedSource[] {
  const recalled = recalledStatements(db);
  const sources = db
    .prepare(
      `SELECT s.id, s.kind, s.title, s.created_at, e.input_sha256 AS last FROM sources s LEFT JOIN extraction_state e ON e.source_id = s.id
       WHERE s.excluded = 0 AND s.kind IN (${EXTRACT_KINDS.map(() => "?").join(", ")}) AND (? IS NULL OR s.updated_at >= ?)
       ORDER BY s.id`,
    )
    .all(...EXTRACT_KINDS, opts.from ?? null, opts.from ?? null) as { id: number; kind: string; title: string | null; created_at: string | null; last: string | null }[];
  const turnsOf = db.prepare(
    `SELECT id, role, ts, text FROM turns WHERE source_id = ? AND is_injected = 0 AND is_sidechain = 0 AND role <> 'tool' ORDER BY ts, id`,
  );
  const picked: SelectedSource[] = [];
  for (const s of sources) {
    const hash = createHash("sha256");
    const turns: RequestTurn[] = [];
    for (const t of turnsOf.all(s.id) as { id: number; role: string; ts: string | null; text: string }[]) {
      const text = requestText(t.text, recalled);
      if (!text) continue;
      turns.push({ ref: `T${turns.length + 1}`, turnId: t.id, role: t.role, ts: t.ts, text });
      hash.update(`${t.id}\0${text}\0`);
    }
    if (!turns.length) continue;
    const inputSha256 = hash.digest("hex");
    if (inputSha256 === s.last) continue;
    picked.push({ sourceId: s.id, inputSha256, source: { kind: s.kind, title: s.title, created_at: s.created_at }, turns });
  }
  return picked;
}

/** Cuts a source into requests of at most `maxChars`, on turn boundaries; a turn too long alone is cut at whitespace. */
export function cutRequests(sourceId: number, source: RenderableSource, turns: RequestTurn[], maxChars = MAX_REQUEST_CHARS): ExtractionRequest[] {
  const requests: ExtractionRequest[] = [];
  let current: RequestTurn[] = [];
  let chars = 0;
  const flush = () => {
    if (!current.length) return;
    requests.push({ customId: `s${sourceId}-c${requests.length + 1}`, sourceId, source, turns: current, chars });
    current = [];
    chars = 0;
  };
  for (const t of turns) {
    const size = t.text.length + TURN_HEADER_CHARS;
    if (size > maxChars) {
      flush();
      for (const piece of pieces(t.text, maxChars - TURN_HEADER_CHARS)) {
        current = [{ ...t, text: piece }];
        chars = piece.length + TURN_HEADER_CHARS;
        flush();
      }
      continue;
    }
    if (chars + size > maxChars) flush();
    current.push(t);
    chars += size;
  }
  flush();
  return requests;
}

/** `text` in pieces of at most `max` characters, each ending at the last whitespace before the limit. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    const nl = rest.lastIndexOf("\n", max);
    cut = Math.max(cut, nl);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export function markSubmitted(db: Database.Database, sourceId: number, inputSha256: string, jobId: number): void {
  db.prepare(
    `INSERT INTO extraction_state (source_id, input_sha256, job_id, submitted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET input_sha256 = excluded.input_sha256, job_id = excluded.job_id, submitted_at = excluded.submitted_at`,
  ).run(sourceId, inputSha256, jobId, new Date().toISOString());
}

/** A failed request's sources (or a whole job's): the next run selects them again. */
export function forgetSubmitted(db: Database.Database, jobId: number, sourceIds?: number[]): void {
  if (!sourceIds) {
    db.prepare("DELETE FROM extraction_state WHERE job_id = ?").run(jobId);
    return;
  }
  const del = db.prepare("DELETE FROM extraction_state WHERE job_id = ? AND source_id = ?");
  for (const id of sourceIds) del.run(jobId, id);
}
