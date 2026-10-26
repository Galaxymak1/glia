// Serving claims (#41, SPEC.md "MCP tools" and "Retrieval"): `recall` is hybrid search over claim
// statements, `brief` a compact briefing. Both wrap what they return in <brain-claims>, which
// ingestion flags as injected, and log every claim served in `retrievals`, so recalled text that
// comes back in a transcript is never extracted again.

import type Database from "better-sqlite3";
import type { Embedder } from "./embed.js";
import { ftsQuery, RRF_K } from "./search.js";

export const CLAIMS_TAG = "brain-claims";
/** Measured by #32 on these sources with Haiku's tokenizer; BGE-M3's is close (2.75). */
export const BRIEF_CHARS_PER_TOKEN = 2.25;
export const RECALL_LIMIT = 8;
export const MAX_RECALL_LIMIT = 20;
const CANDIDATES = 50;
const VECTOR_K = 200;

export interface ClaimHit {
  id: string;
  statement: string;
  kind: string;
  scope: string;
  origin: string;
  status: string;
  valid_from: string | null;
  valid_from_precision: string;
  valid_to: string | null;
  /** When the claim became true, else the day it was recorded. */
  as_of: string;
  evidence: { source: string; turn_id: number | null }[];
}

export interface RecallOptions {
  query: string;
  scope?: string;
  /** Only claims valid at this date (ISO, any precision); superseded ones included. */
  as_of?: string;
  include_superseded?: boolean;
  limit?: number;
}

/** Status, scope and validity filters shared by both legs; claims `c` are in scope. */
function filterSql(opts: RecallOptions): { sql: string; params: string[] } {
  const params: string[] = [];
  let sql = opts.as_of || opts.include_superseded ? "c.status IN ('active', 'superseded')" : "c.status = 'active'";
  if (opts.as_of) {
    sql += " AND (c.valid_from IS NULL OR c.valid_from <= ?) AND (c.valid_to IS NULL OR c.valid_to > ?)";
    params.push(opts.as_of, opts.as_of);
  }
  if (opts.scope) {
    sql += " AND (c.scope = ? OR c.scope = 'global')";
    params.push(opts.scope);
  }
  return { sql, params };
}

interface ClaimRowLite {
  n: number;
  id: string;
  statement: string;
  kind: string;
  scope: string;
  origin: string;
  status: string;
  valid_from: string | null;
  valid_from_precision: string;
  valid_to: string | null;
  recorded_at: string;
  evidence: string;
}

function toHit(db: Database.Database, r: ClaimRowLite): ClaimHit {
  const turnOf = db.prepare("SELECT t.id FROM turns t JOIN sources s ON s.id = t.source_id WHERE s.kind = ? AND s.external_id = ? AND t.external_uuid = ?");
  const evidence = (JSON.parse(r.evidence) as { source: string; turn: string }[]).map((e) => {
    const [kind, ...rest] = e.source.split(":");
    const t = turnOf.get(kind, rest.join(":"), e.turn) as { id: number } | undefined;
    return { source: e.source, turn_id: t?.id ?? null };
  });
  const { n: _, recorded_at, evidence: __, ...rest } = r;
  return { ...rest, as_of: r.valid_from ?? recorded_at.slice(0, 10), evidence };
}

export async function recall(db: Database.Database, embedder: Embedder | null, opts: RecallOptions): Promise<{ hits: ClaimHit[]; meaningError?: string }> {
  const limit = Math.min(Math.max(1, opts.limit ?? RECALL_LIMIT), MAX_RECALL_LIMIT);
  const filter = filterSql(opts);
  const match = ftsQuery(opts.query);
  const keyword = match
    ? (
        db
          .prepare(`SELECT c.n FROM claims_fts f JOIN claims c ON c.n = f.rowid WHERE claims_fts MATCH ? AND ${filter.sql} ORDER BY bm25(claims_fts), c.n LIMIT ?`)
          .all(match, ...filter.params, CANDIDATES) as { n: number }[]
      ).map((r) => r.n)
    : [];
  let meaning: number[] = [];
  let meaningError: string | undefined;
  if (embedder && opts.query.trim()) {
    try {
      const [v] = await embedder.embed([opts.query.trim()]);
      meaning = (
        db
          .prepare(
            `SELECT c.n FROM (SELECT claim_n, distance FROM claims_vec WHERE embedding MATCH ? AND k = ? AND model = ?) v
             JOIN claims c ON c.n = v.claim_n WHERE ${filter.sql} ORDER BY v.distance, c.n LIMIT ?`,
          )
          .all(v!, VECTOR_K, embedder.model, ...filter.params, CANDIDATES) as { n: number }[]
      ).map((r) => r.n);
    } catch (err) {
      meaningError = err instanceof Error ? err.message : String(err);
    }
  }
  const scores = new Map<number, { score: number; keywordRank: number }>();
  const add = (ns: number[], isKeyword: boolean) =>
    ns.forEach((n, i) => {
      const s = scores.get(n) ?? { score: 0, keywordRank: Infinity };
      s.score += 1 / (RRF_K + i + 1);
      if (isKeyword) s.keywordRank = i + 1;
      scores.set(n, s);
    });
  add(keyword, true);
  add(meaning, false);
  const ranked = [...scores].sort(([a, x], [b, y]) => y.score - x.score || x.keywordRank - y.keywordRank || a - b).slice(0, limit);
  const row = db.prepare("SELECT n, id, statement, kind, scope, origin, status, valid_from, valid_from_precision, valid_to, recorded_at, evidence FROM claims WHERE n = ?");
  const hits = ranked.map(([n]) => toHit(db, row.get(n) as ClaimRowLite));
  return { hits, ...(meaningError ? { meaningError } : {}) };
}

const asOf = (r: { valid_from: string | null; recorded_at: string }) => r.valid_from ?? r.recorded_at.slice(0, 10);

/**
 * A briefing of active claims within `budget_tokens`: the user's profile and preferences, open
 * decisions, then the scope's project facts, newest first. Decisions come before facts so a
 * project with many facts never crowds them out.
 */
export function brief(db: Database.Database, opts: { scope?: string; budget_tokens?: number }): { text: string; claimIds: string[] } {
  const budget = Math.floor(Math.min(Math.max(opts.budget_tokens ?? 1500, 200), 4000) * BRIEF_CHARS_PER_TOKEN);
  const pick = (where: string, ...params: string[]) =>
    db.prepare(`SELECT id, statement, origin, valid_from, recorded_at FROM claims WHERE status = 'active' AND ${where} ORDER BY recorded_at DESC, id`).all(...params) as {
      id: string;
      statement: string;
      origin: string;
      valid_from: string | null;
      recorded_at: string;
    }[];
  const sections: [string, ReturnType<typeof pick>][] = [
    ["Profile", pick("scope = 'global' AND kind IN ('profile', 'preference')")],
    ["Open decisions", opts.scope ? pick("kind = 'decision' AND (scope = ? OR scope = 'global')", opts.scope) : pick("kind = 'decision' AND scope = 'global'")],
  ];
  if (opts.scope) sections.push([`Project ${opts.scope}`, pick("scope = ? AND kind IN ('project_fact', 'procedure', 'lesson')", opts.scope)]);
  const lines: string[] = [];
  const claimIds: string[] = [];
  let used = 0;
  const fits = (line: string) => used + line.length + 1 <= budget;
  done: for (const [title, rows] of sections) {
    if (!rows.length) continue;
    if (!fits(title)) break;
    lines.push(title);
    used += title.length + 1;
    for (const r of rows) {
      const line = `- ${r.statement.replace(/\s+/g, " ").trim()} (as of ${asOf(r)}, ${r.origin})`;
      if (!fits(line)) break done;
      lines.push(line);
      used += line.length + 1;
      claimIds.push(r.id);
    }
  }
  return { text: `<${CLAIMS_TAG}>\n${lines.length ? lines.join("\n") : "No claims yet."}\n</${CLAIMS_TAG}>`, claimIds };
}

export function logRetrievals(db: Database.Database, ids: string[], client: string, now = new Date()): void {
  const put = db.prepare("INSERT INTO retrievals (claim_id, client, session_ref, ts) VALUES (?, ?, NULL, ?)");
  db.transaction(() => {
    for (const id of ids) put.run(id, client, now.toISOString());
  })();
}
