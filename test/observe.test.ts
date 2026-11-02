import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { ago, formatObserve, observe } from "../src/observe.js";
import { type TurnRow, writeSource } from "../src/sources.js";

let db: ReturnType<typeof openDb>;
const NOW = new Date("2026-10-28T12:00:00Z");
const MODEL = "bge-m3";
const turn = (externalUuid: string, ts: string): TurnRow => ({ externalUuid, parentUuid: null, role: "user", ts, text: "bonjour", isSidechain: false, isInjected: false });
const source = (kind: Parameters<typeof writeSource>[1]["kind"], ext: string, turns: TurnRow[]) =>
  writeSource(db, { kind, external_id: ext, title: ext, project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: ext, parser_version: "t" }, turns);

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  source("cc", "s1", [turn("u1", "2026-10-26T12:00:00Z"), turn("u2", "2026-10-28T11:00:00Z")]);
  source("cai", "c1", [turn("u1", "2026-10-20T12:00:00Z")]);
  source("cai", "c2", [turn("u1", "2026-10-28T11:30:00Z")]);
  db.prepare("UPDATE sources SET excluded = 1 WHERE external_id = 'c2'").run();
});

describe("observe", () => {
  it("counts what glia holds, leaving excluded sources out", () => {
    const o = observe(db, "/x/glia.db", MODEL, NOW);
    expect(o.evidence).toMatchObject({ sources: { cc: 1, cai: 1 }, excluded: 1, turns: 3, lastTurn: "2026-10-28T11:00:00Z" });
    expect(o.index).toEqual({ chunks: 0, embedded: 0, missingTurns: 3, otherModel: 0 });
  });

  it("reports no jobs and no evaluation before there are any", () => {
    const o = observe(db, "/x/glia.db", MODEL, NOW);
    expect(o.jobs).toEqual([]);
    expect(o.eval).toBeNull();
  });

  it("shows the latest run of each job type", () => {
    db.prepare("INSERT INTO jobs (type, state, started_at, finished_at) VALUES ('sweep', 'done', '2026-10-28T10:00:00Z', '2026-10-28T10:01:00Z'), ('sweep', 'failed', '2026-10-28T11:00:00Z', '2026-10-28T11:01:00Z')").run();
    const o = observe(db, "/x/glia.db", MODEL, NOW);
    expect(o.jobs).toEqual([{ type: "sweep", state: "failed", at: "2026-10-28T11:01:00Z" }]);
    expect(o.failedDay).toBe(1);
  });

  it("leaves out job types that have not run for 7 days", () => {
    db.prepare("INSERT INTO jobs (type, state, started_at, finished_at) VALUES ('extract_submit', 'done', '2026-10-20T01:00:00Z', '2026-10-20T01:01:00Z'), ('sweep', 'done', '2026-10-28T10:00:00Z', '2026-10-28T10:01:00Z')").run();
    expect(observe(db, "/x/glia.db", MODEL, NOW).jobs.map((j) => j.type)).toEqual(["sweep"]);
  });

  it("shows the latest run of arm B, not a later run without it", () => {
    db.prepare("INSERT INTO eval_runs (id, started_at, questions_sha256, questions, model, judge_model) VALUES (1, '2026-10-27T10:00:00Z', 'x', 1, 'm', 'j'), (2, '2026-10-28T10:00:00Z', 'x', 1, 'm', 'j')").run();
    const row = "INSERT INTO eval_results (run_id, question_id, arm, category, location, question, reference, answer, verdict) VALUES (?, 'q1', ?, 'temporal', 'cc', 'q', 'r', 'a', 'correct')";
    db.prepare(row).run(1, "B");
    db.prepare(row).run(2, "C");
    expect(observe(db, "/x/glia.db", MODEL, NOW).eval).toMatchObject({ runId: 1, b: "1/1 (100%)" });
  });
});

describe("formatObserve", () => {
  it("prints every section, plain without color", () => {
    const out = formatObserve(observe(db, "/x/glia.db", MODEL, NOW), { color: false });
    for (const h of ["Evidence", "Meaning index", "Jobs", "Evaluation"]) expect(out).toContain(`\n${h}\n`);
    expect(out).toContain("sources       2  (cai 1, cc 1); 1 excluded");
    expect(out).toContain("behind (run: glia index)");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("keeps a space between a long label and its value", () => {
    db.prepare("INSERT INTO jobs (type, state, started_at, finished_at) VALUES ('a_very_long_job', 'done', '2026-10-28T10:00:00Z', '2026-10-28T10:01:00Z')").run();
    expect(formatObserve(observe(db, "/x/glia.db", MODEL, NOW), { color: false })).toContain("a_very_long_job done");
  });

  it("colors only when asked", () => {
    expect(formatObserve(observe(db, "/x/glia.db", MODEL, NOW), { color: true })).toMatch(/\x1b\[/);
  });
});

describe("ago", () => {
  it("says how long ago, coarsely", () => {
    expect(ago(null, NOW)).toBe("never");
    expect(ago("2026-10-28T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-10-28T11:15:00Z", NOW)).toBe("45 min ago");
    expect(ago("2026-10-28T07:00:00Z", NOW)).toBe("5 h ago");
    expect(ago("2026-10-25T12:00:00Z", NOW)).toBe("3 d ago");
  });
});
