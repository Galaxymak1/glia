// Hybrid search over turns (#7, SPEC.md "search_evidence"): keyword ranks from FTS5 and
// meaning ranks from the chunk vectors, fused by reciprocal rank fusion.

import type Database from "better-sqlite3";
import { chunkText, embedView } from "./chunk.js";
import type { Embedder } from "./embed.js";

/** The RRF constant: a hit at rank r adds 1 / (K + r). 60 is the value from the original paper. */
export const RRF_K = 60;
/** How many turns each index puts forward before fusion. */
const CANDIDATES = 50;
/** Chunks read from the vector index: several can belong to one turn. */
const VECTOR_CHUNKS = 200;
const SNIPPET_CHARS = 240;

export interface SearchOptions {
  limit?: number;
  /** Include turns the harness injected (reminders, hook context); left out by default. */
  includeInjected?: boolean;
}

export interface SearchHit {
  turnId: number;
  kind: string;
  sourceTitle: string | null;
  role: string;
  ts: string | null;
  lang: string | null;
  isInjected: boolean;
  score: number;
  /** 1-based rank in each index, null when the turn was not among its candidates. */
  keywordRank: number | null;
  meaningRank: number | null;
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Set when the query could not be embedded: the hits are keyword hits only. */
  meaningError?: string;
}

/**
 * The query as an FTS5 expression: every word, quoted, joined by OR, so a natural question
 * still matches and bm25 ranks turns holding its rarer words first.
 */
export function ftsQuery(query: string): string | null {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 32);
  return words.length ? words.map((w) => `"${w}"`).join(" OR ") : null;
}

function keywordRanks(db: Database.Database, match: string, includeInjected: boolean): number[] {
  const rows = db
    .prepare(
      `SELECT t.id FROM turns_fts f
       JOIN turns t ON t.id = f.rowid JOIN sources s ON s.id = t.source_id
       WHERE turns_fts MATCH ? AND s.excluded = 0 AND (? OR t.is_injected = 0)
       ORDER BY bm25(turns_fts), t.id LIMIT ?`,
    )
    .all(match, includeInjected ? 1 : 0, CANDIDATES) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Turns in order of their best chunk, and the best chunk of each. */
function meaningRanks(db: Database.Database, vector: Float32Array, model: string, includeInjected: boolean): { ids: number[]; bestChunk: Map<number, number> } {
  const rows = db
    .prepare(
      `SELECT c.turn_id, c.ord FROM (
         SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? AND model = ?
       ) v
       JOIN chunks c ON c.id = v.chunk_id JOIN turns t ON t.id = c.turn_id JOIN sources s ON s.id = t.source_id
       WHERE s.excluded = 0 AND (? OR t.is_injected = 0)
       ORDER BY v.distance, c.turn_id, c.ord`,
    )
    .all(vector, VECTOR_CHUNKS, model, includeInjected ? 1 : 0) as { turn_id: number; ord: number }[];
  const bestChunk = new Map<number, number>();
  for (const r of rows) {
    if (bestChunk.size >= CANDIDATES) break;
    if (!bestChunk.has(r.turn_id)) bestChunk.set(r.turn_id, r.ord);
  }
  return { ids: [...bestChunk.keys()], bestChunk };
}

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
};

export async function search(db: Database.Database, embedder: Embedder | null, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const limit = opts.limit ?? 10;
  const includeInjected = opts.includeInjected ?? false;
  const match = ftsQuery(query);
  const keyword = match ? keywordRanks(db, match, includeInjected) : [];

  let meaning: number[] = [];
  let bestChunk = new Map<number, number>();
  let meaningError: string | undefined;
  if (embedder && query.trim()) {
    try {
      const [vector] = await embedder.embed([query.trim()]);
      ({ ids: meaning, bestChunk } = meaningRanks(db, vector!, embedder.model, includeInjected));
    } catch (err) {
      meaningError = err instanceof Error ? err.message : String(err);
    }
  }

  const scores = new Map<number, { score: number; keywordRank: number | null; meaningRank: number | null }>();
  const add = (ids: number[], field: "keywordRank" | "meaningRank") =>
    ids.forEach((id, i) => {
      const s = scores.get(id) ?? { score: 0, keywordRank: null, meaningRank: null };
      s.score += 1 / (RRF_K + i + 1);
      s[field] = i + 1;
      scores.set(id, s);
    });
  add(keyword, "keywordRank");
  add(meaning, "meaningRank");
  // Ties (same score) go to the better keyword rank, then to the older turn: same query, same order.
  const ranked = [...scores.entries()]
    .sort(([a, x], [b, y]) => y.score - x.score || (x.keywordRank ?? Infinity) - (y.keywordRank ?? Infinity) || a - b)
    .slice(0, limit);

  const turn = db.prepare(
    `SELECT t.id, t.role, t.ts, t.lang, t.is_injected, t.text, s.kind, s.title
     FROM turns t JOIN sources s ON s.id = t.source_id WHERE t.id = ?`,
  );
  const snippet = db.prepare(`SELECT snippet(turns_fts, 0, '[', ']', '…', 24) AS s FROM turns_fts WHERE turns_fts MATCH ? AND rowid = ?`);
  const hits = ranked.map(([id, s]): SearchHit => {
    const t = turn.get(id) as { role: string; ts: string | null; lang: string | null; is_injected: number; text: string; kind: string; title: string | null };
    // The passage that matched: the keyword snippet, else the turn's best chunk.
    const text =
      s.keywordRank !== null && match
        ? (snippet.get(match, id) as { s: string }).s
        : (chunkText(embedView(t.text))[bestChunk.get(id) ?? 0] ?? t.text);
    return {
      turnId: id,
      kind: t.kind,
      sourceTitle: t.title,
      role: t.role,
      ts: t.ts,
      lang: t.lang,
      isInjected: t.is_injected === 1,
      score: s.score,
      keywordRank: s.keywordRank,
      meaningRank: s.meaningRank,
      snippet: oneLine(text),
    };
  });
  return { hits, ...(meaningError ? { meaningError } : {}) };
}
