// Turns a stored raw file into a `sources` row and its `turns` (SPEC.md, "Server-side parsing").
// Re-running is idempotent; a newer copy of a growing transcript updates its source in place.

import type Database from "better-sqlite3";
import { type Config, isExcludedPath } from "./config.js";
import type { EvidenceStore, RawFile } from "./evidence.js";
import { CC_PARSER_VERSION, classifyClaudeCodePath, type ParseStats, parseMemory, parseSession } from "./parsers/claudeCode.js";

export type IndexStatus = "new" | "updated" | "unchanged" | "older" | "excluded";

export interface IndexResult {
  status: IndexStatus;
  kind: "session" | "subagent" | "memory";
  /** Turns inserted or changed; 0 unless the file was parsed. */
  turnsWritten: number;
  turnsRemoved: number;
  stats?: ParseStats;
}

export interface ExistingSource {
  id: number;
  raw_sha256: string;
  parser_version: string;
  received_at: string | null;
  updated_at: string | null;
  turns: number;
}

/**
 * Parses `raw` into sources and turns if `path` (as `projectsView` maps it) is a Claude
 * Code file; null for other files. A source is re-parsed when its content or the parser version
 * changed. A copy older than the one already parsed is left alone: for transcripts, which
 * only grow, "older" means fewer turns or an earlier last turn, whatever order the copies
 * arrive in; for memory files, which are edited in place, the copy received last wins.
 */
export function indexClaudeCodeFile(db: Database.Database, store: EvidenceStore, raw: RawFile, config: Config, path: string): IndexResult | null {
  const file = classifyClaudeCodePath(path);
  if (!file) return null;
  const result = (status: IndexStatus): IndexResult => ({ status, kind: file.kind, turnsWritten: 0, turnsRemoved: 0 });
  if (isExcludedPath(path, config)) return result("excluded");

  const kind = file.kind === "memory" ? "mem" : "cc";
  const externalId =
    file.kind === "memory" ? `${file.projectDir}/memory/${file.name}` : file.kind === "subagent" ? `${file.sessionId}/agent-${file.agentId}` : file.sessionId;

  const existing = findSource(db, kind, externalId);
  if (existing?.raw_sha256 === raw.sha256 && existing.parser_version === CC_PARSER_VERSION) return result("unchanged");
  // After a parser change the stored turns are not comparable with a new parse: re-parse.
  const otherCopy = existing && existing.raw_sha256 !== raw.sha256 && existing.parser_version === CC_PARSER_VERSION;
  if (otherCopy && file.kind === "memory" && existing.received_at && existing.received_at > raw.received_at) return result("older");

  const text = store.read(raw.sha256);
  const parsed = file.kind === "memory" ? parseMemory(text, file.name) : parseSession(text);
  if (otherCopy && file.kind !== "memory" && (parsed.turns.length < existing.turns || (parsed.updatedAt ?? "") < (existing.updated_at ?? ""))) {
    return result("older");
  }

  const written = writeSource(
    db,
    {
      kind,
      external_id: externalId,
      title: parsed.title,
      project_hint: parsed.cwd ?? file.projectDir,
      cwd: parsed.cwd,
      created_at: parsed.createdAt,
      updated_at: parsed.updatedAt,
      raw_path: raw.stored_path,
      raw_sha256: raw.sha256,
      parser_version: CC_PARSER_VERSION,
    },
    parsed.turns,
  );
  return { status: existing ? "updated" : "new", kind: file.kind, ...written, stats: parsed.stats };
}

export interface SourceRow {
  kind: "cc" | "cai" | "cap" | "cad" | "caa" | "mem";
  external_id: string;
  title: string | null;
  project_hint: string | null;
  cwd: string | null;
  created_at: string | null;
  updated_at: string | null;
  raw_path: string;
  raw_sha256: string;
  parser_version: string;
}

export interface TurnRow {
  externalUuid: string;
  parentUuid: string | null;
  role: string;
  ts: string | null;
  text: string;
  isSidechain: boolean;
}

/** The stored row for a source, with its turn count and the time its raw copy was received. */
export function findSource(db: Database.Database, kind: SourceRow["kind"], externalId: string): ExistingSource | undefined {
  return db
    .prepare(
      `SELECT s.id, s.raw_sha256, s.parser_version, s.updated_at, r.received_at,
              (SELECT count(*) FROM turns t WHERE t.source_id = s.id) AS turns
         FROM sources s LEFT JOIN raw_files r ON r.sha256 = s.raw_sha256
        WHERE s.kind = ? AND s.external_id = ?`,
    )
    .get(kind, externalId) as ExistingSource | undefined;
}

/**
 * Upserts a source and makes its turns exactly `turns`, in one transaction. Only turns whose
 * content changed are written, so unchanged turns keep their ids, FTS rows and vectors; turns
 * no longer present (a parser change) are removed.
 */
export function writeSource(db: Database.Database, source: SourceRow, turns: TurnRow[]): { turnsWritten: number; turnsRemoved: number } {
  return db.transaction(() => {
    const { id: sourceId } = db
      .prepare(
        `INSERT INTO sources (kind, external_id, title, project_hint, cwd, created_at, updated_at, raw_path, raw_sha256, parser_version)
         VALUES (@kind, @external_id, @title, @project_hint, @cwd, @created_at, @updated_at, @raw_path, @raw_sha256, @parser_version)
         ON CONFLICT (kind, external_id) DO UPDATE SET
           title = excluded.title, project_hint = excluded.project_hint, cwd = excluded.cwd,
           created_at = excluded.created_at, updated_at = excluded.updated_at, raw_path = excluded.raw_path,
           raw_sha256 = excluded.raw_sha256, parser_version = excluded.parser_version
         RETURNING id`,
      )
      .get(source) as { id: number };
    const upsert = db.prepare(
      `INSERT INTO turns (source_id, external_uuid, parent_uuid, role, ts, text, is_sidechain)
       VALUES (@source_id, @external_uuid, @parent_uuid, @role, @ts, @text, @is_sidechain)
       ON CONFLICT (source_id, external_uuid) DO UPDATE SET
         parent_uuid = excluded.parent_uuid, role = excluded.role, ts = excluded.ts,
         text = excluded.text, is_sidechain = excluded.is_sidechain
       WHERE turns.parent_uuid IS NOT excluded.parent_uuid OR turns.role IS NOT excluded.role
          OR turns.ts IS NOT excluded.ts OR turns.text IS NOT excluded.text OR turns.is_sidechain IS NOT excluded.is_sidechain`,
    );
    let turnsWritten = 0;
    for (const t of turns) {
      turnsWritten += upsert.run({
        source_id: sourceId,
        external_uuid: t.externalUuid,
        parent_uuid: t.parentUuid,
        role: t.role,
        ts: t.ts,
        text: t.text,
        is_sidechain: t.isSidechain ? 1 : 0,
      }).changes;
    }
    const keep = JSON.stringify(turns.map((t) => t.externalUuid));
    const { changes: turnsRemoved } = db
      .prepare("DELETE FROM turns WHERE source_id = ? AND external_uuid NOT IN (SELECT value FROM json_each(?))")
      .run(sourceId, keep);
    return { turnsWritten, turnsRemoved };
  })();
}
