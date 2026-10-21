import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
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
