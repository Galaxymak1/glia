// The real world behind InitEnv: this machine's files, processes and network, plus the terminal
// questions of `glia init`.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { anthropicApiKey, loadConfig } from "./config.js";
import { spawnJob } from "./daemon.js";
import { openDb } from "./db.js";
import { downloadModel, loadLlamaModule, modelPathFor } from "./embedLlama.js";
import type { InitEnv, InitIo } from "./init.js";
import type { Platform } from "./service.js";

const which = (cmd: string): string | null => {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
  }
  return null;
};

const run = (argv: string[]) =>
  new Promise<number>((done) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
  });

const query = (argv: string[]) =>
  new Promise<{ code: number; stdout: string } | null>((done) => {
    execFile(argv[0]!, argv.slice(1), { timeout: 15_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return done(null);
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout) });
    });
  });

export function realInitEnv(dbPath: string, configPath: string): InitEnv {
  const platform = process.platform as Platform;
  const home = homedir();
  const cli = [process.execPath, ...process.execArgv, resolve(process.argv[1]!)];
  // An installed glia is found on PATH by clients that do not share this shell; a checkout is run by path.
  const onPath = which("glia");
  const gliaArgv = onPath ? [onPath] : [process.execPath, resolve(process.argv[1]!)];
  const fs: InitEnv["fs"] = {
    exists: existsSync,
    read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    write: (p, content, mode) => {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, content, mode ? { mode } : undefined);
      if (mode) chmodSync(p, mode);
    },
    remove: (p) => rmSync(p, { force: true }),
    list: (p) => {
      try {
        return readdirSync(p).map((name) => ({ name, mtime: statSync(join(p, name)).mtime }));
      } catch {
        return [];
      }
    },
  };
  return {
    platform,
    home,
    nodeVersion: process.versions.node,
    dbPath,
    configPath,
    projectsDir: join(home, ".claude", "projects"),
    gliaArgv,
    APPDATA: process.env.APPDATA,
    which,
    fetch,
    run,
    query,
    fs,
    loadConfig: () => loadConfig(configPath),
    openDb: () => openDb(dbPath),
    ingest: async (paths) => {
      const r = await spawnJob([...cli, "ingest", ...paths, "--db", dbPath], 30 * 60_000);
      if (r.code !== 0) throw new Error(`glia ingest failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
      process.stdout.write(r.stdout);
    },
    inProcess: {
      available: () => loadLlamaModule().then(() => true, () => false),
      modelPath: modelPathFor(dirname(dbPath)),
      download: async (onProgress) => {
        await downloadModel(dirname(dbPath), onProgress);
      },
    },
    hasApiKey: () => {
      try {
        anthropicApiKey();
        return true;
      } catch {
        return false;
      }
    },
    service: {
      platform,
      cli,
      home,
      uid: process.getuid?.() ?? 0,
      read: fs.read,
      write: (p, c) => fs.write(p, c),
      remove: fs.remove,
      run: (argv) =>
        new Promise((done) => {
          const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
          child.on("error", () => done(127));
          child.on("close", (code) => done(code ?? 1));
        }),
    },
  };
}

/** Questions on the terminal; an input that ends before an answer takes the default. */
export function initTerminalIo(): InitIo {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => (closed = true));
  const ask = (q: string) => new Promise<string>((done) => (closed ? done("") : rl.question(q, done)));
  return {
    say: (s) => console.log(s),
    confirm: async (q, def) => {
      const a = (await ask(`${q} [${def ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
      return a === "" ? def : a.startsWith("y");
    },
    choose: async (q, items) => {
      console.log(q);
      items.forEach((item, i) => console.log(`  ${i + 1}. ${item}`));
      const a = (await ask("Numbers to leave out, comma-separated (Enter for none): ")).trim();
      return a
        .split(/[,\s]+/)
        .map((n) => Number(n) - 1)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < items.length);
    },
  };
}
