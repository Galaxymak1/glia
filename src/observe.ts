// `glia observe`: one screen of what glia holds and how fresh it is: evidence ingested, the
// meaning index, the daemon's jobs and the last evaluation. Read-only: it never migrates anything.

import { styleText } from "node:util";
import type Database from "better-sqlite3";
import { evalReport } from "./eval.js";
import { schemaVersion } from "./migrations.js";
import { isoSeconds } from "./scheduler.js";
import { indexStatus } from "./vectors.js";

const DAY_MS = 86_400_000;

type Counts = Record<string, number>;

export interface Observation {
  now: string;
  dbPath: string;
  schema: number;
  evidence: { sources: Counts; excluded: number; turns: number; lastTurn: string | null; rawFiles: number; lastReceived: string | null };
  index: { chunks: number; embedded: number; missingTurns: number; otherModel: number };
  jobs: { type: string; state: string; at: string | null }[];
  failedDay: number;
  eval: { runId: number; startedAt: string; b: string; a: string; unverified: number; pass: boolean | null } | null;
}

const countBy = (db: Database.Database, sql: string, ...params: unknown[]): Counts =>
  Object.fromEntries((db.prepare(sql).all(...params) as { k: string | null; n: number }[]).map((r) => [r.k ?? "none", r.n]));
const one = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as Record<string, number | string | null>;

export function observe(db: Database.Database, dbPath: string, model: string, now = new Date()): Observation {
  const idx = indexStatus(db, model);
  let ev: Observation["eval"] = null;
  // The latest run of arm B: a run with arm C only, from before the claims layer went, has no gate.
  const runId = one(db, "SELECT max(run_id) AS v FROM eval_results WHERE arm = 'B'").v as number | null;
  if (runId !== null) {
    const r = evalReport(db, runId);
    const pct = (t: { correct: number; total: number }) => (t.total ? `${t.correct}/${t.total} (${Math.round((t.correct / t.total) * 100)}%)` : "-");
    const armA = Object.values(r.byCategory).reduce((s, c) => ({ correct: s.correct + c.A.correct, total: s.total + c.A.total }), { correct: 0, total: 0 });
    ev = { runId: r.runId, startedAt: r.startedAt, b: pct(r.armB), a: pct(armA), unverified: r.unverified, pass: r.gate.pass };
  }
  return {
    now: isoSeconds(now),
    dbPath,
    schema: schemaVersion(db),
    evidence: {
      sources: countBy(db, "SELECT kind AS k, count(*) AS n FROM sources WHERE excluded = 0 GROUP BY kind ORDER BY n DESC"),
      excluded: one(db, "SELECT count(*) AS n FROM sources WHERE excluded = 1").n as number,
      turns: one(db, "SELECT count(*) AS n FROM turns t JOIN sources s ON s.id = t.source_id WHERE s.excluded = 0").n as number,
      lastTurn: one(db, "SELECT max(t.ts) AS v FROM turns t JOIN sources s ON s.id = t.source_id WHERE s.excluded = 0").v as string | null,
      rawFiles: one(db, "SELECT count(*) AS n FROM raw_files WHERE pruned_at IS NULL").n as number,
      lastReceived: one(db, "SELECT max(received_at) AS v FROM raw_files").v as string | null,
    },
    index: {
      chunks: one(db, "SELECT count(*) AS n FROM chunks").n as number,
      embedded: one(db, "SELECT count(*) AS n FROM chunks_vec WHERE model = ?", model).n as number,
      missingTurns: idx.missing,
      otherModel: idx.otherModel,
    },
    // The latest run of each job that ran in the last 7 days: a job type the daemon no longer
    // runs (extraction, before 0.2.0) drops out.
    jobs: db
      .prepare(
        `SELECT j.type, j.state, coalesce(j.finished_at, j.started_at) AS at FROM jobs j
         WHERE j.id = (SELECT max(id) FROM jobs k WHERE k.type = j.type) AND coalesce(j.finished_at, j.started_at) >= ? ORDER BY j.type`,
      )
      .all(isoSeconds(new Date(now.getTime() - 7 * DAY_MS))) as Observation["jobs"],
    failedDay: one(db, "SELECT count(*) AS n FROM jobs WHERE state = 'failed' AND finished_at >= ?", isoSeconds(new Date(now.getTime() - DAY_MS))).n as number,
    eval: ev,
  };
}

/** How long ago `iso` was, coarsely: "4 min", "3 h", "2 d". */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return "never";
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < DAY_MS / 1000) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

type Style = Parameters<typeof styleText>[0];

export function formatObserve(o: Observation, opts: { color: boolean }): string {
  const now = new Date(o.now);
  const paint = (style: Style, s: string) => (opts.color ? styleText(style, s, { validateStream: false }) : s);
  const head = (s: string) => paint("bold", s);
  const dim = (s: string) => paint("dim", s);
  const ok = (s: string) => paint("green", s);
  const warn = (s: string) => paint("yellow", s);
  const bad = (s: string) => paint("red", s);
  const n = (v: number) => v.toLocaleString("en-US");
  const list = (c: Counts) => Object.entries(c).map(([k, v]) => `${k} ${n(v)}`).join(", ") || "none";
  const row = (label: string, value: string) => `  ${label.padEnd(13)} ${value}`;

  const e = o.evidence;
  const total = Object.values(e.sources).reduce((s, v) => s + v, 0);
  const i = o.index;
  const indexDone = i.missingTurns === 0 && i.otherModel === 0 && i.embedded >= i.chunks;
  const lines = [
    `${head("glia")}  ${dim(`${o.dbPath}  schema v${o.schema}  ${o.now}`)}`,
    "",
    head("Evidence"),
    row("sources", `${n(total)}  ${dim(`(${list(e.sources)})`)}${e.excluded ? dim(`; ${n(e.excluded)} excluded`) : ""}`),
    row("turns", `${n(e.turns)}  ${dim(`latest ${ago(e.lastTurn, now)}`)}`),
    row("raw files", `${n(e.rawFiles)}  ${dim(`last received ${ago(e.lastReceived, now)}`)}`),
    "",
    head("Meaning index"),
    row("turns", `${n(i.embedded)}/${n(i.chunks)} chunks embedded${i.missingTurns ? warn(`, ${n(i.missingTurns)} turns not chunked yet`) : ""}${i.otherModel ? warn(`, ${n(i.otherModel)} from another model`) : ""}`),
    row("state", indexDone ? ok("up to date") : warn("behind (run: glia index)")),
    "",
    head("Jobs"),
    ...(o.jobs.length
      ? o.jobs.map((j) => row(j.type, `${(j.state === "failed" ? bad : j.state === "running" ? warn : (s: string) => s)(j.state)}  ${dim(ago(j.at, now))}`))
      : [row("none", dim("the daemon has not run a job yet (glia daemon install)"))]),
    ...(o.failedDay ? [row("failed", bad(`${o.failedDay} in the last 24 h (see the daemon log)`))] : []),
    "",
    head("Evaluation"),
    o.eval
      ? row(
          `run ${o.eval.runId}`,
          `B ${o.eval.b}, A ${o.eval.a}: gate ${o.eval.pass === null ? "-" : o.eval.pass ? ok("PASS") : bad("FAIL")}  ${dim(ago(o.eval.startedAt, now))}` +
            (o.eval.unverified ? warn(`; ${o.eval.unverified} verdicts not checked by hand`) : ""),
        )
      : row("none", dim("no run yet (glia eval run)")),
  ];
  return lines.join("\n");
}
