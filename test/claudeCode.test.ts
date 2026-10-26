import { describe, expect, it } from "vitest";
import { classifyClaudeCodePath, looksLikeProjectFolder, parseMemory, parseSession, projectsView } from "../src/parsers/claudeCode.js";

const S = "4e72e044-0bd2-40ea-afbf-fa36accc5e46";
const base = { sessionId: S, cwd: "/home/me/dev/brain", gitBranch: "master", version: "2.1.303", entrypoint: "cli", isSidechain: false };
const line = (o: object) => JSON.stringify({ ...base, ...o });

// One session with every shape found in real transcripts (docs/notes/claude-code-transcripts.md).
const SESSION = [
  line({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: "Pick SQLite or Postgres?" } }),
  line({ type: "attachment", uuid: "at1", parentUuid: "u1", attachment: { type: "hook_additional_context" } }),
  line({
    type: "assistant", uuid: "a1", parentUuid: "at1", timestamp: "2026-10-20T10:00:05Z",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "SQLite." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  }),
  line({ type: "user", uuid: "u2", parentUuid: "a1", timestamp: "2026-10-20T10:00:06Z", message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "SPEC.md" }, { type: "image" }] }] } }),
  line({ type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-10-20T10:00:07Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "only thinking" }] } }),
  line({ type: "system", uuid: "s1", parentUuid: "a2", subtype: "turn_duration" }),
  line({ type: "system", uuid: "cb", parentUuid: null, logicalParentUuid: "s1", subtype: "compact_boundary" }),
  line({ type: "user", uuid: "u3", parentUuid: "cb", timestamp: "2026-10-20T11:00:00Z", isSidechain: true, message: { role: "user", content: [{ type: "text", text: "after compaction" }, { type: "server_widget", x: 1 }] } }),
  line({ type: "ai-title", aiTitle: "Database choice" }),
  line({ type: "future-line-type", uuid: "f1", parentUuid: "u3" }),
  '{"type":"brain:unparseable_line","chars":120}',
  "[1,2,3]",
  line({ type: "user", parentUuid: "u3", message: { content: "no uuid" } }),
  "",
].join("\n");

describe("classifyClaudeCodePath", () => {
  it("recognises sessions, subagent transcripts and memory files", () => {
    const p = "/home/me/.claude/projects/-home-me-dev-brain";
    expect(classifyClaudeCodePath(`${p}/${S}.jsonl`)).toEqual({ kind: "session", projectDir: "-home-me-dev-brain", sessionId: S });
    expect(classifyClaudeCodePath(`${p}/${S}/subagents/agent-afbf77f4b35a3fcb3.jsonl`)).toEqual({
      kind: "subagent", projectDir: "-home-me-dev-brain", sessionId: S, agentId: "afbf77f4b35a3fcb3",
    });
    expect(classifyClaudeCodePath(`${p}/memory/MEMORY.md`)).toEqual({ kind: "memory", projectDir: "-home-me-dev-brain", name: "MEMORY.md" });
  });

  it("ignores other files", () => {
    const p = "/home/me/.claude/projects/-home-me-dev-brain";
    for (const other of [`${p}/${S}/tool-results/out.txt`, `${p}/notes.jsonl`, `/elsewhere/${S}.jsonl`, `${p}/memory/sub/x.md`]) {
      expect(classifyClaudeCodePath(other)).toBeNull();
    }
  });
});

describe("parseSession", () => {
  const parsed = parseSession(SESSION);

  it("keeps user, assistant and tool-result turns with their text", () => {
    expect(parsed.turns.map((t) => [t.externalUuid, t.role, t.text])).toEqual([
      ["u1", "user", "Pick SQLite or Postgres?"],
      ["a1", "assistant", 'SQLite.\n[tool_use Bash] {"command":"ls"}'],
      ["u2", "tool", "SPEC.md\n[image]"],
      ["u3", "user", "after compaction"],
    ]);
    expect(parsed.turns.map((t) => [t.ts, t.isSidechain])).toEqual([
      ["2026-10-20T10:00:00Z", false],
      ["2026-10-20T10:00:05Z", false],
      ["2026-10-20T10:00:06Z", false],
      ["2026-10-20T11:00:00Z", true],
    ]);
  });

  it("resolves each parent to the nearest stored turn, past attachments, system lines and compaction", () => {
    expect(Object.fromEntries(parsed.turns.map((t) => [t.externalUuid, t.parentUuid]))).toEqual({ u1: null, a1: "u1", u2: "a1", u3: "u2" });
  });

  it("counts what it skipped instead of failing", () => {
    expect(parsed.stats).toEqual({
      lines: 13,
      turns: 4,
      skippedTypes: { "attachment/hook_additional_context": 1, system: 2, "ai-title": 1, "future-line-type": 1, "brain:unparseable_line": 1 },
      skippedBlocks: { thinking: 2, server_widget: 1 },
      emptyTurns: 1,
      malformed: 2,
      duplicates: 0,
      injected: 0,
    });
  });

  it("reads the title, working directory, branch and time span", () => {
    expect([parsed.title, parsed.cwd, parsed.gitBranch, parsed.createdAt, parsed.updatedAt]).toEqual([
      "Database choice", "/home/me/dev/brain", "master", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z",
    ]);
  });

  it("parses an empty file to nothing", () => {
    expect(parseSession("").turns).toEqual([]);
  });
});

describe("parseSession edge cases", () => {
  const t = (uuid: string, parent: string | null, extra: object = {}) =>
    line({ type: "user", uuid, parentUuid: parent, message: { content: `text ${uuid}` }, ...extra });

  it("never links a turn to itself, even through a cycle of skipped lines", () => {
    const text = [
      t("self", "self"),
      line({ type: "system", uuid: "x", parentUuid: "y" }),
      line({ type: "system", uuid: "y", parentUuid: "x" }),
      t("loop", "x"),
    ].join("\n");
    expect(parseSession(text).turns.map((x) => [x.externalUuid, x.parentUuid])).toEqual([["self", null], ["loop", null]]);
  });

  it("counts a repeated uuid and keeps its last line", () => {
    const parsed = parseSession([t("u1", null), t("u1", null, { message: { content: "rewritten" } })].join("\n"));
    expect(parsed.stats.duplicates).toBe(1);
    expect(parsed.turns.map((x) => x.text)).toEqual(["rewritten"]);
  });

  it("resolves parents past long runs of skipped lines in linear time", () => {
    const lines = [t("root", null)];
    let prev = "root";
    for (let i = 0; i < 50_000; i++) {
      lines.push(line({ type: "system", uuid: `s${i}`, parentUuid: prev }));
      prev = `s${i}`;
    }
    for (let i = 0; i < 2_000; i++) lines.push(t(`leaf${i}`, prev));
    const started = performance.now();
    const parsed = parseSession(lines.join("\n"));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(new Set(parsed.turns.slice(1).map((x) => x.parentUuid))).toEqual(new Set(["root"]));
  });
});

describe("projectsView", () => {
  it("places every file under /projects/<dir>/, whatever the root is called", () => {
    const f = `-home-me-work/${S}.jsonl`;
    expect(projectsView("/h/.claude/projects", "/h/.claude/projects")(`/h/.claude/projects/${f}`)).toBe(`/projects/${f}`);
    expect(projectsView("/backup/projs", "/backup/projs")(`/backup/projs/${f}`)).toBe(`/projects/${f}`);
    expect(projectsView("/h/link", "/h/.claude/projects")(`/h/link/${f}`)).toBe(`/projects/${f}`);
    expect(projectsView("/h/.claude/projects/-home-me-work", "/h/.claude/projects/-home-me-work")(`/h/.claude/projects/${f}`)).toBe(`/projects/${f}`);
    const file = `/h/.claude/projects/${f}`;
    expect(projectsView(file, file)(file)).toBe(`/projects/${f}`);
    expect(projectsView("/h/projects/x/.claude/projects", "/h/projects/x/.claude/projects")(`/h/projects/x/.claude/projects/${f}`)).toBe(`/projects/${f}`);
  });

  it("names a copied single project folder after itself, and a lone session file after its parent", () => {
    expect(projectsView("/backup/-home-me-work", "/backup/-home-me-work", "project-folder")(`/backup/-home-me-work/${S}.jsonl`)).toBe(`/projects/-home-me-work/${S}.jsonl`);
    const lone = `/tmp/-home-me-work/${S}.jsonl`;
    expect(projectsView(lone, lone, "session-file")(lone)).toBe(`/projects/-home-me-work/${S}.jsonl`);
  });

  it("recognises a project folder by its contents", () => {
    expect(looksLikeProjectFolder([`${S}.jsonl`, "notes.txt"])).toBe(true);
    expect(looksLikeProjectFolder(["memory"])).toBe(true);
    expect(looksLikeProjectFolder(["-home-me-work", "-home-me-dev"])).toBe(false);
  });
});

describe("parseMemory", () => {
  it("keeps the file as one turn, titled by its frontmatter name", () => {
    const text = "---\nname: prefers-sqlite\ndescription: x\n---\n\nThe user prefers SQLite.\n";
    const parsed = parseMemory(text, "prefers_sqlite.md");
    expect(parsed.title).toBe("prefers-sqlite");
    expect(parsed.turns).toEqual([{ externalUuid: "prefers_sqlite.md", parentUuid: null, role: "memory", ts: null, text, isSidechain: false, isInjected: false }]);
    expect(parseMemory("\n", "empty.md").turns).toEqual([]);
  });
});

describe("injected content", () => {
  const session = [
    line({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: "Fix it\n\n<system-reminder>\nbe brief\n</system-reminder>" } }),
    line({ type: "attachment", uuid: "h1", parentUuid: "u1", timestamp: "2026-10-20T10:00:01Z", attachment: { type: "hook_additional_context", content: ["[hook] context one", "context two"] } }),
    line({ type: "attachment", uuid: "e1", parentUuid: "h1", attachment: { type: "environment", snapshot: {} } }),
    line({ type: "assistant", uuid: "a1", parentUuid: "e1", timestamp: "2026-10-20T10:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "Done. <system-reminder> is a tag." }] } }),
    line({ type: "user", uuid: "m1", parentUuid: "a1", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /x" }] } }),
    line({ type: "user", uuid: "c1", parentUuid: "m1", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation." } }),
    line({ type: "user", uuid: "r1", parentUuid: "c1", message: { role: "user", content: "<task-notification>agent done</task-notification>" } }),
    line({ type: "user", uuid: "t1", parentUuid: "r1", message: { role: "user", content: [{ type: "tool_result", content: "file.ts\n<system-reminder>file changed</system-reminder>" }] } }),
  ].join("\n");
  const parsed = parseSession(session);
  const byId = Object.fromEntries(parsed.turns.map((t) => [t.externalUuid, t]));

  it("splits reminders out of a user's message into a flagged child turn", () => {
    expect(byId.u1).toMatchObject({ text: "Fix it", isInjected: false, parentUuid: null });
    expect(byId["u1#injected"]).toMatchObject({ text: "<system-reminder>\nbe brief\n</system-reminder>", isInjected: true, parentUuid: "u1", role: "user" });
    expect(byId.t1).toMatchObject({ role: "tool", text: "file.ts", isInjected: false });
    expect(byId["t1#injected"]).toMatchObject({ role: "tool", isInjected: true, parentUuid: "t1" });
  });

  it("stores hook additionalContext as an injected turn in the thread, and skips other attachments", () => {
    expect(byId.h1).toMatchObject({ text: "[hook] context one\ncontext two", isInjected: true, parentUuid: "u1" });
    expect(byId.a1).toMatchObject({ parentUuid: "h1", isInjected: false, text: "Done. <system-reminder> is a tag." });
    expect(byId.e1).toBeUndefined();
    expect(parsed.stats.skippedTypes).toEqual({ "attachment/environment": 1 });
  });

  it("flags whole messages the harness wrote: meta lines, compaction summaries, messages that are only a notice", () => {
    expect([byId.m1!.isInjected, byId.c1!.isInjected, byId.r1!.isInjected]).toEqual([true, true, true]);
    expect(byId["r1#injected"]).toBeUndefined();
    expect(parsed.stats.injected).toBe(6);
  });

  it("drops a replaced line's split-off reminders with it", () => {
    const again = line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "Fix it, edited" } });
    const turns = parseSession(`${session}\n${again}`).turns.map((t) => t.externalUuid);
    expect(turns).not.toContain("u1#injected");
  });
});

describe("recalled claims", () => {
  it("a tool result holding recall output is flagged injected on the next ingest", () => {
    const session = [
      line({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: "What do you know about the brain?" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-10-20T10:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "mcp__brain__recall", input: { query: "brain" } }] } }),
      line({ type: "user", uuid: "t1", parentUuid: "a1", timestamp: "2026-10-20T10:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "<brain-claims>\n1. clm_A · The user uses SQLite.\n</brain-claims>" }] }] } }),
    ].join("\n");
    const t1 = parseSession(session).turns.find((t) => t.externalUuid === "t1")!;
    expect(t1).toMatchObject({ role: "tool", isInjected: true });
  });
});
