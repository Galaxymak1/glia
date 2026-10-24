// The evaluation harness (#10, SPEC.md "Evaluation"): arm B answers each question with `claude -p`
// and the local MCP tools only, Claude judges every answer against its reference, and the run is
// stored dated. Arm A (claude.ai's own chat search) is asked by hand; its answers are read from a
// file and judged the same way. The gate compares the two.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

export const CATEGORIES = ["knowledge_update", "temporal", "abstention", "provenance", "cross_project", "decision_recall"] as const;
export type Category = (typeof CATEGORIES)[number];
export const LOCATIONS = ["cai", "cc", "both"] as const;
export type Location = (typeof LOCATIONS)[number];

export interface Question {
  id: string;
  category: Category;
  question: string;
  reference: string;
  /** Turn ids holding the answer; empty for abstention. */
  sources: number[];
  /** Where the answer lives: claude.ai, Claude Code, or both. */
  where: Location;
  note?: string;
}

/** The questions file: one JSON object per line. Throws with every bad line named. */
export function parseQuestions(text: string): Question[] {
  const questions: Question[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let q: Partial<Question>;
    try {
      q = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: not valid JSON`);
      return;
    }
    const bad = [
      typeof q.id !== "string" || !q.id ? "id" : null,
      !CATEGORIES.includes(q.category as Category) ? "category" : null,
      typeof q.question !== "string" || !q.question.trim() ? "question" : null,
      typeof q.reference !== "string" || !q.reference.trim() ? "reference" : null,
      !Array.isArray(q.sources) || !q.sources.every((s) => Number.isInteger(s)) ? "sources" : null,
      !LOCATIONS.includes(q.where as Location) ? "where" : null,
    ].filter(Boolean);
    if (bad.length) errors.push(`line ${i + 1}: invalid ${bad.join(", ")}`);
    else if (ids.has(q.id!)) errors.push(`line ${i + 1}: duplicate id ${q.id}`);
    else {
      ids.add(q.id!);
      questions.push(q as Question);
    }
  });
  if (errors.length) throw new Error(`questions file: ${errors.join("; ")}`);
  return questions;
}

/** Arm A answers, typed in by hand after asking claude.ai: `{"id": "q01", "answer": "..."}` per line. */
export function parseArmA(text: string): Map<string, string> {
  const answers = new Map<string, string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let a: { id?: unknown; answer?: unknown };
    try {
      a = JSON.parse(line);
    } catch {
      throw new Error(`arm A file, line ${i + 1}: not valid JSON`);
    }
    if (typeof a.id !== "string" || typeof a.answer !== "string") throw new Error(`arm A file, line ${i + 1}: needs "id" and "answer" strings`);
    answers.set(a.id, a.answer);
  });
  return answers;
}

/** Runs `claude` with these arguments and returns its stdout; the seam the tests replace. */
export type ClaudeRunner = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;

export const runClaude: ClaudeRunner = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(signal ? `claude killed (${signal}) after ${timeoutMs / 1000} s` : `claude exited ${code}: ${err.trim().slice(0, 300)}`));
    });
  });

const ARM_B_TOOLS = ["mcp__brain__search_evidence", "mcp__brain__open_evidence"];

/**
 * Only the brain tools: no built-in tool (no file reads, no shell), no other MCP server, no user
 * settings (hooks, plugins), no CLAUDE.md (an empty working folder), and no session file, so the
 * run never lands in ~/.claude/projects and is never ingested back as evidence.
 */
const ISOLATION = ["--tools", "", "--strict-mcp-config", "--setting-sources", "project", "--no-session-persistence"];

export function armBPrompt(question: string): string {
  return [
    "Answer a question about my own past conversations with Claude (Claude Code sessions, claude.ai chats and projects, memory files).",
    "Use the search_evidence and open_evidence tools: search, trying other wordings or the other language (French or English) when the first search is thin, open the most relevant turns, then answer briefly and specifically, in the language of the question.",
    "When something changed over time, give the latest state and say what it replaced. If the history does not hold the answer, say you could not find it instead of guessing.",
    "",
    `Question: ${question}`,
  ].join("\n");
}

export function judgePrompt(q: Question, answer: string): string {
  const rule =
    q.category === "abstention"
      ? "This question is never answered in the history. The answer is correct only if it says the information could not be found (or that it does not know) without asserting an answer."
      : "The answer is correct if it states the key facts of the reference (names, values, choices, reasons, order, dates), whatever the wording or extra detail. It is incorrect if it misses or contradicts a key fact, or says it could not find the answer." +
        (q.category === "knowledge_update" ? " The current state must be given as the current one." : "");
  return [
    "You grade an answer to a question about a person's own past conversations, against a reference answer.",
    rule,
    "",
    `Category: ${q.category}`,
    `Question: ${q.question}`,
    `Reference answer: ${q.reference}`,
    `Answer to grade: ${answer}`,
    "",
    'Reply with JSON only: {"verdict": "correct" or "incorrect", "reason": "one sentence"}',
  ].join("\n");
}

export interface ArmBResult {
  answer: string;
  /** Turn ids each search_evidence call returned, in rank order. */
  searches: number[][];
  opened: number[];
}

/** Reads a `claude -p --output-format stream-json --verbose` transcript. */
export function parseStream(stdout: string): ArmBResult {
  const toolNames = new Map<string, string>();
  const searches: number[][] = [];
  const opened: number[] = [];
  let answer = "";
  let error: string | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let m: { type?: string; message?: { content?: unknown }; result?: unknown; is_error?: boolean };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(m.message?.content) ? (m.message!.content as Record<string, unknown>[]) : [];
    if (m.type === "assistant") {
      for (const c of content) {
        if (c.type !== "tool_use") continue;
        toolNames.set(String(c.id), String(c.name));
        const input = c.input as { id?: unknown } | undefined;
        if (String(c.name).endsWith("open_evidence") && typeof input?.id === "number") opened.push(input.id);
      }
    } else if (m.type === "user") {
      for (const c of content) {
        if (c.type !== "tool_result" || !toolNames.get(String(c.tool_use_id))?.endsWith("search_evidence")) continue;
        const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((b: { text?: string }) => b.text ?? "").join("\n") : "";
        searches.push([...text.matchAll(/^\d+\. turn (\d+) /gm)].map((x) => Number(x[1])));
      }
    } else if (m.type === "result") {
      answer = typeof m.result === "string" ? m.result : "";
      if (m.is_error) error = answer || "claude reported an error";
    }
  }
  if (error) throw new Error(error);
  return { answer, searches, opened };
}

/** Whether a source turn is among the first 8 hits of any search the arm ran; null without sources. */
export function hitAt8(q: Question, searches: number[][]): boolean | null {
  if (!q.sources.length) return null;
  const top = new Set(searches.flatMap((s) => s.slice(0, 8)));
  return q.sources.some((id) => top.has(id));
}

export function parseVerdict(stdout: string): { verdict: "correct" | "incorrect"; reason: string } {
  let text = stdout;
  try {
    const r = JSON.parse(stdout) as { result?: unknown };
    if (typeof r.result === "string") text = r.result;
  } catch {
    // plain text output
  }
  const json = text.match(/\{[^]*\}/)?.[0];
  if (!json) throw new Error(`judge gave no JSON: ${text.slice(0, 200)}`);
  const v = JSON.parse(json) as { verdict?: unknown; reason?: unknown };
  if (v.verdict !== "correct" && v.verdict !== "incorrect") throw new Error(`judge verdict not understood: ${json.slice(0, 200)}`);
  return { verdict: v.verdict, reason: typeof v.reason === "string" ? v.reason : "" };
}

export interface RunOptions {
  questions: Question[];
  questionsSha256: string;
  armA: Map<string, string>;
  model: string;
  judgeModel: string;
  /** The command that starts the brain MCP server, as [executable, ...args]. */
  mcpCommand: string[];
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const questionsSha256 = sha256;

/** Runs every question through arm B, judges both arms, stores the run; returns its id. */
export async function runEval(db: Database.Database, opts: RunOptions, runner: ClaudeRunner = runClaude): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const work = mkdtempSync(join(tmpdir(), "brain-eval-"));
  const mcpConfig = join(work, "mcp.json");
  const [command, ...args] = opts.mcpCommand;
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { brain: { command, args } } }));
  const runId = Number(
    db
      .prepare("INSERT INTO eval_runs (started_at, questions_sha256, questions, model, judge_model, base_url) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), opts.questionsSha256, opts.questions.length, opts.model, opts.judgeModel, process.env.ANTHROPIC_BASE_URL ?? null).lastInsertRowid,
  );
  const insert = db.prepare(
    `INSERT INTO eval_results (run_id, question_id, arm, category, location, question, reference, answer, verdict, reason, hit_at_8, searches, seconds)
     VALUES (@run_id, @question_id, @arm, @category, @location, @question, @reference, @answer, @verdict, @reason, @hit_at_8, @searches, @seconds)`,
  );
  const judge = async (q: Question, answer: string) => {
    try {
      return parseVerdict(await runner(["-p", judgePrompt(q, answer), "--model", opts.judgeModel, ...ISOLATION, "--output-format", "json"], { cwd: work, timeoutMs }));
    } catch (err) {
      return { verdict: "error" as const, reason: `judge failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const one = async (q: Question) => {
    const base = { run_id: runId, question_id: q.id, category: q.category, location: q.where, question: q.question, reference: q.reference };
    const started = Date.now();
    let b: ArmBResult | null = null;
    let failure = "";
    try {
      const stdout = await runner(
        ["-p", armBPrompt(q.question), "--model", opts.model, ...ISOLATION, "--mcp-config", mcpConfig, "--allowedTools", ARM_B_TOOLS.join(" "), "--output-format", "stream-json", "--verbose"],
        { cwd: work, timeoutMs },
      );
      b = parseStream(stdout);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const seconds = (Date.now() - started) / 1000;
    const vb = b ? await judge(q, b.answer) : { verdict: "error" as const, reason: `arm B failed: ${failure}` };
    insert.run({
      ...base,
      arm: "B",
      answer: b?.answer ?? null,
      verdict: vb.verdict,
      reason: vb.reason,
      hit_at_8: b ? (hitAt8(q, b.searches) === null ? null : hitAt8(q, b.searches) ? 1 : 0) : null,
      searches: b ? JSON.stringify({ searches: b.searches, opened: b.opened }) : null,
      seconds,
    });
    const a = opts.armA.get(q.id);
    let va: { verdict: string; reason: string } | null = null;
    if (a !== undefined) {
      va = await judge(q, a);
      insert.run({ ...base, arm: "A", answer: a, verdict: va.verdict, reason: va.reason, hit_at_8: null, searches: null, seconds: null });
    }
    opts.onProgress?.(`${q.id} [${q.category}] B ${vb.verdict}${va ? `, A ${va.verdict}` : ""} (${seconds.toFixed(0)} s)`);
  };
  try {
    const queue = [...opts.questions];
    await Promise.all(
      Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, async () => {
        for (let q = queue.shift(); q; q = queue.shift()) await one(q);
      }),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  db.prepare("UPDATE eval_runs SET finished_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
  return runId;
}

interface ResultRow {
  question_id: string;
  arm: "A" | "B";
  category: Category;
  location: Location;
  question: string;
  reference: string;
  answer: string | null;
  verdict: "correct" | "incorrect" | "error";
  reason: string | null;
  hit_at_8: number | null;
  hand_verdict: "correct" | "incorrect" | null;
}

type Tally = { correct: number; total: number };
const tally = (rows: ResultRow[]): Tally => ({ correct: rows.filter((r) => (r.hand_verdict ?? r.verdict) === "correct").length, total: rows.length });

export interface EvalReport {
  runId: number;
  startedAt: string;
  model: string;
  judgeModel: string;
  byCategory: Record<string, { A: Tally; B: Tally; bWhereA: Tally }>;
  armB: Tally;
  hit8: Tally;
  errors: number;
  unverified: number;
  gate: { rule1: boolean | null; rule2: boolean | null; rule3: boolean | null; pass: boolean | null; notes: string[] };
  rows: ResultRow[];
}

/**
 * The gate, as accepted on #10: (1) on the claude.ai subset, arm B gets more answers right than
 * arm A; (2) arm B scores no lower than arm A in any category; (3) on the Claude Code subset, arm
 * B is right most of the time. A hand verdict overrides Claude's; an error counts as wrong.
 */
export function evalReport(db: Database.Database, runId?: number): EvalReport {
  const run = (
    runId === undefined ? db.prepare("SELECT * FROM eval_runs ORDER BY id DESC LIMIT 1").get() : db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(runId)
  ) as { id: number; started_at: string; model: string; judge_model: string } | undefined;
  if (!run) throw new Error(runId === undefined ? "no evaluation run yet" : `no evaluation run ${runId}`);
  const rows = db.prepare("SELECT * FROM eval_results WHERE run_id = ? ORDER BY question_id, arm").all(run.id) as ResultRow[];
  const b = rows.filter((r) => r.arm === "B");
  const a = rows.filter((r) => r.arm === "A");
  const withA = new Set(a.map((r) => r.question_id));
  const byCategory: EvalReport["byCategory"] = {};
  for (const c of CATEGORIES) {
    byCategory[c] = {
      A: tally(a.filter((r) => r.category === c)),
      B: tally(b.filter((r) => r.category === c)),
      bWhereA: tally(b.filter((r) => r.category === c && withA.has(r.question_id))),
    };
  }
  const notes: string[] = [];
  const caiB = b.filter((r) => r.location !== "cc" && withA.has(r.question_id));
  const caiA = a.filter((r) => r.location !== "cc");
  const caiQuestions = b.filter((r) => r.location !== "cc").length;
  let rule1: boolean | null = null;
  if (!caiA.length) notes.push("rule 1 and 2 not decided: no arm A answers");
  else {
    if (caiA.length < caiQuestions) notes.push(`arm A answered ${caiA.length} of ${caiQuestions} claude.ai questions; rules 1 and 2 compare those only`);
    rule1 = tally(caiB).correct > tally(caiA).correct;
  }
  const compared = CATEGORIES.filter((c) => byCategory[c]!.A.total > 0);
  const rule2 = caiA.length ? compared.every((c) => byCategory[c]!.bWhereA.correct / byCategory[c]!.A.total >= byCategory[c]!.A.correct / byCategory[c]!.A.total) : null;
  const cc = tally(b.filter((r) => r.location !== "cai"));
  const rule3 = cc.total ? cc.correct / cc.total > 0.5 : null;
  if (!cc.total) notes.push("rule 3 not decided: no Claude Code questions");
  const unverified = rows.filter((r) => r.hand_verdict === null).length;
  if (unverified) notes.push(`${unverified} verdicts not yet checked by hand (first run: check each one)`);
  const decided = [rule1, rule2, rule3];
  const pass = decided.includes(false) ? false : decided.includes(null) ? null : true;
  return {
    runId: run.id,
    startedAt: run.started_at,
    model: run.model,
    judgeModel: run.judge_model,
    byCategory,
    armB: tally(b),
    hit8: { correct: b.filter((r) => r.hit_at_8 === 1).length, total: b.filter((r) => r.hit_at_8 !== null).length },
    errors: rows.filter((r) => r.verdict === "error" && r.hand_verdict === null).length,
    unverified,
    gate: { rule1, rule2, rule3, pass, notes },
    rows,
  };
}

export function formatEvalReport(r: EvalReport, details: boolean): string {
  const pct = (t: Tally) => (t.total ? `${t.correct}/${t.total} (${Math.round((100 * t.correct) / t.total)}%)` : "-");
  const yes = (v: boolean | null) => (v === null ? "not decided" : v ? "met" : "NOT met");
  const out = [
    `Evaluation run ${r.runId} · ${r.startedAt.slice(0, 16).replace("T", " ")} · arm B ${r.model}, judge ${r.judgeModel}`,
    "",
    `${"category".padEnd(18)}  ${"arm B".padEnd(12)}  arm A`,
    ...CATEGORIES.map((c) => `${c.padEnd(18)}  ${pct(r.byCategory[c]!.B).padEnd(12)}  ${pct(r.byCategory[c]!.A)}`),
    `${"all".padEnd(18)}  ${pct(r.armB)}`,
    "",
    `Retrieval hit@8 (arm B, questions with sources): ${pct(r.hit8)}`,
    r.errors ? `Errors (counted as wrong): ${r.errors}` : "",
    "",
    "Gate:",
    `  1. claude.ai subset, B right more often than A: ${yes(r.gate.rule1)}`,
    `  2. B no lower than A in any category: ${yes(r.gate.rule2)}`,
    `  3. Claude Code subset, B right most of the time: ${yes(r.gate.rule3)}`,
    `  => ${r.gate.pass === null ? "NOT DECIDED" : r.gate.pass ? "PASS" : "FAIL"}`,
    ...r.gate.notes.map((n) => `  note: ${n}`),
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "");
  if (details) {
    for (const row of r.rows) {
      const v = row.hand_verdict ? `${row.hand_verdict} (by hand; Claude: ${row.verdict})` : row.verdict;
      out.push(
        "",
        `--- ${row.question_id} · arm ${row.arm} · ${row.category} · ${row.location} · ${v}${row.hit_at_8 === null ? "" : row.hit_at_8 ? " · hit@8" : " · miss@8"}`,
        `Q: ${row.question}`,
        `Reference: ${row.reference}`,
        `Answer: ${row.answer ?? "(none)"}`,
        `Judge: ${row.reason ?? ""}`,
      );
    }
  }
  return out.join("\n");
}

/** Records a hand-checked verdict; it overrides Claude's in every report of the run. */
export function verifyVerdict(db: Database.Database, runId: number, questionId: string, arm: "A" | "B", verdict: "correct" | "incorrect"): void {
  const { changes } = db.prepare("UPDATE eval_results SET hand_verdict = ? WHERE run_id = ? AND question_id = ? AND arm = ?").run(verdict, runId, questionId, arm);
  if (!changes) throw new Error(`no result for run ${runId}, question ${questionId}, arm ${arm}`);
}

export const readQuestionsFile = (path: string) => {
  const text = readFileSync(path, "utf8");
  return { questions: parseQuestions(text), sha256: sha256(text) };
};
