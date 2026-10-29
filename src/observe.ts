// `glia observe`: one screen of what the brain holds and what is waiting on whom: evidence
// ingested, the meaning index, extraction, claims, the review inbox, the audit, the daemon's
// jobs and the last evaluation. Read-only: it never routes, expires or migrates anything.

import { styleText } from "node:util";
import type Database from "better-sqlite3";
import { auditReport, PRECISION_TARGET } from "./audit.js";
import { evalReport } from "./eval.js";
import { planExtraction } from "./extractor.js";
import type { Config } from "./config.js";
import { schemaVersion } from "./migrations.js";
import { isoSeconds } from "./route.js";
import { indexStatus } from "./vectors.js";

/** The inbox size SPEC.md "Review inbox" aims for. */
export const INBOX_TARGET = 10;
const DAY_MS = 86_400_000;

type Counts = Record<string, number>;

export interface Observation {
  now: string;
  dbPath: string;
  schema: number;
  evidence: { sources: Counts; excluded: number; turns: number; lastTurn: string | null; rawFiles: number; lastReceived: string | null };
  index: { chunks: number; embedded: number; missingTurns: number; otherModel: number; claims: number; claimsEmbedded: number };
  extraction: { extracted: number; waiting: number | null; running: number; lastBatch: string | null; candidates: Counts };
  claims: { status: Counts; kind: Counts; origin: Counts };
  inbox: { open: number; reasons: Counts; audits: number; snoozed: number; oldest: string | null; expiringWeek: number };
  review: { week: number; rejected: number };
  audit: { judged: number; kept: number; precision: number | null; aiAutoAccepted: number; gate: boolean | null };
  jobs: { type: string; state: string; at: string | null }[];
  failedDay: number;
  eval: { runId: number; startedAt: string; b: string; c: string; a: string; unverified: number; pass: boolean | null } | null;
}

const countBy = (db: Database.Database, sql: string, ...params: unknown[]): Counts =>
  Object.fromEntries((db.prepare(sql).all(...params) as { k: string | null; n: number }[]).map((r) => [r.k ?? "none", r.n]));
const one = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as Record<string, number | string | null>;

/**
 * The reason a proposal is queued, without the claim it is similar to: "similar:clm_X" counts as
 * "similar", so the reasons read as a few groups.
 */
const reasonGroup = (reason: string) => (reason.startsWith("similar:") ? "similar" : reason);

export function observe(db: Database.Database, dbPath: string, config: Config, model: string, now = new Date()): Observation {
  const at = isoSeconds(now);
  const sources = countBy(db, "SELECT kind AS k, count(*) AS n FROM sources WHERE excluded = 0 GROUP BY kind ORDER BY n DESC");
  const idx = indexStatus(db, model);
  const reasons: Counts = {};
  for (const [r, n] of Object.entries(countBy(db, "SELECT reason AS k, count(*) AS n FROM proposals WHERE state = 'open' AND kind <> 'audit' GROUP BY reason"))) {
    reasons[reasonGroup(r)] = (reasons[reasonGroup(r)] ?? 0) + n;
  }
  const week = isoSeconds(new Date(now.getTime() - 7 * DAY_MS));
  const decided = countBy(db, "SELECT state AS k, count(*) AS n FROM proposals WHERE decision_ms IS NOT NULL AND decided_at >= ? GROUP BY state", week);
  const a = auditReport(db);
  let waiting: number | null;
  try {
    waiting = planExtraction(db, { config }).sources.length;
  } catch {
    waiting = null;
  }
  let ev: Observation["eval"] = null;
  if (one(db, "SELECT count(*) AS n FROM eval_runs").n) {
    const r = evalReport(db);
    const pct = (t: { correct: number; total: number }) => (t.total ? `${t.correct}/${t.total} (${Math.round((t.correct / t.total) * 100)}%)` : "-");
    const armA = Object.values(r.byCategory).reduce((s, c) => ({ correct: s.correct + c.A.correct, total: s.total + c.A.total }), { correct: 0, total: 0 });
    ev = { runId: r.runId, startedAt: r.startedAt, b: pct(r.armB), c: pct(r.armC), a: pct(armA), unverified: r.unverified, pass: r.gate.pass };
  }
  return {
    now: at,
    dbPath,
    schema: schemaVersion(db),
    evidence: {
      sources,
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
      claims: one(db, "SELECT count(*) AS n FROM claims").n as number,
      claimsEmbedded: one(db, "SELECT count(*) AS n FROM claims_vec WHERE model = ?", model).n as number,
    },
    extraction: {
      extracted: one(db, "SELECT count(*) AS n FROM extraction_state").n as number,
      waiting,
      running: one(db, "SELECT count(*) AS n FROM jobs WHERE type = 'extract' AND state = 'running'").n as number,
      lastBatch: one(db, "SELECT max(finished_at) AS v FROM jobs WHERE type = 'extract' AND state = 'done'").v as string | null,
      candidates: countBy(db, "SELECT state AS k, count(*) AS n FROM candidates GROUP BY state ORDER BY n DESC"),
    },
    claims: {
      status: countBy(db, "SELECT status AS k, count(*) AS n FROM claims GROUP BY status ORDER BY n DESC"),
      kind: countBy(db, "SELECT kind AS k, count(*) AS n FROM claims WHERE status = 'active' GROUP BY kind ORDER BY n DESC"),
      origin: countBy(db, "SELECT origin AS k, count(*) AS n FROM claims WHERE status = 'active' GROUP BY origin ORDER BY n DESC"),
    },
    inbox: {
      open: one(db, "SELECT count(*) AS n FROM proposals WHERE state = 'open'").n as number,
      reasons,
      audits: one(db, "SELECT count(*) AS n FROM proposals WHERE state = 'open' AND kind = 'audit'").n as number,
      snoozed: one(db, "SELECT count(*) AS n FROM proposals WHERE state = 'open' AND snoozed_until > ?", at).n as number,
      oldest: one(db, "SELECT min(created_at) AS v FROM proposals WHERE state = 'open'").v as string | null,
      expiringWeek: one(db, "SELECT count(*) AS n FROM proposals WHERE state = 'open' AND expires_at <= ?", isoSeconds(new Date(now.getTime() + 7 * DAY_MS))).n as number,
    },
    review: { week: Object.values(decided).reduce((s, n) => s + n, 0), rejected: decided.rejected ?? 0 },
    audit: {
      judged: a.judged,
      kept: a.kept,
      precision: a.precision,
      aiAutoAccepted: a.aiAutoAccepted,
      gate: a.precision === null ? null : a.precision >= PRECISION_TARGET && a.aiAutoAccepted === 0,
    },
    jobs: db
      .prepare(
        `SELECT j.type, j.state, coalesce(j.finished_at, j.started_at) AS at FROM jobs j
         WHERE j.id = (SELECT max(id) FROM jobs k WHERE k.type = j.type) ORDER BY j.type`,
      )
      .all() as Observation["jobs"],
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
  const row = (label: string, value: string) => `  ${label.padEnd(14)}${value}`;
  const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "-");

  const e = o.evidence;
  const total = Object.values(e.sources).reduce((s, v) => s + v, 0);
  const i = o.index;
  const indexDone = i.missingTurns === 0 && i.otherModel === 0 && i.claimsEmbedded >= i.claims;
  const x = o.extraction;
  const inboxOver = o.inbox.open - o.inbox.audits > INBOX_TARGET;
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
    row("claims", `${n(i.claimsEmbedded)}/${n(i.claims)} embedded`),
    row("state", indexDone ? ok("up to date") : warn("behind (run: glia index, glia index --claims)")),
    "",
    head("Extraction"),
    row("sources", `${n(x.extracted)} sent${x.waiting === null ? "" : x.waiting ? warn(`, ${n(x.waiting)} new or changed waiting`) : ok(", none waiting")}`),
    row("batches", `${x.running ? warn(`${x.running} running`) : "none running"}  ${dim(`last done ${ago(x.lastBatch, now)}`)}`),
    row("candidates", list(x.candidates)),
    "",
    head("Claims"),
    row("status", list(o.claims.status)),
    row("active kinds", list(o.claims.kind)),
    row("origins", list(o.claims.origin)),
    "",
    head("Review inbox"),
    row("open", `${(inboxOver ? warn : ok)(`${n(o.inbox.open - o.inbox.audits)} to review`)} ${dim(`(target ${INBOX_TARGET} or fewer)`)}, ${n(o.inbox.audits)} audit items${o.inbox.snoozed ? `, ${n(o.inbox.snoozed)} snoozed` : ""}`),
    row("why queued", list(o.inbox.reasons)),
    row("oldest", `${ago(o.inbox.oldest, now)}${o.inbox.expiringWeek ? warn(`; ${n(o.inbox.expiringWeek)} expire within 7 days`) : ""}`),
    row("last 7 days", `${n(o.review.week)} decided, ${n(o.review.rejected)} rejected  ${dim("(glia review)")}`),
    "",
    head("Audit"),
    row(
      "precision",
      o.audit.precision === null
        ? dim("nothing judged yet (glia audit sample)")
        : `${o.audit.kept}/${o.audit.judged} (${pct(o.audit.kept, o.audit.judged)}), AI-origin auto-accepted ${o.audit.aiAutoAccepted}: gate ${o.audit.gate ? ok("met") : bad("NOT met")}`,
    ),
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
          `B ${o.eval.b}, C ${o.eval.c}, A ${o.eval.a}: gate ${o.eval.pass === null ? "-" : o.eval.pass ? ok("PASS") : bad("FAIL")}  ${dim(ago(o.eval.startedAt, now))}` +
            (o.eval.unverified ? warn(`; ${o.eval.unverified} verdicts not checked by hand`) : ""),
        )
      : row("none", dim("no run yet (glia eval run)")),
  ];
  return lines.join("\n");
}
