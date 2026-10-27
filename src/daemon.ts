// `glia daemon`: the local jobs on their own clock. Each job runs as a child `glia` process, so a
// job that crashes or hangs is killed and recorded, and the daemon keeps going.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { type Config, embeddingSettings } from "./config.js";
import { dailyAt, every15, type Job } from "./scheduler.js";
import { defaultTranscriptsDir } from "./scan.js";
import { indexStatus } from "./vectors.js";

export type SpawnJob = (argv: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const KILL_GRACE_MS = 5_000;
const MINUTE = 60_000;

/**
 * Runs `argv` and collects its output. Past `timeoutMs` the child gets SIGTERM, then SIGKILL after
 * 5 s, and the promise rejects.
 */
export function spawnJob(argv: string[], timeoutMs: number, onSpawn?: (pid: number) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid !== undefined) onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      kill.unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (kill) clearTimeout(kill);
      if (timedOut) reject(new Error(`${argv.slice(-4).join(" ")}: killed after ${timeoutMs} ms`));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Turns the meaning index has not embedded with `model` yet, plus claims with no vector from it. */
export function pendingIndex(db: Database.Database, model: string): number {
  const s = indexStatus(db, model);
  const claims = db
    .prepare("SELECT count(*) AS n FROM claims c WHERE NOT EXISTS (SELECT 1 FROM claims_vec v WHERE v.claim_n = c.n AND v.model = ?)")
    .get(model) as { n: number };
  return s.missing + s.otherModel + claims.n;
}

export interface LocalJobsContext {
  /** How to run glia itself: [process.execPath, ...execArgv, cliPath]. */
  cli: string[];
  db: Database.Database;
  dbPath: string;
  config: Config;
  hasApiKey: () => boolean;
  spawnJob?: SpawnJob;
}

/** The jobs of one machine, in the order they run within a tick: a sweep is indexed in the same tick. */
export function localJobs(ctx: LocalJobsContext): Job[] {
  const run = ctx.spawnJob ?? ((argv, timeoutMs) => spawnJob(argv, timeoutMs));
  const glia = async (args: string[], timeoutMs: number) => {
    const r = await run([...ctx.cli, ...args, "--db", ctx.dbPath], timeoutMs);
    if (r.code !== 0) throw new Error(`glia ${args[0]} exited ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  };
  const paths = ctx.config.daemon?.paths ?? [defaultTranscriptsDir()];
  const { model } = embeddingSettings(ctx.config);
  const extractRunning = ctx.db.prepare("SELECT 1 FROM jobs WHERE type = 'extract' AND state = 'running' LIMIT 1");
  const submitAt = dailyAt(2, 0);
  const job = (type: string, timeoutMs: number, key: Job["key"], steps: string[][]): Job => ({
    type,
    key,
    timeoutMs,
    run: async () => {
      for (const args of steps) await glia(args, timeoutMs);
    },
  });
  return [
    job("sweep", 30 * MINUTE, every15, [["ingest", ...paths]]),
    job("index", 60 * MINUTE, (now) => (pendingIndex(ctx.db, model) > 0 ? every15(now) : null), [["index"], ["index", "--claims"]]),
    job("extract_submit", 10 * MINUTE, (now) => (ctx.hasApiKey() ? submitAt(now) : null), [["extract"]]),
    job("extract_poll", 30 * MINUTE, (now) => (extractRunning.get() ? every15(now) : null), [["extract", "poll"]]),
  ];
}

/** Every due job once, in order, without the scheduler's records: `glia daemon --once`. */
export async function runOnce(jobs: Job[], now = () => new Date()): Promise<{ type: string; error?: string }[]> {
  const ran: { type: string; error?: string }[] = [];
  for (const j of jobs) {
    if (j.key(now()) === null) continue;
    try {
      await j.run();
      ran.push({ type: j.type });
    } catch (err) {
      ran.push({ type: j.type, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return ran;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** One daemon per machine: the pid file names it. A file left by a daemon that died is taken over. */
export function acquireLock(pidPath: string): { release(): void } {
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) throw new Error(`glia daemon is already running (pid ${pid})`);
    if (pid === process.pid) throw new Error(`glia daemon is already running (pid ${pid})`);
  }
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
  return {
    release() {
      try {
        if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) unlinkSync(pidPath);
      } catch {
        // already gone
      }
    },
  };
}

/** JSON lines with a timestamp; past `maxBytes` the file becomes `<path>.1`, replacing the old one. */
export function daemonLogger(path: string, maxBytes = 5 * 1024 * 1024): (line: object) => void {
  return (line) => {
    const text = `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`;
    if (existsSync(path) && statSync(path).size + text.length > maxBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, text, { mode: 0o600 });
  };
}
