import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { acquireLock, daemonLogger, localJobs, pendingIndex, runOnce, type SpawnJob, spawnJob } from "../src/daemon.js";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { startScheduler } from "../src/scheduler.js";
import { writeSource } from "../src/sources.js";
import { buildIndex } from "../src/vectors.js";
import { tmpDir, VectorEmbedder } from "./helpers.js";

let db: ReturnType<typeof openDb>;
let dir: string;
const config: Config = { claudeCode: { exclude: [] }, embedding: { model: "fake@1" } };
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  dir = tmpDir("glia-daemon-");
});
afterEach(() => db.close());

const ok: SpawnJob = async () => ({ code: 0, stdout: "", stderr: "" });
const ctx = () => ({ cli: ["node", "cli.js"], db, dbPath: "/d/glia.db", config, hasApiKey: () => true, spawnJob: ok });
function insertUnembeddedTurn() {
  writeSource(
    db,
    { kind: "cai", external_id: "s1", title: "t", project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "raw", raw_sha256: "abc", parser_version: "test" },
    [{ externalUuid: "u1", parentUuid: null, role: "user", ts: "2026-10-20T10:00:01Z", text: "we chose SQLite", isSidechain: false, isInjected: false }],
  );
}
const at0215 = new Date("2026-10-27T01:15:00Z");
const at0100 = new Date("2026-10-27T00:00:00Z");

describe("localJobs", () => {
  it("indexes while anything is pending, and not once nothing is", async () => {
    const calls: string[] = [];
    const spawn: SpawnJob = async (argv) => (calls.push(argv.slice(2).join(" ")), { code: 0, stdout: "", stderr: "" });
    insertUnembeddedTurn();
    expect(pendingIndex(db, "fake@1")).toBe(1);
    await runOnce(localJobs({ ...ctx(), spawnJob: spawn, hasApiKey: () => false }));
    expect(calls).toEqual([expect.stringMatching(/^ingest .* --db \/d\/glia\.db$/), "index --db /d/glia.db", "index --claims --db /d/glia.db"]);
    await buildIndex(db, new VectorEmbedder());
    expect(pendingIndex(db, "fake@1")).toBe(0);
    calls.length = 0;
    await runOnce(localJobs({ ...ctx(), spawnJob: spawn, hasApiKey: () => false }));
    expect(calls).toEqual([expect.stringMatching(/^ingest /)]);
  });

  it("vectors from another model count as pending", async () => {
    insertUnembeddedTurn();
    await buildIndex(db, new VectorEmbedder({}, "other@1"));
    expect(pendingIndex(db, "fake@1")).toBe(1);
  });

  it("no API key: no extraction job", () => {
    const submit = (hasApiKey: () => boolean) => localJobs({ ...ctx(), hasApiKey }).find((j) => j.type === "extract_submit")!;
    expect(submit(() => false).key(at0215)).toBeNull();
    expect(submit(() => true).key(at0215)).toBe("2026-10-27");
    expect(submit(() => true).key(at0100)).toBeNull();
  });

  it("polls only while an extraction batch is running", () => {
    const poll = () => localJobs(ctx()).find((j) => j.type === "extract_poll")!.key(at0215);
    expect(poll()).toBeNull();
    db.prepare("INSERT INTO jobs (type, state, batch_id) VALUES ('extract', 'running', 'b1')").run();
    expect(poll()).toBe("2026-10-27T02:15");
  });

  it("sweeps the configured folders", async () => {
    const calls: string[][] = [];
    const spawn: SpawnJob = async (argv) => (calls.push(argv), { code: 0, stdout: "", stderr: "" });
    await localJobs({ ...ctx(), config: { ...config, daemon: { paths: ["/a", "/b"] } }, spawnJob: spawn }).find((j) => j.type === "sweep")!.run();
    expect(calls).toEqual([["node", "cli.js", "ingest", "/a", "/b", "--db", "/d/glia.db"]]);
  });

  it("a child that exits non-zero fails the job with its stderr", async () => {
    const spawn: SpawnJob = async () => ({ code: 1, stdout: "", stderr: "glia: Ollama is not reachable\n" });
    await expect(localJobs({ ...ctx(), spawnJob: spawn }).find((j) => j.type === "sweep")!.run()).rejects.toThrow(/exited 1: glia: Ollama is not reachable/);
  });
});

describe("acquireLock", () => {
  it("second daemon refuses", () => {
    const pid = join(dir, "daemon.pid");
    const lock = acquireLock(pid);
    expect(readFileSync(pid, "utf8").trim()).toBe(String(process.pid));
    expect(() => acquireLock(pid)).toThrow(new RegExp(`glia daemon is already running \\(pid ${process.pid}\\)`));
    lock.release();
    expect(existsSync(pid)).toBe(false);
  });

  it("stale pid file is taken over", () => {
    const pid = join(dir, "daemon.pid");
    writeFileSync(pid, "999999");
    expect(() => acquireLock(pid).release()).not.toThrow();
  });
});

describe("spawnJob", () => {
  it("hung job is killed and retried", async () => {
    const hang = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
    const pids: number[] = [];
    let runs = 0;
    const job = {
      type: "hang",
      key: () => "k1",
      run: async () => {
        runs++;
        await spawnJob(hang, 200, (pid) => pids.push(pid));
      },
      timeoutMs: 200,
    };
    const s = startScheduler(db, [job], { tickMs: 20, retryMs: 0 });
    await new Promise((r) => setTimeout(r, 700));
    await s.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(db.prepare("SELECT state FROM jobs ORDER BY id LIMIT 1").get()).toEqual({ state: "failed" });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive(pids[0]!)).toBe(false);
  });

  it("returns the exit code and output", async () => {
    expect(await spawnJob([process.execPath, "-e", "console.log('hi'); process.exit(3)"], 5000)).toEqual({ code: 3, stdout: "hi\n", stderr: "" });
  });
});

describe("daemonLogger", () => {
  it("writes JSON lines and rotates past the size limit", () => {
    const path = join(dir, "daemon.log");
    const log = daemonLogger(path, 200);
    for (let i = 0; i < 10; i++) log({ level: "info", job: "sweep", state: "done", ms: i });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(200);
    const line = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!);
    expect(line).toMatchObject({ level: "info", job: "sweep", state: "done", ms: 9, ts: expect.stringMatching(/Z$/) });
  });
});
