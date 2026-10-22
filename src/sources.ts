// Turns a stored raw file into a `sources` row and its `turns` (SPEC.md, "Server-side parsing").
// Re-running is idempotent; a newer copy of a growing transcript updates its source in place.

import type Database from "better-sqlite3";
import { type Config, isExcludedProject } from "./config.js";
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

interface ExistingSource {
  id: number;
  raw_sha256: string;
  parser_version: string;
  received_at: string | null;
}

/**
 * Parses `raw` into sources and turns if it is a Claude Code file; null for other files.
 * A source is re-parsed when its newest copy or the parser version changed. An older copy
 * of a source already parsed from a newer one is left alone.
 */
export function indexClaudeCodeFile(db: Database.Database, store: EvidenceStore, raw: RawFile, config: Config): IndexResult | null {
  const file = classifyClaudeCodePath(raw.origin_path);
  if (!file) return null;
  const result = (status: IndexStatus): IndexResult => ({ status, kind: file.kind, turnsWritten: 0, turnsRemoved: 0 });
  if (isExcludedProject(file.projectDir, config)) return result("excluded");

  const kind = file.kind === "memory" ? "mem" : "cc";
  const externalId =
    file.kind === "memory" ? `${file.projectDir}/memory/${file.name}` : file.kind === "subagent" ? `${file.sessionId}/agent-${file.agentId}` : file.sessionId;

  const existing = db
    .prepare(
      `SELECT s.id, s.raw_sha256, s.parser_version, r.received_at
         FROM sources s LEFT JOIN raw_files r ON r.sha256 = s.raw_sha256
        WHERE s.kind = ? AND s.external_id = ?`,
    )
    .get(kind, externalId) as ExistingSource | undefined;
  if (existing?.raw_sha256 === raw.sha256 && existing.parser_version === CC_PARSER_VERSION) return result("unchanged");
  if (existing && existing.raw_sha256 !== raw.sha256 && existing.received_at && existing.received_at > raw.received_at) return result("older");

  const text = store.read(raw.sha256);
  const parsed = file.kind === "memory" ? parseMemory(text, file.name) : parseSession(text);

  return db.transaction((): IndexResult => {
    const source = {
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
    };
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

    // Only rows whose content changed are written, so unchanged turns keep their FTS rows and vectors.
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
    for (const t of parsed.turns) {
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
    // The newest copy of a transcript holds every line of the older ones, so a turn it
    // lacks was dropped by a parser change: remove it.
    const keep = JSON.stringify(parsed.turns.map((t) => t.externalUuid));
    const { changes: turnsRemoved } = db
      .prepare("DELETE FROM turns WHERE source_id = ? AND external_uuid NOT IN (SELECT value FROM json_each(?))")
      .run(sourceId, keep);
    return { status: existing ? "updated" : "new", kind: file.kind, turnsWritten, turnsRemoved, stats: parsed.stats };
  })();
}
