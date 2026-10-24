// Builds and refreshes the meaning index (#7): every turn's chunks, embedded, in chunks and
// chunks_vec. Incremental: a chunk is embedded again only when the exact text it embeds or the
// model changed, so a second run with nothing new embeds nothing.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { contextHeader, turnChunks } from "./chunk.js";
import type { Embedder } from "./embed.js";
import { EMBEDDING_DIMS } from "./migrations.js";

interface TurnRow {
  id: number;
  source_id: number;
  external_uuid: string;
  parent_uuid: string | null;
  role: string;
  text: string;
  is_injected: number;
  title: string | null;
}

export interface IndexReport {
  /** Turns read, injected and empty ones included. */
  turns: number;
  /** Turns whose chunks were embedded on this run. */
  turnsEmbedded: number;
  chunksEmbedded: number;
  /** Turns already up to date. */
  turnsUnchanged: number;
  /** Turns whose chunks were dropped because they no longer have any (now injected, or empty). */
  turnsCleared: number;
}

export interface IndexOptions {
  /** Delete the whole index first and embed everything again. */
  rebuild?: boolean;
  /** Inputs per embedding request. */
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The exact texts embedded for each turn: its chunks, each behind the context header (the
 * source title and the turn it answers). The turn it answers is the nearest ancestor a person
 * or Claude wrote: tool results and injected turns are passed over.
 */
export function chunkInputs(turns: TurnRow[]): Map<number, string[]> {
  const byUuid = new Map<string, TurnRow>();
  for (const t of turns) byUuid.set(`${t.source_id}\u0000${t.external_uuid}`, t);
  const answered = (t: TurnRow): TurnRow | null => {
    let p = t.parent_uuid ? byUuid.get(`${t.source_id}\u0000${t.parent_uuid}`) : undefined;
    for (let hops = 0; p && hops < 50; hops++) {
      if (p.role !== "tool" && !p.is_injected && p.text.trim()) return p;
      p = p.parent_uuid ? byUuid.get(`${p.source_id}\u0000${p.parent_uuid}`) : undefined;
    }
    return null;
  };
  const inputs = new Map<number, string[]>();
  for (const t of turns) {
    const chunks = turnChunks(t);
    if (!chunks.length) continue;
    const header = contextHeader(t.title, answered(t)?.text ?? null);
    inputs.set(t.id, chunks.map((c) => header + c));
  }
  return inputs;
}

function loadTurns(db: Database.Database): TurnRow[] {
  return db
    .prepare(
      `SELECT t.id, t.source_id, t.external_uuid, t.parent_uuid, t.role, t.text, t.is_injected, s.title
       FROM turns t JOIN sources s ON s.id = t.source_id
       WHERE s.excluded = 0
       ORDER BY t.id`,
    )
    .all() as TurnRow[];
}

/** Embeds what is missing or stale, and drops chunks that no longer have a turn's text behind them. */
export async function buildIndex(db: Database.Database, embedder: Embedder, opts: IndexOptions = {}): Promise<IndexReport> {
  const batchSize = opts.batchSize ?? 16;
  if (opts.rebuild) db.transaction(() => db.exec("DELETE FROM chunks; DELETE FROM chunks_vec;"))();

  const turns = loadTurns(db);
  const wanted = chunkInputs(turns);

  // What is stored: per turn, the hashes of its chunks in order, and whether every one has a
  // vector from this model.
  const models = new Map<number, string | null>();
  for (const r of db.prepare("SELECT chunk_id, model FROM chunks_vec").iterate() as Iterable<{ chunk_id: number; model: string | null }>) {
    models.set(r.chunk_id, r.model);
  }
  const stored = new Map<number, { hashes: string[]; current: boolean }>();
  for (const r of db.prepare("SELECT id, turn_id, ord, input_sha256 FROM chunks ORDER BY turn_id, ord").iterate() as Iterable<{
    id: number;
    turn_id: number;
    ord: number;
    input_sha256: string;
  }>) {
    const s = stored.get(r.turn_id) ?? { hashes: [], current: true };
    s.hashes[r.ord] = r.input_sha256;
    s.current &&= models.get(r.id) === embedder.model;
    stored.set(r.turn_id, s);
  }

  const report: IndexReport = { turns: turns.length, turnsEmbedded: 0, chunksEmbedded: 0, turnsUnchanged: 0, turnsCleared: 0 };
  const todo: { turnId: number; inputs: string[]; hashes: string[] }[] = [];
  const clear = db.prepare("DELETE FROM chunks WHERE turn_id = ?");
  db.transaction(() => {
    for (const [turnId] of stored) {
      if (!wanted.has(turnId)) {
        clear.run(turnId);
        report.turnsCleared++;
      }
    }
  })();
  for (const [turnId, inputs] of wanted) {
    const hashes = inputs.map(sha256);
    const s = stored.get(turnId);
    if (s && s.current && s.hashes.length === hashes.length && hashes.every((h, i) => s.hashes[i] === h)) {
      report.turnsUnchanged++;
      continue;
    }
    todo.push({ turnId, inputs, hashes });
  }

  const total = todo.reduce((n, t) => n + t.inputs.length, 0);
  const exists = db.prepare("SELECT 1 FROM turns WHERE id = ?");
  const insertChunk = db.prepare("INSERT INTO chunks (turn_id, ord, input_sha256) VALUES (?, ?, ?)");
  const insertVec = db.prepare("INSERT INTO chunks_vec (chunk_id, embedding, model, dims) VALUES (?, ?, ?, ?)");
  // One transaction per turn, written once all its chunks are embedded: an interrupted run
  // keeps every turn it finished, and no turn is ever left half embedded.
  const write = db.transaction((turnId: number, hashes: string[], vectors: Float32Array[]) => {
    clear.run(turnId);
    if (!exists.get(turnId)) return; // deleted by an ingest while it was being embedded
    hashes.forEach((h, ord) => {
      const { lastInsertRowid } = insertChunk.run(turnId, ord, h);
      insertVec.run(BigInt(lastInsertRowid), vectors[ord]!, embedder.model, BigInt(EMBEDDING_DIMS));
    });
  });

  let done = 0;
  let batch: typeof todo = [];
  let batchInputs = 0;
  const flush = async () => {
    const inputs = batch.flatMap((t) => t.inputs);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < inputs.length; i += batchSize) {
      vectors.push(...(await embedder.embed(inputs.slice(i, i + batchSize))));
      done += Math.min(batchSize, inputs.length - i);
      opts.onProgress?.(done, total);
    }
    let at = 0;
    for (const t of batch) {
      write(t.turnId, t.hashes, vectors.slice(at, at + t.inputs.length));
      at += t.inputs.length;
      report.turnsEmbedded++;
      report.chunksEmbedded += t.inputs.length;
    }
    batch = [];
    batchInputs = 0;
  };
  for (const t of todo) {
    batch.push(t);
    batchInputs += t.inputs.length;
    if (batchInputs >= batchSize) await flush();
  }
  if (batch.length) await flush();
  return report;
}

export interface IndexStatus {
  /** Turns that should have vectors (not injected, not empty) and have none from this model. */
  missing: number;
  /** Chunks embedded with another model: left out of search until re-embedded. */
  otherModel: number;
}

/** A cheap check run before a search, to say when the meaning index lags behind the turns. */
export function indexStatus(db: Database.Database, model: string): IndexStatus {
  const missing = db
    .prepare(
      `SELECT count(*) AS n FROM turns t JOIN sources s ON s.id = t.source_id
       WHERE s.excluded = 0 AND t.is_injected = 0 AND trim(t.text, ' ' || char(9, 10, 13)) <> ''
         AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.turn_id = t.id)`,
    )
    .get() as { n: number };
  let otherModel = 0;
  for (const r of db.prepare("SELECT model FROM chunks_vec").iterate() as Iterable<{ model: string | null }>) {
    if (r.model !== model) otherModel++;
  }
  return { missing: missing.n, otherModel };
}
