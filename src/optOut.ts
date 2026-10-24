// Per-session opt-out (#22): a Claude Code session in which the user types `#nobrain` is never
// stored, nor anything in its folder (subagent transcripts, saved tool output), and what was stored
// before the marker was typed is purged.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { splitInjected } from "./enrich.js";

export const OPT_OUT_MARKER = "#nobrain";

const SESSION_FILE = /\/projects\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.jsonl$|\/)/;

/**
 * The session a Claude Code file belongs to, from its place under projects/: the session
 * transcript `<id>.jsonl`, or anything in the `<id>/` folder next to it (subagent transcripts,
 * saved tool output).
 */
export function sessionOf(projectsPath: string): { sessionId: string; isTranscript: boolean } | null {
  const m = SESSION_FILE.exec(projectsPath);
  return m ? { sessionId: m[1]!, isTranscript: m[2] === ".jsonl" } : null;
}

/**
 * The marker counts only on a line of its own, in a message the user typed: not in tool output,
 * Claude's text, injected context, compaction summaries or a subagent's prompt. A line of its own,
 * so that talking about the marker ("#nobrain is fine") does not purge the session it is said in.
 */
const MARKER_LINE = /^[ \t]*#nobrain[ \t]*$/im;
const ANY_MARKER = /#nobrain/i;

/** Whether a session transcript (JSONL, as read from disk) holds the opt-out marker. */
export function hasOptOutMarker(jsonl: string): boolean {
  if (!ANY_MARKER.test(jsonl)) return false;
  for (const line of jsonl.split("\n")) {
    if (!ANY_MARKER.test(line)) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== "object") continue;
    const o = d as { type?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    if (o.type !== "user" || o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true) continue;
    const content = o.message?.content;
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string)
          : [];
    if (texts.some((t) => MARKER_LINE.test(splitInjected(t).own))) return true;
  }
  return false;
}

export interface PurgeResult {
  sources: number;
  rawFiles: number;
}

/**
 * Records the opt-out of `sessionId` and deletes everything stored from it: the session's and its
 * subagents' sources (turns, chunks and vectors go with them), and every raw copy of their files.
 * The `opt_outs` row is the audit trail: it names the session, never its content.
 */
export function optOut(db: Database.Database, rawDir: string, sessionId: string, now = new Date()): PurgeResult {
  const purged = db.transaction(() => {
    const sources = db
      .prepare(`SELECT id, raw_sha256 FROM sources WHERE kind = 'cc' AND (external_id = ? OR external_id LIKE ? ESCAPE '\\')`)
      .all(sessionId, `${sessionId.replace(/[\\%_]/g, "\\$&")}/agent-%`) as { id: number; raw_sha256: string }[];
    // Older copies of a growing transcript are not referenced by any source: found by their origin.
    const copies = db
      .prepare(`SELECT sha256, stored_path FROM raw_files WHERE origin_path LIKE ? OR origin_path LIKE ?`)
      .all(`%/${sessionId}.jsonl`, `%/${sessionId}/%`) as { sha256: string; stored_path: string }[];
    const bySha = new Map(copies.map((c) => [c.sha256, c.stored_path]));
    for (const s of sources) {
      const f = db.prepare("SELECT stored_path FROM raw_files WHERE sha256 = ?").get(s.raw_sha256) as { stored_path: string } | undefined;
      if (f) bySha.set(s.raw_sha256, f.stored_path);
    }
    const deleteSource = db.prepare("DELETE FROM sources WHERE id = ?");
    for (const s of sources) deleteSource.run(s.id);
    // A raw file still backing another source (the same bytes seen elsewhere) is kept.
    const stillUsed = db.prepare("SELECT 1 FROM sources WHERE raw_sha256 = ? LIMIT 1");
    const deleteRaw = db.prepare("DELETE FROM raw_files WHERE sha256 = ?");
    const files: string[] = [];
    for (const [sha, storedPath] of bySha) {
      if (stillUsed.get(sha)) continue;
      deleteRaw.run(sha);
      files.push(storedPath);
    }
    db.prepare(
      `INSERT INTO opt_outs (session_id, opted_out_at, sources_purged, raw_files_purged) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET sources_purged = sources_purged + excluded.sources_purged,
         raw_files_purged = raw_files_purged + excluded.raw_files_purged`,
    ).run(sessionId, now.toISOString(), sources.length, files.length);
    return { sources: sources.length, files };
  })();
  // Files go after the commit: a crash in between leaves an orphan file, never a row without its file.
  for (const f of purged.files) rmSync(join(rawDir, f), { force: true });
  return { sources: purged.sources, rawFiles: purged.files.length };
}

export const isOptedOut = (db: Database.Database, sessionId: string) => !!db.prepare("SELECT 1 FROM opt_outs WHERE session_id = ?").get(sessionId);

/**
 * Decides, per ingest run, whether a Claude Code file belongs to an opted-out session. A file in
 * the session's folder is decided by the session transcript, which the walk may reach after it
 * (`<id>/` sorts before `<id>.jsonl`), so the transcript is read from disk next to the folder.
 */
export class OptOutCheck {
  private readonly decided = new Map<string, boolean>();
  constructor(private readonly db: Database.Database) {}

  /** `path` is the file on disk; `transcript` its content when it is the session transcript itself. */
  isOptedOut(sessionId: string, path: string, transcript?: Buffer): boolean {
    const known = this.decided.get(sessionId);
    if (known !== undefined) return known;
    let result = isOptedOut(this.db, sessionId);
    if (!result) {
      const at = path.lastIndexOf(`/${sessionId}/`);
      const sessionFile = transcript ? null : at >= 0 ? `${path.slice(0, at)}/${sessionId}.jsonl` : null;
      const text = transcript?.toString("utf8") ?? (sessionFile && existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "");
      result = hasOptOutMarker(text);
    }
    this.decided.set(sessionId, result);
    return result;
  }
}
