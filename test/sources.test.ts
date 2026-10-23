import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { isExcludedPath, isExcludedProject } from "../src/config.js";
import { openDb } from "../src/db.js";
import { EvidenceStore } from "../src/evidence.js";
import { migrate } from "../src/migrations.js";
import { indexClaudeCodeFile, writeSource } from "../src/sources.js";

const S = "4e72e044-0bd2-40ea-afbf-fa36accc5e46";
const PROJECTS = "/home/me/.claude/projects";
const sessionPath = (project = "-home-me-dev-brain") => `${PROJECTS}/${project}/${S}.jsonl`;
const turnLine = (uuid: string, parent: string | null, text: string, role = "user") =>
  JSON.stringify({ type: role, uuid, parentUuid: parent, sessionId: S, cwd: "/home/me/dev/brain", timestamp: `2026-10-20T10:00:0${uuid.slice(-1)}Z`, message: { role, content: text } });
const v1 = [turnLine("u1", null, "first"), turnLine("a2", "u1", "reply", "assistant"), ""].join("\n");
const v2 = v1 + [turnLine("u3", "a2", "follow-up"), ""].join("\n");
const NO_EXCLUDES: Config = { claudeCode: { exclude: [] } };

let dir: string;
let db: ReturnType<typeof openDb>;
let store: EvidenceStore;
const put = (path: string, text: string, at: string) => store.put(path, Buffer.from(text), new Date(at)).file;
const ix = (raw: ReturnType<typeof put>, config: Config) => indexClaudeCodeFile(db, store, raw, config, raw.origin_path);
const turns = () => db.prepare("SELECT id, external_uuid, parent_uuid, role, text FROM turns ORDER BY id").all() as { id: number; external_uuid: string; parent_uuid: string | null; role: string; text: string }[];
const sources = () => db.prepare("SELECT kind, external_id, title, cwd, raw_sha256, parser_version, created_at, updated_at FROM sources").all();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-sources-"));
  db = openDb(join(dir, "brain.db"));
  migrate(db);
  store = new EvidenceStore(db, join(dir, "raw"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("indexClaudeCodeFile", () => {
  it("creates a source and its turns, then does nothing on a second run", () => {
    const raw = put(sessionPath(), v1, "2026-10-20T10:00:00Z");
    expect(ix(raw, NO_EXCLUDES)).toMatchObject({ status: "new", kind: "session", turnsWritten: 2, turnsRemoved: 0 });
    expect(sources()).toEqual([
      { kind: "cc", external_id: S, title: null, cwd: "/home/me/dev/brain", raw_sha256: raw.sha256, parser_version: "cc@1", created_at: "2026-10-20T10:00:01Z", updated_at: "2026-10-20T10:00:02Z" },
    ]);
    expect(turns().map((t) => [t.external_uuid, t.parent_uuid, t.role])).toEqual([["u1", null, "user"], ["a2", "u1", "assistant"]]);
    expect(ix(raw, NO_EXCLUDES)).toMatchObject({ status: "unchanged", turnsWritten: 0 });
  });

  it("updates a growing transcript in place, writing only the new turns", () => {
    ix(put(sessionPath(), v1, "2026-10-20T10:00:00Z"), NO_EXCLUDES);
    const before = turns();
    const newer = put(sessionPath(), v2, "2026-10-20T10:15:00Z");
    expect(ix(newer, NO_EXCLUDES)).toMatchObject({ status: "updated", turnsWritten: 1, turnsRemoved: 0 });
    const after = turns();
    expect(after.slice(0, 2)).toEqual(before); // same ids: FTS rows and vectors stay valid
    expect(after.map((t) => t.external_uuid)).toEqual(["u1", "a2", "u3"]);
    expect((sources()[0] as { raw_sha256: string }).raw_sha256).toBe(newer.sha256);
  });

  it("leaves an older copy alone once a newer one was parsed", () => {
    const older = put(sessionPath(), v1, "2026-10-20T10:00:00Z");
    ix(put(sessionPath(), v2, "2026-10-20T10:15:00Z"), NO_EXCLUDES);
    expect(ix(older, NO_EXCLUDES)).toMatchObject({ status: "older" });
    expect(turns()).toHaveLength(3);
  });

  it("keeps the newer transcript when an older copy arrives later (from a backup)", () => {
    ix(put(sessionPath(), v2, "2026-10-20T10:00:00Z"), NO_EXCLUDES);
    const ids = turns().map((t) => t.id);
    const backup = put(sessionPath(), v1, "2026-10-20T11:00:00Z");
    expect(ix(backup, NO_EXCLUDES)).toMatchObject({ status: "older", turnsRemoved: 0 });
    expect(turns().map((t) => t.id)).toEqual(ids);
  });

  it("takes the copy received last for memory files, which are edited in place", () => {
    const memPath = `${PROJECTS}/-home-me-dev-brain/memory/notes.md`;
    const first = put(memPath, "first version\n", "2026-10-20T10:00:00Z");
    ix(first, NO_EXCLUDES);
    expect(ix(put(memPath, "edited\n", "2026-10-20T11:00:00Z"), NO_EXCLUDES)).toMatchObject({ status: "updated" });
    expect(ix(first, NO_EXCLUDES)).toMatchObject({ status: "older" });
    expect(turns().map((t) => t.text)).toEqual(["edited\n"]);
  });

  it("re-parses after a parser version change and drops turns the parser no longer yields", () => {
    const raw = put(sessionPath(), v1, "2026-10-20T10:00:00Z");
    ix(raw, NO_EXCLUDES);
    db.prepare("UPDATE sources SET parser_version = 'cc@0'").run();
    db.prepare("INSERT INTO turns (source_id, external_uuid, role, text) VALUES (1, 'stale', 'user', 'from cc@0')").run();
    expect(ix(raw, NO_EXCLUDES)).toMatchObject({ status: "updated", turnsWritten: 0, turnsRemoved: 1 });
    expect(turns().map((t) => t.external_uuid)).toEqual(["u1", "a2"]);
  });

  it("re-parses a grown copy after a parser change even if the new parser yields fewer turns", () => {
    ix(put(sessionPath(), v1, "2026-10-20T10:00:00Z"), NO_EXCLUDES);
    db.prepare("UPDATE sources SET parser_version = 'cc@0'").run();
    for (const extra of ["x1", "x2", "x3"]) db.prepare("INSERT INTO turns (source_id, external_uuid, role, text) VALUES (1, ?, 'user', 'cc@0 only')").run(extra);
    expect(ix(put(sessionPath(), v2, "2026-10-20T10:15:00Z"), NO_EXCLUDES)).toMatchObject({ status: "updated", turnsRemoved: 3 });
    expect(db.prepare("SELECT parser_version FROM sources").get()).toEqual({ parser_version: "cc@1" });
    expect(turns().map((t) => t.external_uuid)).toEqual(["u1", "a2", "u3"]);
  });

  it("indexes subagent transcripts and memory files under their own ids", () => {
    const sub = put(`${PROJECTS}/-home-me-dev-brain/${S}/subagents/agent-abc123.jsonl`, v1, "2026-10-20T10:00:00Z");
    const mem = put(`${PROJECTS}/-home-me-dev-brain/memory/prefers_sqlite.md`, "---\nname: prefers-sqlite\n---\nSQLite.\n", "2026-10-20T10:00:00Z");
    expect(ix(sub, NO_EXCLUDES)).toMatchObject({ status: "new", kind: "subagent" });
    expect(ix(mem, NO_EXCLUDES)).toMatchObject({ status: "new", kind: "memory", turnsWritten: 1 });
    expect(sources().map((s) => [(s as { kind: string }).kind, (s as { external_id: string }).external_id, (s as { title: string }).title])).toEqual([
      ["cc", `${S}/agent-abc123`, null],
      ["mem", "-home-me-dev-brain/memory/prefers_sqlite.md", "prefers-sqlite"],
    ]);
  });

  it("skips excluded projects and files that are not Claude Code transcripts", () => {
    const config: Config = { claudeCode: { exclude: ["-home-me-work-*"] } };
    expect(ix(put(sessionPath("-home-me-work-acme"), v1, "2026-10-20T10:00:00Z"), config)).toMatchObject({ status: "excluded" });
    expect(ix(put("/home/me/notes.md", "notes\n", "2026-10-20T10:00:00Z"), config)).toBeNull();
    expect([sources(), turns()]).toEqual([[], []]);
  });
});

describe("writeSource", () => {
  it("scrubs titles and turn text once more before writing", () => {
    const P = "hunter2" + "hunter2";
    writeSource(
      db,
      { kind: "caa", external_id: "a1", title: `DB_PASSWORD=${P}`, project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: "s", parser_version: "cai@1" },
      [{ externalUuid: "t1", parentUuid: null, role: "doc", ts: null, text: `line\nDB_PASSWORD=${P}`, isSidechain: false }],
    );
    expect(db.prepare("SELECT title FROM sources").get()).toEqual({ title: "DB_PASSWORD=[REDACTED:env_secret]" });
    expect(turns().map((t) => t.text)).toEqual(["line\nDB_PASSWORD=[REDACTED:env_secret]"]);
  });
});

describe("isExcludedPath", () => {
  it("excludes a path when any of its folders matches, wherever it sits", () => {
    const config: Config = { claudeCode: { exclude: ["-home-me-work-*"] } };
    const S2 = "4e72e044-0bd2-40ea-afbf-fa36accc5e46";
    for (const p of [
      `/projects/-home-me-work-acme/${S2}.jsonl`,
      `/projects/-home-me-work-acme/${S2}/tool-results/projects/foo/x.txt`,
      `/projects/sub/projects/-home-me-work-acme/a.jsonl`,
      `/backup/mixed/-home-me-work-acme/memory/x.md`,
    ]) expect(isExcludedPath(p, config)).toBe(true);
    expect(isExcludedPath(`/projects/-home-me-dev/${S2}.jsonl`, config)).toBe(false);
    expect(isExcludedPath("/projects/-home-me-dev/memory/-home-me-work-notes.md", config)).toBe(false); // a file name is not a folder
  });
});

describe("isExcludedProject", () => {
  it("matches whole folder names, with * as wildcard and other characters literal", () => {
    const config: Config = { claudeCode: { exclude: ["-home-me-work-*", "-home-me-Downloads", "a.b"] } };
    expect(["-home-me-work-acme", "-home-me-Downloads", "a.b"].map((p) => isExcludedProject(p, config))).toEqual([true, true, true]);
    expect(["-home-me-dev-brain", "-home-me-Downloads-x", "axb"].map((p) => isExcludedProject(p, config))).toEqual([false, false, false]);
  });
});

describe("openDb", () => {
  it("keeps the database file owner-only", () => {
    expect(statSync(join(dir, "brain.db")).mode & 0o777).toBe(0o600);
  });
});
