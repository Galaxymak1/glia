import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { checks, type InitEnv, type InitIo, type InitOptions, runInit } from "../src/init.js";
import { writeSource } from "../src/sources.js";
import { search } from "../src/search.js";
import { tmpDir } from "./helpers.js";

const MODEL = "hf.co/gpustack/bge-m3-GGUF:Q8_0";
let home: string;
let ollama: "down" | "no-model" | "ready";
let pulled: string[];
let spawned: string[][];
let written: string[];
let mcpList: string;
let unitActive: boolean;
let said: string[];

const jsonl = (text: string) => JSON.stringify({ type: "user", uuid: "u1", text });

function makeEnv(over: Partial<InitEnv> = {}): InitEnv {
  const dataDir = join(home, ".local/share/glia");
  const configPath = join(home, ".config/glia/config.json");
  const dbPath = join(dataDir, "glia.db");
  const projectsDir = join(home, ".claude/projects");
  const fsReal = {
    exists: (p: string) => {
      try {
        readFileSync(p);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EISDIR" || isDir(p);
      }
    },
    read: (p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    write: (p: string, c: string, mode?: number) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c, mode ? { mode } : undefined);
      written.push(p);
    },
    remove: () => {},
    list: (p: string) => (readdir(p) ?? []).map((name) => ({ name, mtime: new Date("2026-10-20T00:00:00Z") })),
  };
  return {
    platform: "linux",
    home,
    nodeVersion: "22.22.2",
    dbPath,
    configPath,
    projectsDir,
    gliaArgv: ["/usr/bin/glia"],
    which: (c) => (c === "claude" ? "/usr/bin/claude" : null),
    fetch: (async (url: string, init?: RequestInit) => {
      if (ollama === "down") throw new Error("ECONNREFUSED");
      if (url.endsWith("/api/version")) return new Response("{}");
      if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: ollama === "ready" ? [{ name: MODEL }] : [] }));
      if (url.endsWith("/api/pull")) {
        pulled.push(JSON.parse(String(init?.body)).model);
        ollama = "ready";
        return new Response('{"status":"pulling","completed":1000000,"total":2000000}\n{"status":"success"}\n');
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
    run: async (argv) => {
      spawned.push(argv);
      if (argv[0] === "claude" && argv[2] === "add") mcpList = "glia: /usr/bin/glia mcp - ✓ Connected";
      if (argv.includes("enable")) unitActive = true;
      return 0;
    },
    query: async (argv) => {
      if (argv.slice(0, 3).join(" ") === "claude mcp list") return { code: 0, stdout: mcpList };
      if (argv.slice(0, 3).join(" ") === "claude plugin list") return { code: 0, stdout: "" };
      return null;
    },
    fs: fsReal,
    loadConfig: () => loadConfig(configPath),
    openDb: () => openDb(dbPath),
    ingest: async () => {
      const db = openDb(dbPath);
      writeSource(
        db,
        { kind: "cc", external_id: "s1", title: "t", project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: "a", parser_version: "t" },
        [{ externalUuid: "u1", parentUuid: null, role: "user", ts: "2026-10-20T10:00:01Z", text: "we decided on postgresql for the fixtureword database", isSidechain: false, isInjected: false }],
      );
      db.close();
    },
    hasApiKey: () => false,
    inProcess: { available: async () => false, modelPath: join(dataDir, "models/bge-m3-Q8_0.gguf"), download: async () => {} },
    service: {
      platform: "linux",
      cli: ["/usr/bin/glia"],
      home,
      uid: 1000,
      read: (p) => fsReal.read(p),
      write: (p, c) => fsReal.write(p, c),
      remove: () => {},
      run: async (argv) => {
        spawned.push(argv);
        if (argv.includes("is-active")) return unitActive ? 0 : 1;
        if (argv.includes("enable")) unitActive = true;
        return 0;
      },
    },
    ...over,
  };
}
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const readdir = (p: string) => (isDir(p) ? readdirSync(p) : null);

const yesIo = (): InitIo => ({ confirm: async () => true, choose: async () => [], say: (s) => said.push(s) });
const yesOpts: InitOptions = { yes: true, dryRun: false, exclude: [], noService: false };
const mutating = () => spawned.filter((a) => !a.includes("is-active"));
const outsideGlia = () => written.filter((p) => !p.startsWith(join(home, ".local/share/glia")) && !p.startsWith(join(home, ".config/glia")));

beforeEach(() => {
  home = tmpDir("glia-init-");
  ollama = "ready";
  pulled = [];
  spawned = [];
  written = [];
  said = [];
  mcpList = "";
  unitActive = false;
  mkdirSync(join(home, ".claude/projects/-home-me-work-acme"), { recursive: true });
  mkdirSync(join(home, ".claude/projects/-home-me-dev-glia"), { recursive: true });
  writeFileSync(join(home, ".claude/projects/-home-me-dev-glia/a.jsonl"), jsonl("x"));
});

describe("runInit", () => {
  it("a fresh install runs every step in order and ends ready", async () => {
    const env = makeEnv();
    const r = await runInit(env, yesIo(), { ...yesOpts, exclude: ["-home-me-work-*"] });
    expect(r.filter((c) => !c.ok)).toEqual([]);
    expect(spawned.map((a) => a.join(" "))).toEqual(expect.arrayContaining([expect.stringMatching(/systemctl --user enable --now/), "claude mcp add --scope user glia -- /usr/bin/glia mcp"]));
    expect(JSON.parse(readFileSync(env.configPath, "utf8")).claudeCode.exclude).toEqual(["-home-me-work-*"]);
    expect(said.join("\n")).toMatch(/Ready: 1 sources, 1 turns searchable now\. Try: glia search "\w+"/);
    expect(statSync(env.configPath).mode & 0o777).toBe(0o600);
  });

  it("asks at most two questions and is searchable before anything is embedded", async () => {
    const asked: string[] = [];
    const io: InitIo = { confirm: async (q) => (asked.push(q), true), choose: async (q, items) => (asked.push(q), items.length ? [0] : []), say: (s) => said.push(s) };
    const env = makeEnv();
    await runInit(env, io, { yes: false, dryRun: false, exclude: [], noService: true });
    expect(asked.length).toBeLessThanOrEqual(2);
    expect(JSON.parse(readFileSync(env.configPath, "utf8")).claudeCode.exclude).toEqual(["-home-me-dev-glia"]);
    const db = openDb(env.dbPath);
    expect((await search(db, null, "fixtureword", { limit: 5 })).hits.length).toBeGreaterThan(0);
    expect(db.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 0 });
    db.close();
    expect(said.join("\n")).toMatch(/searchable now\. Try: glia search/);
    // No daemon was installed (noService): nobody builds the index in the background.
    expect(said.join("\n")).toContain("Run: glia index to build meaning search");
    expect(said.join("\n")).not.toContain("builds in the background");
  });

  it("--dry-run writes nothing and runs nothing", async () => {
    await runInit(makeEnv(), yesIo(), { ...yesOpts, dryRun: true });
    expect(written).toEqual([]);
    expect(mutating()).toEqual([]);
    expect(said.join("\n")).toMatch(/glia will:/);
  });

  it("second run changes nothing", async () => {
    const env = makeEnv();
    await runInit(env, yesIo(), yesOpts);
    spawned = [];
    written = [];
    said = [];
    await runInit(env, yesIo(), yesOpts);
    expect(written).toEqual([]);
    expect(mutating()).toEqual([]);
    expect(said.join("\n")).toMatch(/Nothing changed/);
  });

  it("resumes after a failed step", async () => {
    const env = makeEnv();
    ollama = "down";
    const first = await runInit(env, yesIo(), yesOpts);
    expect(first.find((c) => c.id === "embeddings")).toMatchObject({ ok: true, detail: expect.stringMatching(/keyword-only/) });
    ollama = "no-model";
    await runInit(env, yesIo(), yesOpts);
    expect(pulled).toEqual([MODEL]);
    expect(spawned.filter((a) => a[2] === "add")).toHaveLength(1);
    expect(spawned.filter((a) => a.includes("enable"))).toHaveLength(1);
  });

  it("without --yes, nothing outside glia's folders is written unless confirmed", async () => {
    const env = makeEnv();
    const no: InitIo = { confirm: async () => false, choose: async () => [], say: (s) => said.push(s) };
    await runInit(env, no, { ...yesOpts, yes: false });
    expect(outsideGlia()).toEqual([]);
    expect(mutating()).toEqual([]);
  });

  it("stops on an old Node with the fix", async () => {
    const r = await runInit(makeEnv({ nodeVersion: "20.11.0" }), yesIo(), yesOpts);
    expect(r.find((c) => c.id === "node")).toMatchObject({ ok: false, fix: "Node 22 or later is needed; you have 20.11.0" });
    expect(written).toEqual([]);
  });

  it("refuses to go on when the old and new folders both exist", async () => {
    mkdirSync(join(home, ".local/share/ai_second_brain"), { recursive: true });
    mkdirSync(join(home, ".local/share/glia"), { recursive: true });
    const r = await runInit(makeEnv(), yesIo(), yesOpts);
    expect(r.find((c) => c.id === "legacy")!.ok).toBe(false);
    expect(written).toEqual([]);
  });

  it("a Claude Desktop config with other servers keeps them", async () => {
    const path = join(home, ".config/Claude/claude_desktop_config.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "o" } } }));
    await runInit(makeEnv({ which: () => null }), yesIo(), yesOpts);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers).sort()).toEqual(["glia", "other"]);
  });
});

describe("checks (glia doctor)", () => {
  it("prints the fix for each broken check", async () => {
    const env = makeEnv();
    await runInit(env, yesIo(), yesOpts);
    ollama = "down";
    unitActive = false;
    const cs = await checks(env);
    expect(cs.filter((c) => !c.ok).map((c) => [c.id, c.fix])).toEqual([["service", "Run: glia daemon install"]]);
    expect(cs.find((c) => c.id === "embeddings")).toMatchObject({ ok: true, fix: "Install Ollama from https://ollama.com/download, then run: glia init" });
  });

  it("reports the meaning index progress without failing", async () => {
    const env = makeEnv();
    await runInit(env, yesIo(), yesOpts);
    expect(await checks(env)).toContainEqual({ id: "index", ok: true, detail: "meaning index: 1 turns still to embed (the daemon is building it)" });
  });

  it("a missing model is a failure with the pull command", async () => {
    ollama = "no-model";
    expect((await checks(makeEnv())).find((c) => c.id === "embeddings")).toMatchObject({ ok: false, fix: `Run: ollama pull ${MODEL}` });
  });
});

describe("in-process embeddings", () => {
  function inProcessEnv() {
    const env = makeEnv();
    const downloads: string[] = [];
    env.inProcess = {
      available: async () => true,
      modelPath: join(home, ".local/share/glia/models/bge-m3-Q8_0.gguf"),
      download: async () => {
        downloads.push("model");
        env.fs.write(join(home, ".local/share/glia/models/bge-m3-Q8_0.gguf"), "gguf");
      },
    };
    return { env, downloads };
  }

  it("downloads the model once and never asks Ollama", async () => {
    ollama = "down";
    const { env, downloads } = inProcessEnv();
    const r = await runInit(env, yesIo(), yesOpts);
    expect(r.find((c) => c.id === "embeddings")).toMatchObject({ ok: true, detail: expect.stringMatching(/in-process/) });
    expect(downloads).toEqual(["model"]);
    expect(pulled).toEqual([]);
    await runInit(env, yesIo(), yesOpts);
    expect(downloads).toEqual(["model"]);
  });

  it("a missing model file is a failed check that init fixes", async () => {
    const { env } = inProcessEnv();
    const before = await checks(env);
    expect(before.find((c) => c.id === "embeddings")).toMatchObject({ ok: false, fix: "Run: glia init" });
  });

  it("provider ollama keeps the Ollama path", async () => {
    const { env } = inProcessEnv();
    env.loadConfig = () => ({ claudeCode: { exclude: [] }, embedding: { provider: "ollama" } });
    expect((await checks(env)).find((c) => c.id === "embeddings")).toMatchObject({ ok: true, detail: expect.stringMatching(/Ollama/) });
  });
});
