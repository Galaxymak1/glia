import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

describe("a project excluded after it was ingested", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-exclusions-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const env = { ...process.env, GLIA_CONFIG: configPath, XDG_DATA_HOME: join(dir, "xdg-data"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
  const glia = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const db = join(dir, "db", "brain.db");
  const S = "11111111-2222-3333-4444-555555555555";
  // Keyword search only: no embedder to wait for.
  const config = (exclude: string[]) => writeFileSync(configPath, JSON.stringify({ claudeCode: { exclude }, embedding: { provider: "ollama", url: "http://127.0.0.1:9" } }));

  it("leaves search on the next ingest, and comes back when the pattern is removed", () => {
    const project = join(dir, "projects", "-home-me-work-acme");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${S}.jsonl`), JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: S, timestamp: "2026-10-24T10:00:00Z", message: { role: "user", content: "the acme contract renewal" } }) + "\n");
    config([]);
    glia("ingest", "--db", db, join(dir, "projects"));
    const hits = () => JSON.parse(glia("search", "--db", db, "--json", "acme")).length;
    expect(hits()).toBe(1);

    config(["-home-me-work-*"]);
    expect(glia("ingest", "--db", db, join(dir, "projects"))).toContain("Exclusions changed: 1 sources now in excluded projects are hidden; 0 shown again");
    expect(hits()).toBe(0);

    config([]);
    expect(glia("ingest", "--db", db, join(dir, "projects"))).toContain("0 sources now in excluded projects are hidden; 1 shown again");
    expect(hits()).toBe(1);
  }, 60_000);
});
