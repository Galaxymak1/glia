// `glia init` and `glia doctor`. The checks are read-only and shared: doctor prints them, init
// runs the steps whose check fails and checks again. Everything the outside world offers (the
// file system, Ollama, the service manager, the ingest itself) comes in through InitEnv.
import { dirname, join } from "node:path";
import { type Client, detectClients, registrationPlan } from "./clients.js";
import { type Config, embeddingSettings } from "./config.js";
import { DEFAULT_EMBED_MODEL } from "./embed.js";
import type Database from "better-sqlite3";
import { migrate, migrations, schemaVersion } from "./migrations.js";
import { installService, type Platform, serviceActive, type ServiceDeps } from "./service.js";
import { desktopConfigPath } from "./clients.js";

export interface Check {
  id: "node" | "legacy" | "database" | "embeddings" | "config" | "clients" | "service" | "first-run" | "index";
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface InitEnv {
  platform: Platform;
  home: string;
  nodeVersion: string;
  dbPath: string;
  configPath: string;
  /** Where Claude Code keeps its transcripts. */
  projectsDir: string;
  /** How to start glia (without a command), for the MCP registrations. */
  gliaArgv: string[];
  APPDATA?: string;
  which(cmd: string): string | null;
  fetch: typeof fetch;
  /** A command that changes something. */
  run(argv: string[]): Promise<number>;
  /** A command that only reads; null when it cannot run. */
  query(argv: string[]): Promise<{ code: number; stdout: string } | null>;
  fs: {
    exists(p: string): boolean;
    read(p: string): string | null;
    /** Creates the folder; `mode` applies to the file. */
    write(p: string, content: string, mode?: number): void;
    remove(p: string): void;
    /** Names and modification times of the entries of a folder. */
    list(p: string): { name: string; mtime: Date }[];
  };
  /** The configuration as the file holds it (defaults when absent). */
  loadConfig(): Config;
  openDb(): Database.Database;
  /** The first ingest of the given folders. */
  ingest(paths: string[]): Promise<void>;
  hasApiKey(): boolean;
  /** BGE-M3 inside glia's own process, when node-llama-cpp can be loaded. */
  inProcess: { available(): Promise<boolean>; modelPath: string; download(onProgress: (done: number, total: number) => void): Promise<void> };
  service: ServiceDeps;
}

export interface InitIo {
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Indexes of the items chosen; none by default. */
  choose(question: string, items: string[]): Promise<number[]>;
  say(s: string): void;
}

export interface InitOptions {
  yes: boolean;
  dryRun: boolean;
  exclude: string[];
  noService: boolean;
}

const OLLAMA_INSTALL = "Install Ollama from https://ollama.com/download, then run: glia init";

/** What Ollama says about itself: reachable, and holding the model or not. */
async function ollamaState(env: InitEnv, url: string, model: string): Promise<"down" | "no-model" | "ready"> {
  try {
    const signal = AbortSignal.timeout(2000);
    const version = await env.fetch(`${url}/api/version`, { signal });
    if (!version.ok) return "down";
    const tags = (await (await env.fetch(`${url}/api/tags`, { signal })).json()) as { models?: { name: string; model?: string }[] };
    const names = (tags.models ?? []).flatMap((m) => [m.name, m.model ?? ""]);
    return names.some((n) => n === model || n === `${model}:latest`) ? "ready" : "no-model";
  } catch {
    return "down";
  }
}

const legacyPairs = (env: InitEnv): [string, string][] =>
  [dirname(env.dbPath), dirname(env.configPath)]
    .filter((d) => d.endsWith("/glia") || d.endsWith("\\glia"))
    .map((d) => [join(dirname(d), "ai_second_brain"), d] as [string, string])
    .filter(([old, now]) => env.fs.exists(old) && env.fs.exists(now));

const clientConfigPath = (env: InitEnv) => desktopConfigPath(env.platform, env.home, env);

async function pluginEnabled(env: InitEnv): Promise<boolean> {
  const r = await env.query(["claude", "plugin", "list"]);
  return !!r && r.stdout.split("\n").some((l) => /\bglia@/.test(l) && !/disabled/i.test(l));
}

/** The registration each detected client still needs, as (client, plan) pairs. */
async function pendingClients(env: InitEnv) {
  const pending: { client: Client; plan: ReturnType<typeof registrationPlan> }[] = [];
  const found = detectClients({ platform: env.platform, home: env.home, which: env.which, exists: env.fs.exists, APPDATA: env.APPDATA });
  for (const client of found) {
    if (client === "claude-code") {
      if (await pluginEnabled(env)) continue;
      const list = await env.query(["claude", "mcp", "list"]);
      const plan = registrationPlan(client, env.gliaArgv, list?.stdout ?? null);
      if (plan.kind !== "ok") pending.push({ client, plan });
    } else {
      const path = clientConfigPath(env);
      const plan = registrationPlan(client, env.gliaArgv, env.fs.read(path), path);
      if (plan.kind !== "ok") pending.push({ client, plan });
    }
  }
  return pending;
}

/** Read-only: what is set up and what is not, with the fix for each gap. */
export async function checks(env: InitEnv): Promise<Check[]> {
  const out: Check[] = [];
  const major = Number(env.nodeVersion.split(".")[0]);
  out.push(major >= 22 ? { id: "node", ok: true, detail: `Node ${env.nodeVersion}` } : { id: "node", ok: false, detail: `Node ${env.nodeVersion}`, fix: `Node 22 or later is needed; you have ${env.nodeVersion}` });

  const conflicts = legacyPairs(env);
  out.push(
    conflicts.length
      ? { id: "legacy", ok: false, detail: `both ${conflicts[0]![0]} and ${conflicts[0]![1]} exist`, fix: `Both ${conflicts[0]![0]} and ${conflicts[0]![1]} exist: keep one, then run glia doctor` }
      : { id: "legacy", ok: true, detail: "no folders from before the rename" },
  );

  let db: Database.Database | null = null;
  if (env.fs.exists(env.dbPath)) {
    db = env.openDb();
    if (schemaVersion(db) !== migrations.at(-1)!.version) {
      db.close();
      db = null;
    }
  }
  out.push(db ? { id: "database", ok: true, detail: env.dbPath } : { id: "database", ok: false, detail: "no database yet, or it needs a migration", fix: "Run: glia init" });

  const config = env.loadConfig();
  const { url, model } = embeddingSettings(config);
  const inProcess = config.embedding?.provider !== "ollama" && model === DEFAULT_EMBED_MODEL && (await env.inProcess.available());
  const ollama = inProcess ? "down" : await ollamaState(env, url, model);
  out.push(
    inProcess
      ? env.fs.exists(env.inProcess.modelPath)
        ? { id: "embeddings", ok: true, detail: "meaning search in-process (no Ollama needed)" }
        : { id: "embeddings", ok: false, detail: "the embedding model (634 MB) is not downloaded yet", fix: "Run: glia init" }
      : ollama === "ready"
      ? { id: "embeddings", ok: true, detail: `meaning search through Ollama (${model})` }
      : ollama === "no-model"
        ? { id: "embeddings", ok: false, detail: `Ollama is running without ${model}`, fix: `Run: ollama pull ${model}` }
        : { id: "embeddings", ok: true, detail: "keyword-only search (no Ollama)", fix: OLLAMA_INSTALL },
  );

  out.push(env.fs.exists(env.configPath) ? { id: "config", ok: true, detail: env.configPath } : { id: "config", ok: false, detail: "no config file yet", fix: "Run: glia init" });

  const pending = await pendingClients(env);
  out.push(
    pending.length
      ? { id: "clients", ok: false, detail: `not registered in ${pending.map((p) => p.client).join(", ")}`, fix: "Run: glia init" }
      : { id: "clients", ok: true, detail: "registered in every client found" },
  );

  out.push((await serviceActive(env.service)) ? { id: "service", ok: true, detail: "glia daemon is running" } : { id: "service", ok: false, detail: "glia daemon is not running", fix: "Run: glia daemon install" });

  let sources = 0;
  let turns = 0;
  let pendingIndex = 0;
  if (db) {
    sources = (db.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n;
    turns = (db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number }).n;
    pendingIndex = (db.prepare("SELECT count(*) AS n FROM turns t WHERE t.is_injected = 0 AND trim(t.text) <> '' AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.turn_id = t.id)").get() as { n: number }).n;
    db.close();
  }
  const hasHistory = env.fs.exists(env.projectsDir) && env.fs.list(env.projectsDir).length > 0;
  out.push(
    sources > 0 || !hasHistory
      ? { id: "first-run", ok: true, detail: sources > 0 ? `${sources} sources, ${turns} turns` : "no Claude Code history yet" }
      : { id: "first-run", ok: false, detail: "nothing ingested yet", fix: "Run: glia init" },
  );
  out.push({ id: "index", ok: true, detail: !inProcess && ollama !== "ready" ? "meaning index off (no Ollama)" : pendingIndex ? `meaning index: ${pendingIndex} turns still to embed (the daemon is building it)` : "meaning index: complete" });
  return out;
}

const folderItems = (env: InitEnv) =>
  env.fs
    .list(env.projectsDir)
    .map((e) => {
      const sessions = env.fs.list(join(env.projectsDir, e.name)).filter((f) => f.name.endsWith(".jsonl")).length;
      return { name: e.name, label: `${e.name}  (${sessions} sessions, last ${e.mtime.toISOString().slice(0, 10)})` };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

const mb = (n: number) => (n / 1e6).toFixed(0);

async function pullModel(env: InitEnv, url: string, model: string, say: (s: string) => void): Promise<void> {
  const res = await env.fetch(`${url}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }) });
  if (!res.ok || !res.body) throw new Error(`ollama pull ${model}: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buf = "";
  let last = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = JSON.parse(line) as { status?: string; error?: string; completed?: number; total?: number };
      if (m.error) throw new Error(`ollama pull ${model}: ${m.error}`);
      if (m.total && m.completed !== undefined && Date.now() - last > 2000) {
        last = Date.now();
        say(`  pulling ${model}: ${mb(m.completed)} / ${mb(m.total)} MB`);
      }
    }
  }
}

/**
 * Sets up whatever `checks` finds missing, in order, asking at most two questions: which projects
 * to leave out, then one confirmation of the whole plan. Each step runs only if its check fails.
 */
export async function runInit(env: InitEnv, io: InitIo, opts: InitOptions): Promise<Check[]> {
  const before = await checks(env);
  const failing = new Set(before.filter((c) => !c.ok).map((c) => c.id));
  if (failing.has("node") || failing.has("legacy")) {
    for (const c of before.filter((c) => !c.ok)) io.say(`✗ ${c.fix}`);
    return before;
  }
  const pending = await pendingClients(env);
  const config0 = env.loadConfig();
  const todo: string[] = [];
  if (failing.has("database")) todo.push("create or migrate the database");
  const inProcess = config0.embedding?.provider !== "ollama" && embeddingSettings(config0).model === DEFAULT_EMBED_MODEL && (await env.inProcess.available());
  if (failing.has("embeddings")) todo.push(inProcess ? "download the embedding model (634 MB)" : "pull the embedding model through Ollama");
  if (failing.has("config")) todo.push(`write ${env.configPath}`);
  for (const p of pending) todo.push(p.plan.kind === "edit" ? `edit ${p.plan.path} to add glia` : p.plan.kind === "commands" ? `run: ${p.plan.argv.map((a) => a.join(" ")).join("; ")}` : `show how to add glia to ${p.client}`);
  if (failing.has("first-run")) todo.push(`ingest ${env.projectsDir}`);
  if (failing.has("service") && !opts.noService) todo.push("start glia daemon at login");
  if (!todo.length) {
    io.say("Everything is already set up. Nothing changed.");
    return before;
  }

  let exclude = [...opts.exclude];
  if (failing.has("config") && !opts.yes && !opts.dryRun && env.fs.exists(env.projectsDir)) {
    const items = folderItems(env);
    if (items.length) {
      const picked = await io.choose("Projects glia should never store (client or employer work):", items.map((i) => i.label));
      exclude = [...new Set([...exclude, ...picked.map((i) => items[i]!.name)])];
    }
  }
  // What the question would have offered, for whoever picks the exclusions from the plan (/glia:setup).
  if (failing.has("config") && opts.dryRun && env.fs.exists(env.projectsDir)) {
    const items = folderItems(env);
    if (items.length) io.say(`Claude Code projects found (--exclude <name> leaves one out):\n${items.map((i) => `  - ${i.label}`).join("\n")}`);
  }
  io.say(`glia will:\n${todo.map((t) => `  - ${t}`).join("\n")}`);
  if (!opts.dryRun) io.say("(a few minutes, mostly the one-time model download)");
  if (opts.dryRun) return before;
  if (!opts.yes && !(await io.confirm("Go ahead?", true))) {
    io.say("Nothing changed.");
    return before;
  }

  const config = env.loadConfig();
  const { url, model } = embeddingSettings(config);
  if (failing.has("database")) {
    const db = env.openDb();
    try {
      migrate(db);
    } finally {
      db.close();
    }
  }
  if (failing.has("embeddings")) {
    if (inProcess) {
      let lastTenth = -1;
      await env.inProcess.download((done, total) => {
        const tenth = total ? Math.floor((done / total) * 10) : 0;
        if (tenth > lastTenth) {
          lastTenth = tenth;
          io.say(`  downloading the embedding model: ${tenth * 10}% (${mb(done)} / ${mb(total)} MB)`);
        }
      });
    } else await pullModel(env, url, model, io.say);
  }
  if (failing.has("config")) {
    const existing = env.fs.read(env.configPath);
    const merged = existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
    const claudeCode = { ...((merged.claudeCode as Record<string, unknown> | undefined) ?? {}) };
    claudeCode.exclude = [...new Set([...((claudeCode.exclude as string[] | undefined) ?? []), ...exclude])];
    env.fs.write(env.configPath, `${JSON.stringify({ ...merged, claudeCode }, null, 2)}\n`, 0o600);
  }
  for (const { client, plan } of pending) {
    if (plan.kind === "commands") for (const argv of plan.argv) await env.run(argv);
    else if (plan.kind === "edit") env.fs.write(plan.path, plan.next);
    else if (plan.kind === "manual") io.say(`${client}: ${plan.why}\nAdd this by hand:\n${plan.snippet}`);
  }
  if (failing.has("first-run")) {
    await env.ingest(env.loadConfig().daemon?.paths ?? [env.projectsDir]);
    const db = env.openDb();
    try {
      const sources = (db.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n;
      const turns = (db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number }).n;
      const word = (db.prepare("SELECT text FROM turns WHERE role = 'user' AND length(text) > 40 ORDER BY id LIMIT 1").get() as { text: string } | undefined)?.text.match(/\p{L}{6,}/u)?.[0] ?? "decision";
      if (sources) io.say(`Ready: ${sources} sources, ${turns} turns searchable now. Try: glia search "${word}"`);
      else io.say(`No Claude Code sessions found in ${env.projectsDir}. They appear there once you have used Claude Code; add other history with: glia ingest <folder or claude.ai export .zip>`);
    } finally {
      db.close();
    }
  }
  if (failing.has("service") && !opts.noService) await installService(env.service);

  const after = await checks(env);
  const emb = after.find((c) => c.id === "embeddings")!;
  if (emb.fix === OLLAMA_INSTALL) io.say(`Keyword search only: ${emb.fix}`);
  else if (after.find((c) => c.id === "index")!.detail.includes("still to embed")) {
    io.say(opts.noService ? "Run: glia index to build meaning search (no daemon was installed)" : "Meaning search builds in the background; glia doctor shows progress.");
  }
  if (!env.hasApiKey()) io.say("Claims are off until you add ANTHROPIC_API_KEY to ~/.config/glia/env");
  io.say(
    [
      "",
      "Next:",
      "  - Restart Claude Code (or Claude Desktop), then ask it about something you decided before: it looks it up in glia.",
      "  - Your Claude Code sessions are read automatically from now on. To add more history, e.g. a claude.ai export (Settings > Privacy > Export data), run:",
      "      glia ingest <export.zip or folder>",
      "  - glia doctor checks everything and says how to fix what's off.",
    ].join("\n"),
  );
  return after;
}
