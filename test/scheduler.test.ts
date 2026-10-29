import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { dailyAt, every15, parisParts, startScheduler } from "../src/scheduler.js";

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function minutesUtc(from: string, to: string): Date[] {
  const out: Date[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 60_000) out.push(new Date(t));
  return out;
}

describe("Paris time", () => {
  it("parisParts follows the Paris offset", () => {
    expect(parisParts(new Date("2026-07-01T22:30:00Z"))).toEqual({ date: "2026-07-02", hour: 0, minute: 30 });
    expect(parisParts(new Date("2026-12-01T22:30:00Z"))).toEqual({ date: "2026-12-01", hour: 23, minute: 30 });
  });

  it("02:00 Paris across DST: once per Paris night, never twice, never skipped", () => {
    const key = dailyAt(2, 0);
    // Each range starts at Paris midnight, so only nights inside it are due.
    const keys = [...minutesUtc("2026-03-27T23:00Z", "2026-03-30T06:00Z"), ...minutesUtc("2026-10-23T22:00Z", "2026-10-26T06:00Z")].map(key).filter(Boolean);
    expect([...new Set(keys)]).toEqual(["2026-03-28", "2026-03-29", "2026-03-30", "2026-10-24", "2026-10-25", "2026-10-26"]);
  });

  it("every15 floors to the quarter hour in Paris time", () => {
    expect(every15(new Date("2026-10-27T11:44:59Z"))).toBe("2026-10-27T12:30");
  });
});

describe("startScheduler", () => {
  it("runs a due job once per key and records it", async () => {
    const runs: string[] = [];
    const s = startScheduler(db, [{ type: "t", key: () => "k1", run: async () => void runs.push("r"), timeoutMs: 1000 }], { tickMs: 5 });
    await sleep(40);
    await s.stop();
    expect(runs).toEqual(["r"]);
    expect(db.prepare("SELECT type, state, run_key FROM jobs").all()).toEqual([{ type: "t", state: "done", run_key: "k1" }]);
  });

  it("a job with no key is not due", async () => {
    let runs = 0;
    const s = startScheduler(db, [{ type: "t", key: () => null, run: async () => void runs++, timeoutMs: 1000 }], { tickMs: 5 });
    await sleep(30);
    await s.stop();
    expect(runs).toBe(0);
  });

  it("a failing job is recorded failed and its key runs again", async () => {
    let runs = 0;
    const s = startScheduler(db, [{ type: "t", key: () => "k1", run: async () => { runs++; throw new Error("boom"); }, timeoutMs: 1000 }], { tickMs: 5, retryMs: 0 });
    await sleep(40);
    await s.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(db.prepare("SELECT DISTINCT state FROM jobs").all()).toEqual([{ state: "failed" }]);
  });

  it("a key that failed waits before it runs again, twice as long after each failure", async () => {
    let at = Date.parse("2026-10-28T10:00:00Z");
    let runs = 0;
    const s = startScheduler(db, [{ type: "t", key: () => "k1", run: async () => { runs++; throw new Error("boom"); }, timeoutMs: 1000 }], { tickMs: 5, now: () => new Date(at) });
    const after = async (minutes: number) => {
      at += minutes * 60_000;
      await sleep(25);
    };
    await after(0);
    expect(runs).toBe(1);
    await after(14);
    expect(runs).toBe(1);
    await after(1); // 15 min after the first failure
    expect(runs).toBe(2);
    await after(29);
    expect(runs).toBe(2);
    await after(1); // 30 min after the second
    expect(runs).toBe(3);
    await s.stop();
  });

  it("never starts a job still running; a job past its timeout is failed and runs again", async () => {
    let runs = 0;
    const s = startScheduler(db, [{ type: "hang", key: () => "k1", run: () => (runs++, new Promise(() => {})), timeoutMs: 20 }], { tickMs: 5, retryMs: 0 });
    await sleep(15);
    expect(runs).toBe(1);
    await sleep(40);
    await s.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(db.prepare("SELECT state FROM jobs ORDER BY id LIMIT 1").get()).toEqual({ state: "failed" });
  });

  it("a run left running by a crashed process is failed at start, so its key can run", async () => {
    db.prepare("INSERT INTO jobs (type, state, run_key, started_at) VALUES ('t', 'running', 'k1', '2026-10-27T00:00:00Z')").run();
    let runs = 0;
    const s = startScheduler(db, [{ type: "t", key: () => "k1", run: async () => void runs++, timeoutMs: 1000 }], { tickMs: 5, retryMs: 0 });
    await sleep(30);
    await s.stop();
    expect(runs).toBe(1);
    expect(db.prepare("SELECT state FROM jobs ORDER BY id").all()).toEqual([{ state: "failed" }, { state: "done" }]);
  });
});
