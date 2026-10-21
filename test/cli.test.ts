import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "brain-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const brain = (...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8" });

describe("brain init", () => {
  it("creates the database, then reports it up to date", () => {
    const db = join(dir, "nested", "brain.db");
    expect(brain("init", "--db", db)).toBe(`Created ${db} (schema v1)\n`);
    expect(brain("init", "--db", db)).toBe(`${db} is up to date (schema v1)\n`);
  });

  it("rejects an unknown command", () => {
    expect(() => brain("nope")).toThrow(/Unknown command: nope/);
  });

  it("survives several inits racing on a fresh path", async () => {
    const db = join(dir, "race", "brain.db");
    const run = promisify(execFile);
    const outs = await Promise.all(
      Array.from({ length: 4 }, () => run(process.execPath, ["--import", "tsx", "src/cli.ts", "init", "--db", db], { encoding: "utf8" })),
    );
    const created = outs.filter((o) => o.stdout.startsWith("Created")).length;
    expect(created).toBe(1);
    expect(brain("init", "--db", db)).toBe(`${db} is up to date (schema v1)\n`);
  });
});

describe("brain scrub", () => {
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

  it("refuses to run without --dry-run", () => {
    expect(() => brain("scrub", dir)).toThrow(/needs --dry-run/);
  });
});
