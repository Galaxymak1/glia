import { describe, expect, it } from "vitest";
import { classifyClaudeCodePath, parseMemory, parseSession } from "../src/parsers/claudeCode.js";

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
      skippedTypes: { attachment: 1, system: 2, "ai-title": 1, "future-line-type": 1, "brain:unparseable_line": 1 },
      skippedBlocks: { thinking: 2, server_widget: 1 },
      emptyTurns: 1,
      malformed: 2,
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

describe("parseMemory", () => {
  it("keeps the file as one turn, titled by its frontmatter name", () => {
    const text = "---\nname: prefers-sqlite\ndescription: x\n---\n\nThe user prefers SQLite.\n";
    const parsed = parseMemory(text, "prefers_sqlite.md");
    expect(parsed.title).toBe("prefers-sqlite");
    expect(parsed.turns).toEqual([{ externalUuid: "prefers_sqlite.md", parentUuid: null, role: "memory", ts: null, text, isSidechain: false }]);
    expect(parseMemory("\n", "empty.md").turns).toEqual([]);
  });
});
