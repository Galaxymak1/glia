import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  type ClaudeRunner,
  evalReport,
  formatEvalReport,
  hitAt8,
  parseArmA,
  parseQuestions,
  parseStream,
  parseVerdict,
  type Question,
  runEval,
  verifyVerdict,
} from "../src/eval.js";
import { migrate } from "../src/migrations.js";

const q = (id: string, category: Question["category"], where: Question["where"], sources: number[] = [7]): Question => ({
  id,
  category,
  question: `question ${id}`,
  reference: `reference ${id}`,
  sources,
  where,
});

/** A stream-json transcript: one search returning `hits`, then the answer. */
const stream = (hits: number[], answer: string) =>
  [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__glia__search_evidence", input: { query: "x" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: hits.map((h, i) => `${i + 1}. turn ${h} · [cai] T · assistant\n   snippet`).join("\n") }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__glia__open_evidence", input: { id: hits[0] } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "--- turn" }] }] } },
    { type: "result", subtype: "success", is_error: false, result: answer },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n");

describe("parsing", () => {
  it("reads a valid question set and names every bad line", () => {
    const good = JSON.stringify(q("q1", "temporal", "cai"));
    expect(parseQuestions(`${good}\n\n`)).toHaveLength(1);
    expect(() => parseQuestions(`${good}\n{"id":"q2","category":"nope"}\n${good}\nnot json`)).toThrow(
      /line 2: invalid category, question, reference, sources, where; line 3: duplicate id q1; line 4: not valid JSON/,
    );
  });

  it("reads arm A answers", () => {
    expect(parseArmA('{"id":"q1","answer":"yes"}\n').get("q1")).toBe("yes");
    expect(() => parseArmA('{"id":"q1"}')).toThrow(/line 1/);
  });

  it("reads the tools' results and the answer from a stream-json transcript", () => {
    expect(parseStream(stream([5, 7, 9], "It was SQLite."))).toEqual({ answer: "It was SQLite.", searches: [[5, 7, 9]], opened: [5] });
    expect(() => parseStream(JSON.stringify({ type: "result", is_error: true, result: "rate limited" }))).toThrow(/rate limited/);
    expect(() => parseStream(stream([5], "").split("\n").slice(0, -1).join("\n"))).toThrow(/no answer/);
  });

  it("counts a hit when a source is in the first 8 of any search", () => {
    expect(hitAt8(q("a", "temporal", "cai", [7]), [[1, 2, 3, 4, 5, 6, 8, 9, 7]])).toBe(false);
    expect(hitAt8(q("a", "temporal", "cai", [7]), [[1], [2, 7]])).toBe(true);
    expect(hitAt8(q("a", "abstention", "cai", []), [[7]])).toBeNull();
  });

  it("reads the judge's verdict from its JSON output", () => {
    expect(parseVerdict(JSON.stringify({ type: "result", result: 'Sure.\n{"verdict": "correct", "reason": "same facts"}' }))).toEqual({ verdict: "correct", reason: "same facts" });
    expect(() => parseVerdict(JSON.stringify({ result: "I think it is right" }))).toThrow(/no JSON/);
    expect(() => parseVerdict('{"verdict": "maybe"}')).toThrow(/not understood/);
  });
});

describe("runEval and the gate", () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db);
  });

  // Arm B answers "right" except for q3; the judge calls an answer correct when it holds "right".
  const runner: ClaudeRunner = async (args) => {
    const prompt = args[args.indexOf("-p") + 1]!;
    if (args.includes("stream-json")) {
      expect(args).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--no-session-persistence", "--mcp-config"]));
      return stream([7, 8], prompt.includes("question q3") ? "wrong" : "right");
    }
    const answer = prompt.slice(prompt.indexOf("Answer to grade:"));
    return JSON.stringify({ result: JSON.stringify({ verdict: answer.includes("right") ? "correct" : "incorrect", reason: "r" }) });
  };
  const questions = [q("q1", "temporal", "cai"), q("q2", "temporal", "cai"), q("q3", "provenance", "cc"), q("q4", "provenance", "cc"), q("q5", "abstention", "cc", [])];
  const run = (armA: Record<string, string>) =>
    runEval(db, { questions, questionsSha256: "sha", armA: new Map(Object.entries(armA)), model: "m", judgeModel: "j", mcpCommand: ["node", "cli.js", "mcp"], concurrency: 2 }, runner);

  it("stores every answer and verdict, and decides the gate", async () => {
    const id = await run({ q1: "right", q2: "wrong" });
    const r = evalReport(db, id);
    expect(r.armB).toEqual({ correct: 4, total: 5 });
    expect(r.byCategory.temporal).toEqual({ A: { correct: 1, total: 2 }, B: { correct: 2, total: 2 }, C: { correct: 0, total: 0 }, bWhereA: { correct: 2, total: 2 } });
    expect(r.hit8).toEqual({ correct: 4, total: 4 });
    expect(r.gate).toMatchObject({ rule1: true, rule2: true, rule3: true, pass: true });
    expect(r.gate.notes.join(" ")).toContain("7 verdicts not yet checked by hand");
    expect(formatEvalReport(r, true)).toContain("=> PASS");
    expect(db.prepare("SELECT finished_at IS NOT NULL AS done FROM eval_runs WHERE id = ?").get(id)).toEqual({ done: 1 });
  });

  it("fails rule 1 when arm A does as well, and leaves rules 1 and 2 open without arm A", async () => {
    expect(evalReport(db, await run({ q1: "right", q2: "right" })).gate).toMatchObject({ rule1: false, pass: false });
    const open = evalReport(db, await run({}));
    expect(open.gate).toMatchObject({ rule1: null, rule2: null, rule3: true, pass: null });
    expect(formatEvalReport(open, false)).toContain("=> NOT DECIDED");
  });

  it("compares arm A on the claude.ai subset only", async () => {
    // An arm A answer to a Claude Code question (q3, which B gets wrong) changes neither rule 1 nor rule 2.
    const r = evalReport(db, await run({ q1: "right", q2: "wrong", q3: "right" }));
    expect(r.byCategory.provenance!.A).toEqual({ correct: 0, total: 0 });
    expect(r.gate).toMatchObject({ rule1: true, rule2: true });
  });

  it("lets a hand verdict override Claude's", async () => {
    const id = await run({});
    verifyVerdict(db, id, "q3", "B", "correct");
    expect(evalReport(db, id).armB).toEqual({ correct: 5, total: 5 });
    expect(() => verifyVerdict(db, id, "q9", "B", "correct")).toThrow(/no result/);
  });

  it("records a failed arm B run as an error, counted wrong", async () => {
    const failing: ClaudeRunner = async (args) => {
      if (args.includes("stream-json")) throw new Error("claude exited 1: not logged in");
      return runner(args, { cwd: "", timeoutMs: 0 });
    };
    const id = await runEval(db, { questions: [questions[0]!], questionsSha256: "s", armA: new Map(), model: "m", judgeModel: "j", mcpCommand: ["x"] }, failing);
    const r = evalReport(db, id);
    expect(r.rows[0]).toMatchObject({ verdict: "error", reason: "arm B failed: claude exited 1: not logged in", hit_at_8: 0 });
    expect(r.errors).toBe(1);
    expect(r.hit8).toEqual({ correct: 0, total: 1 });
  });

  describe("arm C, claims", () => {
    // Arm C answers "right" except for q1; it sees recall and brief only.
    const seen: string[][] = [];
    const withC: ClaudeRunner = async (args, o) => {
      if (args.includes("stream-json") && args.join(" ").includes("mcp__glia__recall")) {
        seen.push(args);
        const prompt = args[args.indexOf("-p") + 1]!;
        return stream([], prompt.includes("question q1") ? "wrong" : "right");
      }
      return runner(args, o);
    };
    const runArms = (arms: ("B" | "C")[]) =>
      runEval(db, { questions, questionsSha256: "sha", armA: new Map(), model: "m", judgeModel: "j", mcpCommand: ["node", "cli.js", "mcp"], arms }, withC);

    it("arm C runs with recall and brief only", async () => {
      seen.length = 0;
      await runArms(["B", "C"]);
      expect(seen).toHaveLength(5);
      for (const a of seen) {
        expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__glia__recall mcp__glia__brief");
        expect(a).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--no-session-persistence"]));
        expect(a[a.indexOf("-p") + 1]).toContain("recall and brief");
      }
    });

    it("without arms, runs arm B only", async () => {
      seen.length = 0;
      const id = await run({});
      expect(seen).toHaveLength(0);
      expect(evalReport(db, id).armC).toEqual({ correct: 0, total: 0 });
    });

    it("the report compares arms B and C per category", async () => {
      const id = await runArms(["B", "C"]);
      const r = evalReport(db, id);
      expect(r.armC).toEqual({ correct: 4, total: 5 });
      expect(r.byCategory.temporal!.C).toEqual({ correct: 1, total: 2 });
      expect(r.rows.filter((x) => x.arm === "C").every((x) => x.hit_at_8 === null)).toBe(true);
      const text = formatEvalReport(r, false);
      expect(text).toMatch(/category\s+arm B\s+arm C\s+arm A/);
      expect(text).toMatch(/temporal\s+2\/2 \(100%\)\s+1\/2 \(50%\)/);
      verifyVerdict(db, id, "q1", "C", "correct");
      expect(evalReport(db, id).armC).toEqual({ correct: 5, total: 5 });
    });
  });
});
