// Pruning superseded transcript copies (#20). A Claude Code transcript only grows, and every changed
// copy is stored in full, so a session ingested N times holds N copies. Once a newer copy is the one
// its source was parsed from, an older copy whose lines all open the newer one adds nothing: its
// file is deleted and its row kept, marked pruned. Memory files are edited in place and keep every
// version.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { EvidenceStore } from "./evidence.js";
import { unparseableLine } from "./scrub.js";

export interface PruneReport {
  pruned: number;
  bytesFreed: number;
  /** Older copies kept because their lines do not all open the current copy (rewritten, or scrubbed differently). */
  kept: number;
}

const UNPARSEABLE_PREFIX = unparseableLine("").slice(0, unparseableLine("").indexOf(","));

/**
 * Whether every complete line of `older` (scrubbed JSONL) opens `newer`. A last line cut off
 * mid-write was stored as a marker line, whose full version the newer copy holds: it is left out.
 */
export function isSuperseded(older: string, newer: string): boolean {
  const lines = older.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.at(-1)?.startsWith(UNPARSEABLE_PREFIX)) lines.pop();
  if (!lines.length) return false;
  const prefix = `${lines.join("\n")}\n`;
  return newer.startsWith(prefix) || newer === prefix.slice(0, -1);
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** Prunes, for every Claude Code transcript source, the older copies its current copy supersedes. */
export function pruneSuperseded(db: Database.Database, store: EvidenceStore, now = new Date()): PruneReport {
  const report: PruneReport = { pruned: 0, bytesFreed: 0, kept: 0 };
  const sources = db.prepare("SELECT external_id, raw_sha256 FROM sources WHERE kind = 'cc'").all() as { external_id: string; raw_sha256: string }[];
  const candidates = db.prepare(
    `SELECT DISTINCT f.sha256, f.stored_bytes FROM raw_files f JOIN raw_file_origins o ON o.sha256 = f.sha256
     WHERE o.origin_path LIKE ? ESCAPE '\\' AND f.sha256 <> ? AND f.pruned_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.raw_sha256 = f.sha256)`,
  );
  for (const source of sources) {
    // external_id is `<session>` or `<session>/agent-<id>`, as the file sits under projects/.
    const [sessionId, agent] = source.external_id.split("/");
    const file = agent ? `${sessionId}/subagents/${agent}.jsonl` : `${sessionId}.jsonl`;
    const older = candidates.all(`%/${likeEscape(file)}`, source.raw_sha256) as { sha256: string; stored_bytes: number }[];
    if (!older.length) continue;
    let current: string;
    try {
      current = store.read(source.raw_sha256);
    } catch {
      continue; // the current copy is missing or damaged: keep every older one
    }
    for (const copy of older) {
      let text: string;
      try {
        text = store.read(copy.sha256);
      } catch {
        report.kept++;
        continue;
      }
      if (!isSuperseded(text, current)) {
        report.kept++;
        continue;
      }
      store.prune(copy.sha256, now);
      report.pruned++;
      report.bytesFreed += copy.stored_bytes;
    }
  }
  return report;
}

/**
 * Deletes temp files a killed ingest left under `rawDir` (`<name>.<hex>.tmp`, see writeAtomic).
 * Only those older than `minAgeMs`: a younger one may belong to an ingest running now.
 */
export function removeStaleTmp(rawDir: string, minAgeMs = 3_600_000, now = Date.now()): number {
  let removed = 0;
  let shards: string[];
  try {
    shards = readdirSync(rawDir);
  } catch {
    return 0;
  }
  for (const shard of shards) {
    let names: string[];
    try {
      names = readdirSync(join(rawDir, shard));
    } catch {
      continue; // not a folder
    }
    for (const name of names) {
      if (!name.endsWith(".tmp")) continue;
      const path = join(rawDir, shard, name);
      try {
        if (now - statSync(path).mtimeMs < minAgeMs) continue;
        rmSync(path, { force: true });
        removed++;
      } catch {
        // gone already, or not ours to delete
      }
    }
  }
  return removed;
}
