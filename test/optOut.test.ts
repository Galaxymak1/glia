import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { hasOptOutMarker, sessionOf } from "../src/optOut.js";

const line = (o: object) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => line({ type: "user", uuid: "u", parentUuid: null, message: { role: "user", content }, ...extra });

describe("hasOptOutMarker", () => {
  it("counts the marker on a line of its own in a message the user typed", () => {
    expect(hasOptOutMarker(user("#nobrain"))).toBe(true);
    expect(hasOptOutMarker(user("private stuff below\n  #NoBrain  \nthanks"))).toBe(true);
    expect(hasOptOutMarker(user([{ type: "text", text: "#nobrain" }]))).toBe(true);
  });

  it("counts a prompt queued while Claude was busy, typed by the user", () => {
    const queued = (prompt: string, kind = "human") => line({ type: "attachment", uuid: "q", attachment: { type: "queued_command", prompt, origin: { kind } } });
    expect(hasOptOutMarker(queued("#nobrain"))).toBe(true);
    expect(hasOptOutMarker(queued("#nobrain is the marker"))).toBe(false);
    expect(hasOptOutMarker(queued("#nobrain", "agent"))).toBe(false);
  });

  it("does not count talk about the marker, or the marker inside a word", () => {
    expect(hasOptOutMarker(user("#nobrain is fine and i downloaded the zips"))).toBe(false);
    expect(hasOptOutMarker(user("use `#nobrain` to opt out"))).toBe(false);
    expect(hasOptOutMarker(user("#nobrainer"))).toBe(false);
  });

  it("does not count tool output, Claude's text, injected context, summaries or subagent prompts", () => {
    expect(hasOptOutMarker(user([{ type: "tool_result", tool_use_id: "t", content: "#nobrain" }]))).toBe(false);
    expect(hasOptOutMarker(line({ type: "assistant", uuid: "a", message: { role: "assistant", content: [{ type: "text", text: "#nobrain" }] } }))).toBe(false);
    expect(hasOptOutMarker(user("hi\n<system-reminder>\n#nobrain\n</system-reminder>"))).toBe(false);
    expect(hasOptOutMarker(user("#nobrain", { isMeta: true }))).toBe(false);
    expect(hasOptOutMarker(user("#nobrain", { isCompactSummary: true }))).toBe(false);
    expect(hasOptOutMarker(user("#nobrain", { isSidechain: true }))).toBe(false);
    expect(hasOptOutMarker(line({ type: "attachment", attachment: { type: "hook_additional_context", content: ["#nobrain"] } }))).toBe(false);
    expect(hasOptOutMarker("{not json #nobrain")).toBe(false);
  });
});

describe("sessionOf", () => {
  const S = "4e72e044-0bd2-40ea-afbf-fa36accc5e46";
  it("maps the transcript and everything in its folder to the session", () => {
    expect(sessionOf(`/projects/-p/${S}.jsonl`)).toEqual({ sessionId: S, isTranscript: true });
    expect(sessionOf(`/projects/-p/${S}/subagents/agent-a1.jsonl`)).toEqual({ sessionId: S, isTranscript: false });
    expect(sessionOf(`/projects/-p/${S}/tool-results/out.txt`)).toEqual({ sessionId: S, isTranscript: false });
    expect(sessionOf(`/projects/-p/memory/MEMORY.md`)).toBeNull();
    expect(sessionOf(`/backup/${S}/subagents/agent-a1.jsonl`)).toEqual({ sessionId: S, isTranscript: false });
  });
});

describe("brain ingest with #nobrain", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-optout-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, BRAIN_CONFIG: join(dir, "no-config.json") };
  const ingest = (db: string, path: string) => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ingest", "--db", db, path], { encoding: "utf8", env });
  const S = "11111111-2222-3333-4444-555555555555";
  const OTHER = "66666666-7777-8888-9999-000000000000";
  const turn = (uuid: string, parent: string | null, text: string) =>
    line({ type: "user", uuid, parentUuid: parent, sessionId: S, timestamp: `2026-10-24T10:00:0${uuid.length}Z`, message: { role: "user", content: text } }) + "\n";

  it("purges what was stored before the marker, then stores nothing more of the session", () => {
    const project = join(dir, "projects", "-home-me-dev");
    mkdirSync(join(project, S, "subagents"), { recursive: true });
    mkdirSync(join(project, S, "tool-results"), { recursive: true });
    writeFileSync(join(project, `${S}.jsonl`), turn("u1", null, "first question about the secret plan"));
    writeFileSync(join(project, S, "subagents", "agent-a1.jsonl"), line({ type: "user", uuid: "s1", parentUuid: null, isSidechain: true, sessionId: S, message: { role: "user", content: "subagent task" } }) + "\n");
    writeFileSync(join(project, S, "tool-results", "out.txt"), "tool output\n");
    writeFileSync(join(project, `${OTHER}.jsonl`), turn("o1", null, "another session").replaceAll(S, OTHER));
    const db = join(dir, "db", "brain.db");

    expect(ingest(db, join(dir, "projects"))).toMatch(/^Stored 4 new files/);
    const open = () => new Database(db, { readonly: true });
    let d = open();
    expect(d.prepare("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 3 });
    d.close();

    // The session grows, and the user types the marker.
    appendFileSync(join(project, `${S}.jsonl`), turn("u22", "u1", "#nobrain"));
    const out = ingest(db, join(dir, "projects"));
    expect(out).toContain("1 sessions opted out (#nobrain): 3 files not stored; purged 2 sources and 3 raw files stored earlier");
    d = open();
    expect(d.prepare("SELECT external_id FROM sources").all()).toEqual([{ external_id: OTHER }]);
    expect(d.prepare("SELECT count(*) AS n FROM turns WHERE text LIKE '%secret plan%' OR text LIKE '%subagent task%'").get()).toEqual({ n: 0 });
    expect(d.prepare("SELECT count(*) AS n FROM turns_fts WHERE turns_fts MATCH 'secret'").get()).toEqual({ n: 0 });
    expect(d.prepare("SELECT count(*) AS n FROM raw_files").get()).toEqual({ n: 1 });
    expect(d.prepare("SELECT session_id, sources_purged, raw_files_purged FROM opt_outs").all()).toEqual([{ session_id: S, sources_purged: 2, raw_files_purged: 3 }]);
    d.close();
    const gz = readdirSync(join(dir, "db", "raw"), { recursive: true }).filter((f) => String(f).endsWith(".gz"));
    expect(gz).toHaveLength(1);

    // Later runs store nothing of it, even once it grows again; nothing more to purge.
    appendFileSync(join(project, `${S}.jsonl`), turn("u333", "u22", "more"));
    expect(ingest(db, join(dir, "projects"))).toMatch(/1 sessions opted out \(#nobrain\): 3 files not stored\n/);
    d = open();
    expect(d.prepare("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 1 });
    d.close();

    // A copy of the session folder put outside projects/, with its transcript next to it.
    const backup = join(dir, "backup");
    mkdirSync(join(backup, S, "subagents"), { recursive: true });
    cpSync(join(project, `${S}.jsonl`), join(backup, `${S}.jsonl`));
    cpSync(join(project, S, "subagents", "agent-a1.jsonl"), join(backup, S, "subagents", "agent-a1.jsonl"));
    expect(ingest(db, join(backup, S))).toMatch(/^Stored 0 new files[^]*1 sessions opted out \(#nobrain\): 1 files not stored\n/);
  });
});
