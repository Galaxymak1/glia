import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { migrations } from "../src/migrations.js";
import { Vault } from "../src/vault.js";
import { claimFixture } from "./helpers.js";

const V = migrations.at(-1)!.version;

const dir = mkdtempSync(join(tmpdir(), "brain-cli-"));
// Never read the developer's own config file.
// XDG folders in the temp dir: the CLI moves legacy folders under them, never the real ones.
const env = { ...process.env, GLIA_CONFIG: join(dir, "no-config.json"), XDG_DATA_HOME: join(dir, "xdg-data"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const brain = (...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env });

describe("glia --version", () => {
  it("prints the package version", () => {
    expect(brain("--version")).toBe(`${JSON.parse(readFileSync("package.json", "utf8")).version}\n`);
  });
});

describe("glia init", () => {
  it("creates the database, then reports it up to date", () => {
    const db = join(dir, "nested", "brain.db");
    expect(brain("init", "--db-only", "--db", db)).toBe(`Created ${db} (schema v${V})\n`);
    expect(brain("init", "--db-only", "--db", db)).toBe(`${db} is up to date (schema v${V})\n`);
  });

  it("rejects an unknown command", () => {
    expect(() => brain("nope")).toThrow(/Unknown command: nope/);
  });

  it("survives several inits racing on a fresh path", async () => {
    const db = join(dir, "race", "brain.db");
    const run = promisify(execFile);
    const outs = await Promise.all(
      Array.from({ length: 4 }, () => run(process.execPath, ["--import", "tsx", "src/cli.ts", "init", "--db-only", "--db", db], { encoding: "utf8", env })),
    );
    const created = outs.filter((o) => o.stdout.startsWith("Created")).length;
    expect(created).toBe(1);
    expect(brain("init", "--db-only", "--db", db)).toBe(`${db} is up to date (schema v${V})\n`);
  });
});

describe("glia scrub", () => {
  it("reports what it would redact without printing secrets or touching files", () => {
    const root = join(dir, "transcripts", "-home-me-proj");
    mkdirSync(join(root, "memory"), { recursive: true });
    const secret = "gh" + "p_" + "Z".repeat(36);
    const session = JSON.stringify({ type: "user", message: { content: `DB_PASSWORD=${"hunter2" + "hunter2"}\nuse ${secret}` } });
    writeFileSync(join(root, "s1.jsonl"), session + "\n");
    writeFileSync(join(root, "memory", "notes.md"), "Nothing secret here.\n");
    writeFileSync(join(root, "image.png"), "binary");
    const out = brain("scrub", "--dry-run", "--show", join(dir, "transcripts"));
    expect(out).toContain("Scanned 2 files");
    expect(out).toContain("skipped 1 non-text files");
    expect(out).toContain("Would redact 2 secrets in 1 files");
    expect(out).toMatch(/s1\.jsonl:1 {2}github_token {2}ghp_…\(40\)/);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("hunter2hunter2");
    expect(readFileSync(join(root, "s1.jsonl"), "utf8")).toBe(session + "\n");
  });

  it("reports dropped lines, refused .json files and symlinks apart from secrets", () => {
    const root = join(dir, "transcripts2", "-home-me-proj");
    mkdirSync(root, { recursive: true });
    const secret = "gh" + "p_" + "Y".repeat(36);
    writeFileSync(join(root, "s1.jsonl"), `{"type":"user"}\n{not json\n`);
    writeFileSync(join(root, "broken.json"), `{"token": "${secret}"`);
    symlinkSync(join(root, "s1.jsonl"), join(root, "link.jsonl"));
    const out = brain("scrub", "--dry-run", "--show", join(dir, "transcripts2"));
    expect(out).toContain("Scanned 1 files");
    expect(out).toContain("and 1 symlinks");
    expect(out).toContain("1 .json files are not valid JSON; ingest would refuse them.");
    expect(out).toContain("Would drop 1 JSONL lines that are not valid JSON.");
    expect(out).toContain("Nothing to redact.");
    expect(out).toMatch(/broken\.json {2}invalid_json/);
    expect(out).not.toContain(secret);
  });

  it("refuses to run without --dry-run", () => {
    expect(() => brain("scrub", dir)).toThrow(/needs --dry-run/);
  });
});

describe("glia ingest", () => {
  it("stores files once: a second run adds nothing", () => {
    const src = join(dir, "ingest-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "s1.jsonl"), JSON.stringify({ type: "user", message: { content: "DB_PASSWORD=" + "hunter2" + "hunter2" } }) + "\n");
    writeFileSync(join(src, "notes.md"), "notes\n");
    writeFileSync(join(src, "photo.png"), "binary");
    const db = join(dir, "ingest", "brain.db");
    expect(brain("ingest", "--db", db, src)).toMatch(/^Stored 2 new files \(.* MB, .* MB compressed, 1 secrets redacted\); 0 unchanged; skipped 1 non-text files\n/);
    expect(brain("ingest", "--db", db, src)).toMatch(/^Stored 0 new files .*; 2 unchanged; skipped 1 non-text files\n/);
  });

  it("reports a path it cannot read and still stores the rest", () => {
    const src = join(dir, "ingest-partial");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.md"), "a\n");
    const db = join(dir, "ingest-partial-db", "brain.db");
    const run = () => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ingest", "--db", db, join(dir, "does-not-exist"), src], { encoding: "utf8", stdio: "pipe", env });
    let err: { status?: number; stdout?: string; stderr?: string } = {};
    try {
      run();
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(1);
    expect(err.stderr).toMatch(/does-not-exist: ENOENT/);
    expect(err.stdout).toMatch(/^Stored 1 new files .*; 1 failed\n/);
  });

  it("needs a path", () => {
    expect(() => brain("ingest", "--db", join(dir, "x.db"))).toThrow(/needs at least one path/);
  });
});

describe("glia ingest of Claude Code projects", () => {
  const S = "4e72e044-0bd2-40ea-afbf-fa36accc5e46";
  const session = JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: S, message: { content: "hello" } }) + "\n";
  const makeProjects = (root: string) => {
    for (const project of ["-home-me-dev-brain", "-home-me-work-acme"]) {
      mkdirSync(join(root, "projects", project, S, "tool-results"), { recursive: true });
      writeFileSync(join(root, "projects", project, `${S}.jsonl`), session);
      writeFileSync(join(root, "projects", project, S, "tool-results", "out.txt"), `output of ${project}\n`);
    }
  };

  it("parses from a relative path and keeps every file of an excluded project out of the store", () => {
    const root = join(dir, "cc-home");
    makeProjects(root);
    const config = join(dir, "cc-config.json");
    writeFileSync(config, JSON.stringify({ claudeCode: { exclude: ["-home-me-work-*"] } }));
    const db = join(dir, "cc-db", "brain.db");
    // Run from inside the folder; tsx is loaded by absolute path since the cwd has no node_modules.
    const tsx = pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href;
    const out = execFileSync(process.execPath, ["--import", tsx, join(process.cwd(), "src/cli.ts"), "ingest", "--db", db, "projects"], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, GLIA_CONFIG: config },
    });
    expect(out).toMatch(/^Stored 2 new files .*; 2 in excluded projects\n/);
    expect(out).toMatch(/\nParsed 1 sessions, 0 subagent transcripts, 0 memory files \(1 turns written, 0 removed\)/);
    const stored = readdirSync(join(dir, "cc-db", "raw"), { recursive: true }).filter((f) => String(f).endsWith(".gz"));
    const contents = stored.map((f) => gunzipSync(readFileSync(join(dir, "cc-db", "raw", String(f)))).toString("utf8"));
    expect(contents.some((c) => c.includes("acme"))).toBe(false);
  });

  it("keeps an export ZIP inside an excluded project out of the store", () => {
    const root = join(dir, "zip-home");
    makeProjects(root);
    const conversations = [{ uuid: "c1", name: "acme deal", created_at: "2026-10-20", updated_at: "2026-10-20", chat_messages: [{ uuid: "m1", sender: "human", content: [{ type: "text", text: "acme" }] }] }];
    writeFileSync(join(root, "projects", "-home-me-work-acme", "conversations-000.zip"), zipSync({ "conversations.json": strToU8(JSON.stringify(conversations)) }));
    const config = join(dir, "zip-config.json");
    writeFileSync(config, JSON.stringify({ claudeCode: { exclude: ["-home-me-work-*"] } }));
    const db = join(dir, "zip-db", "brain.db");
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ingest", "--db", db, join(root, "projects")], { encoding: "utf8", env: { ...env, GLIA_CONFIG: config } });
    expect(out).toMatch(/^Stored 2 new files .*; 3 in excluded projects\n/);
    expect(out).not.toMatch(/claude\.ai export/);
  });

  it("excludes a copied single project folder and a lone session file copied outside projects/", () => {
    const root = join(dir, "cc-home3");
    makeProjects(root);
    const backup = join(dir, "backup3");
    cpSync(join(root, "projects", "-home-me-work-acme"), join(backup, "-home-me-work-acme"), { recursive: true });
    mkdirSync(join(backup, "lone", "-home-me-work-acme"), { recursive: true });
    cpSync(join(root, "projects", "-home-me-work-acme", `${S}.jsonl`), join(backup, "lone", "-home-me-work-acme", `${S}.jsonl`));
    const config = join(dir, "cc-config3.json");
    writeFileSync(config, JSON.stringify({ claudeCode: { exclude: ["-home-me-work-*"] } }));
    const db = join(dir, "cc-db3", "brain.db");
    const run = (target: string) =>
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ingest", "--db", db, target], { encoding: "utf8", env: { ...env, GLIA_CONFIG: config } });
    expect(run(join(backup, "-home-me-work-acme"))).toMatch(/^Stored 0 new files .*; 2 in excluded projects\n/);
    expect(run(join(backup, "lone", "-home-me-work-acme", `${S}.jsonl`))).toMatch(/^Stored 0 new files .*; 1 in excluded projects\n/);
  });

  it("keeps out a projects/ folder nested inside an excluded project, and an excluded folder inside a mixed root", () => {
    const root = join(dir, "cc-home4");
    makeProjects(root);
    const nested = join(root, "projects", "-home-me-work-acme", S, "tool-results", "projects", "foo");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "x.txt"), "acme nested\n");
    const mixed = join(dir, "mixed4");
    cpSync(join(root, "projects"), mixed, { recursive: true });
    writeFileSync(join(mixed, `${S}.jsonl`), session); // makes the root look like a single project
    const config = join(dir, "cc-config4.json");
    writeFileSync(config, JSON.stringify({ claudeCode: { exclude: ["-home-me-work-*"] } }));
    for (const target of [join(root, "projects"), mixed]) {
      const db = join(dir, `cc-db4-${target === mixed ? "mixed" : "tree"}`, "brain.db");
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ingest", "--db", db, target], { encoding: "utf8", env: { ...env, GLIA_CONFIG: config } });
      const raw = join(dirname(db), "raw");
      const stored = readdirSync(raw, { recursive: true }).filter((f) => String(f).endsWith(".gz"));
      expect(stored.map((f) => gunzipSync(readFileSync(join(raw, String(f)))).toString("utf8")).some((c) => c.includes("acme"))).toBe(false);
    }
  });

  it("ignores folders above the ingested root when excluding", () => {
    const root = join(dir, "-home-me-work-archive");
    makeProjects(root);
    const config = join(dir, "cc-config5.json");
    writeFileSync(config, JSON.stringify({ claudeCode: { exclude: ["-home-me-work-*"] } }));
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ingest", "--db", join(dir, "cc-db5", "brain.db"), join(root, "projects")], {
      encoding: "utf8",
      env: { ...env, GLIA_CONFIG: config },
    });
    expect(out).toMatch(/^Stored 2 new files .*; 2 in excluded projects\n/); // only -home-me-work-acme's files
    expect(out).toMatch(/\nParsed 1 sessions/);
  });

  it("applies exclusion and parsing through a symlink and in a copy under another name", () => {
    const root = join(dir, "cc-home2");
    makeProjects(root);
    symlinkSync(join(root, "projects"), join(root, "link"));
    cpSync(join(root, "projects"), join(root, "spool"), { recursive: true });
    const config = join(dir, "cc-config2.json");
    writeFileSync(config, JSON.stringify({ claudeCode: { exclude: ["-home-me-work-*"] } }));
    for (const folder of ["link", "spool"]) {
      const db = join(dir, `cc-db-${folder}`, "brain.db");
      const run = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ingest", "--db", db, join(root, folder)], { encoding: "utf8", env: { ...env, GLIA_CONFIG: config } });
      expect(run).toMatch(/2 in excluded projects/);
      expect(run).toMatch(/\nParsed 1 sessions/);
      const raw = join(dir, `cc-db-${folder}`, "raw");
      const stored = readdirSync(raw, { recursive: true }).filter((f) => String(f).endsWith(".gz"));
      expect(stored.map((f) => gunzipSync(readFileSync(join(raw, String(f)))).toString("utf8")).some((c) => c.includes("acme"))).toBe(false);
    }
  });
});


describe("glia index --claims", () => {
  it("mirrors the vault into the claim tables and reports a broken file", () => {
    const db = join(dir, "claims", "brain.db");
    const vault = new Vault(join(dir, "claims", "vault"));
    vault.writeClaim(claimFixture({ id: "clm_A" }), "a");
    vault.writeClaim(claimFixture({ id: "clm_B" }), "b");
    writeFileSync(join(dir, "claims", "vault", "claims", "2026", "clm_C.md"), "broken");
    // A closed port: the embedder fails at once, and the rows are still indexed.
    const config = join(dir, "claims-config.json");
    writeFileSync(config, JSON.stringify({ embedding: { url: "http://127.0.0.1:9" } }));
    let out = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "index", "--claims", "--db", db], { encoding: "utf8", env: { ...env, GLIA_CONFIG: config }, stdio: "pipe" });
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      expect(e.status).toBe(1);
      out = e.stdout + e.stderr;
    }
    expect(out).toContain("Claims: 2 new, 0 updated, 0 removed, 0 embedded");
    expect(out).toMatch(/glia: claims\/2026\/clm_C\.md: no frontmatter/);
    expect(out).toMatch(/glia: meaning index of claims not updated/);
  });
});

describe("glia extract", () => {
  it("--dry-run reports what would be sent without calling the API", async () => {
    const dbPath = join(dir, "extract", "brain.db");
    const { openDb } = await import("../src/db.js");
    const { migrate } = await import("../src/migrations.js");
    const { writeSource } = await import("../src/sources.js");
    const db = openDb(dbPath);
    migrate(db);
    writeSource(
      db,
      { kind: "cc", external_id: "s1", title: "t", project_hint: null, cwd: null, created_at: null, updated_at: "2026-10-10T00:00:00Z", raw_path: "raw", raw_sha256: "abc", parser_version: "test" },
      [{ externalUuid: "u1", parentUuid: null, role: "user", ts: "2026-10-01T09:00:00Z", text: "x".repeat(2250), isSidechain: false, isInjected: false }],
    );
    db.close();
    // No env file: a dry run needs no key.
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "extract", "--dry-run", "--db", dbPath], { encoding: "utf8", env: { ...env, XDG_CONFIG_HOME: join(dir, "no-xdg") } });
    expect(out).toBe("Would send 1 sources in 1 requests: 2250 characters, about 1000 tokens, about $0.0001 batched for input\n");
  });

  it("without a key, says where to put one", () => {
    const dbPath = join(dir, "extract", "brain.db");
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "extract", "--db", dbPath], { encoding: "utf8", env: { ...env, XDG_CONFIG_HOME: join(dir, "no-xdg") }, stdio: "pipe" })).toThrow(/glia\/env: no ANTHROPIC_API_KEY/);
  });
});

describe("glia review", () => {
  it("--stats with no decisions says so", () => {
    expect(brain("review", "--stats", "--db", join(dir, "review", "brain.db"))).toBe("No review decisions yet.\n");
  });

  it("needs a terminal to triage", () => {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "review", "--db", join(dir, "review", "brain.db")], { encoding: "utf8", env, stdio: "pipe" })).toThrow(
      /glia review needs a terminal/,
    );
  });
});

describe("glia audit and eval arms", () => {
  it("audit report on a fresh brain leaves the gate undecided", () => {
    const db = join(dir, "audit", "brain.db");
    expect(brain("audit", "sample", "--db", db)).toBe("Opened 0 audit items; triage them with: glia review --audit\n");
    expect(brain("audit", "report", "--db", db)).toBe(
      "Write precision: 0/0 (-); 0 edited, 0 retracted; 0 still open\nAI-origin claims auto-accepted: 0\n" +
        "Phase 1 gate (precision 80% or more, zero AI-origin auto-accepted): not decided (nothing judged yet)\n",
    );
  });

  it("eval run rejects an unknown arm", () => {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "eval", "run", "--arms", "B,X", "--db", join(dir, "audit", "brain.db")], { encoding: "utf8", env, stdio: "pipe" })).toThrow(
      /--arms takes B, C or both/,
    );
  });
});
