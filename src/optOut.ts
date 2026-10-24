// Per-session opt-out (#22): a Claude Code session in which the user types `#nobrain` is never
// stored, nor anything in its folder (subagent transcripts, saved tool output), and what was stored
// before the marker was typed is purged.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { splitInjected } from "./enrich.js";

export const OPT_OUT_MARKER = "#nobrain";

const SESSION_FILE = /(?:^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.jsonl$|\/)/;

/**
 * The session a Claude Code file belongs to: the session transcript `<id>.jsonl`, or anything in
 * the `<id>/` folder next to it (subagent transcripts, saved tool output). Read from any path, not
 * only one under projects/, so a copied session folder is recognised wherever it was put.
 */
export function sessionOf(path: string): { sessionId: string; isTranscript: boolean } | null {
  const m = SESSION_FILE.exec(path);
  return m ? { sessionId: m[1]!, isTranscript: m[2] === ".jsonl" } : null;
}

/**
 * The marker counts only on a line of its own, in a message the user typed (sent, or queued while
 * Claude was busy): not in tool output,
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
    const o = d as {
      type?: unknown;
      isMeta?: unknown;
      isCompactSummary?: unknown;
      isSidechain?: unknown;
      message?: { content?: unknown };
      attachment?: { type?: unknown; prompt?: unknown; origin?: { kind?: unknown } };
    };
    // A prompt typed while Claude was busy is recorded as a queued_command attachment first.
    const queued = o.attachment;
    if (o.type === "attachment" && queued?.type === "queued_command" && queued.origin?.kind === "human" && typeof queued.prompt === "string") {
      if (MARKER_LINE.test(splitInjected(queued.prompt).own)) return true;
      continue;
    }
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
 *
 * Files go first, rows after: if a file cannot be deleted this throws before any row changes, and
 * a crash in between leaves rows whose files are gone, which the next ingest purges again (the
 * session is not recorded as opted out until its rows are gone). No copy is ever left unlisted.
 */
export function optOut(db: Database.Database, rawDir: string, sessionId: string, now = new Date()): PurgeResult {
  const sources = db
    .prepare(`SELECT id, raw_sha256 FROM sources WHERE kind = 'cc' AND (external_id = ? OR external_id LIKE ? ESCAPE '\\')`)
    .all(sessionId, `${sessionId.replace(/[\\%_]/g, "\\$&")}/agent-%`) as { id: number; raw_sha256: string }[];
  // Older copies of a growing transcript, and files of the session folder, are found by their origin.
  const copies = db
    .prepare(`SELECT sha256, stored_path FROM raw_files WHERE origin_path LIKE ? OR origin_path LIKE ?`)
    .all(`%/${sessionId}.jsonl`, `%/${sessionId}/%`) as { sha256: string; stored_path: string }[];
  const rawFile = db.prepare("SELECT stored_path FROM raw_files WHERE sha256 = ?");
  const bySha = new Map(copies.map((c) => [c.sha256, c.stored_path]));
  for (const s of sources) {
    const f = rawFile.get(s.raw_sha256) as { stored_path: string } | undefined;
    if (f) bySha.set(s.raw_sha256, f.stored_path);
  }
  // A raw file also backing a source of another session or export (the same bytes seen there) is kept.
  const ours = new Set(sources.map((s) => s.id));
  const users = db.prepare("SELECT id FROM sources WHERE raw_sha256 = ?");
  const doomed = [...bySha].filter(([sha]) => (users.all(sha) as { id: number }[]).every((u) => ours.has(u.id)));

  for (const [, storedPath] of doomed) rmSync(join(rawDir, storedPath), { force: true });
  db.transaction(() => {
    const deleteSource = db.prepare("DELETE FROM sources WHERE id = ?");
    for (const s of sources) deleteSource.run(s.id);
    const deleteRaw = db.prepare("DELETE FROM raw_files WHERE sha256 = ?");
    for (const [sha] of doomed) deleteRaw.run(sha);
    db.prepare(
      `INSERT INTO opt_outs (session_id, opted_out_at, sources_purged, raw_files_purged) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET sources_purged = sources_purged + excluded.sources_purged,
         raw_files_purged = raw_files_purged + excluded.raw_files_purged`,
    ).run(sessionId, now.toISOString(), sources.length, doomed.length);
  })();
  return { sources: sources.length, rawFiles: doomed.length };
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

  /** `path` is the file on disk: the session transcript itself, or a file in the session's folder. */
  isOptedOut(sessionId: string, path: string): boolean {
    const known = this.decided.get(sessionId);
    if (known !== undefined) return known;
    let result = isOptedOut(this.db, sessionId);
    if (!result) {
      const at = path.lastIndexOf(`/${sessionId}/`);
      const transcript = at >= 0 ? `${path.slice(0, at)}/${sessionId}.jsonl` : path;
      result = existsSync(transcript) && hasOptOutMarker(readFileSync(transcript, "utf8"));
    }
    this.decided.set(sessionId, result);
    return result;
  }
}
