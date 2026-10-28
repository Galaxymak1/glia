// The clock behind `glia daemon` (and later the server): jobs fall due on Europe/Paris time, and
// every run is a row in `jobs`, so a key that already ran is never run twice.
import type Database from "better-sqlite3";
import { isoSeconds } from "./route.js";

const PARIS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The Paris calendar date, hour and minute of an instant. */
export function parisParts(d: Date): { date: string; hour: number; minute: number } {
  const p = Object.fromEntries(PARIS.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** The Paris `YYYY-MM-DDTHH:mm`, floored to 15 minutes: one key per quarter hour. */
export function every15(d: Date): string {
  const { date, hour, minute } = parisParts(d);
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute - (minute % 15)).padStart(2, "0")}`;
}

/**
 * Due once per Paris day, from `hour:minute` on: the key is the Paris date. On the night clocks
 * go forward the hour is skipped, and the first minute after it is already past, so the run is
 * never lost; on the night they go back the date is the same, so it never runs twice.
 */
export function dailyAt(hour: number, minute: number): (d: Date) => string | null {
  return (d) => {
    const p = parisParts(d);
    return p.hour > hour || (p.hour === hour && p.minute >= minute) ? p.date : null;
  };
}

const RETRY_MS = 15 * 60_000;
const MAX_RETRY_MS = 4 * 3_600_000;

export interface Job {
  type: string;
  /** The run this instant belongs to, or null when the job is not due. */
  key(now: Date): string | null;
  run(): Promise<void>;
  timeoutMs: number;
}

/**
 * Checks every job each `tickMs`. A job runs when its key is non-null and no `done` or `running`
 * row holds that key; a job still in flight is never started again. A run that throws, or outlives
 * `timeoutMs`, is recorded `failed`, and its key runs again `retryMs` later (15 minutes), twice as
 * long after each further failure, up to 4 hours: a job that keeps failing (a bad API key, an
 * unreadable file) is not run on every tick. Runs left `running` by a process that died are failed
 * at start.
 */
export function startScheduler(
  db: Database.Database,
  jobs: Job[],
  opts: { tickMs?: number; now?: () => Date; log?: (line: object) => void; retryMs?: number } = {},
): { stop(): Promise<void> } {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const types = jobs.map((j) => j.type);
  if (types.length) {
    db.prepare(`UPDATE jobs SET state = 'failed', finished_at = ? WHERE state = 'running' AND run_key IS NOT NULL AND type IN (${types.map(() => "?").join(",")})`).run(isoSeconds(now()), ...types);
  }
  const taken = db.prepare("SELECT 1 FROM jobs WHERE type = ? AND run_key = ? AND state IN ('done', 'running')");
  const failures = db.prepare("SELECT count(*) AS n, max(finished_at) AS last FROM jobs WHERE type = ? AND run_key = ? AND state = 'failed'");
  const retryMs = opts.retryMs ?? RETRY_MS;
  const waiting = (type: string, key: string, at: Date) => {
    const f = failures.get(type, key) as { n: number; last: string | null };
    if (!f.n || !f.last) return false;
    return at.getTime() - Date.parse(f.last) < Math.min(retryMs * 2 ** (f.n - 1), MAX_RETRY_MS);
  };
  const insert = db.prepare("INSERT INTO jobs (type, state, run_key, started_at) VALUES (?, 'running', ?, ?)");
  const finish = db.prepare("UPDATE jobs SET state = ?, finished_at = ? WHERE id = ?");
  const inFlight = new Map<string, Promise<void>>();
  let stopped = false;

  const start = (job: Job, key: string) => {
    const id = Number(insert.run(job.type, key, isoSeconds(now())).lastInsertRowid);
    const began = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${job.timeoutMs} ms`)), job.timeoutMs);
    });
    const done = Promise.race([Promise.resolve().then(() => job.run()), timeout]).then(
      () => {
        finish.run("done", isoSeconds(now()), id);
        log({ level: "info", job: job.type, key, state: "done", ms: Date.now() - began });
      },
      (err: unknown) => {
        finish.run("failed", isoSeconds(now()), id);
        log({ level: "error", job: job.type, key, state: "failed", ms: Date.now() - began, error: err instanceof Error ? err.message : String(err) });
      },
    ).finally(() => {
      clearTimeout(timer);
      inFlight.delete(job.type);
    });
    inFlight.set(job.type, done);
  };

  const tick = () => {
    if (stopped) return;
    const at = now();
    for (const job of jobs) {
      if (inFlight.has(job.type)) continue;
      const key = job.key(at);
      if (key === null || taken.get(job.type, key) || waiting(job.type, key, at)) continue;
      start(job, key);
    }
  };

  const interval = setInterval(tick, opts.tickMs ?? 60_000);
  setImmediate(tick);
  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
