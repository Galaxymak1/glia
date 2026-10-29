import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { appendLog, Vault, vaultDirFor } from "../src/vault.js";
import { claimFixture, git, tmpDir } from "./helpers.js";

let dir: string;
let vault: Vault;
const saved = { ...process.env };

beforeEach(() => {
  dir = tmpDir("brain-vault-");
  vault = new Vault(dir);
});
afterEach(() => {
  process.env = { ...saved };
});

describe("vault", () => {
  it("lives next to the database", () => {
    expect(vaultDirFor("/data/brain/brain.db")).toBe(join("/data", "brain", "vault"));
  });

  it("writes a claim under claims/<year of recorded_at>/<id>.md", () => {
    const c = claimFixture({ id: "clm_X", recorded_at: "2025-03-01T00:00:00Z" });
    expect(vault.claimPath(c)).toBe("claims/2025/clm_X.md");
    vault.writeClaim(c, "accept clm_X");
    expect(readFileSync(join(dir, "claims/2025/clm_X.md"), "utf8")).toContain("id: clm_X");
  });

  it("keeps a claim in its file when recorded_at is edited", () => {
    const c = claimFixture({ id: "clm_X" });
    vault.writeClaim(c, "one");
    vault.writeClaim({ ...c, recorded_at: "2027-01-01T00:00:00Z" }, "two");
    expect(vault.claimPath({ ...c, recorded_at: "2027-01-01T00:00:00Z" })).toBe("claims/2026/clm_X.md");
  });

  it("each write is one commit holding the claim file and log.md only", () => {
    const db = openDb(":memory:");
    migrate(db);
    writeFileSync(join(dir, "unrelated.md"), "mine\n");
    vault.writeClaim(claimFixture({ id: "clm_0" }), "first");
    writeFileSync(join(dir, "unrelated.md"), "mine, edited\n");
    appendLog(db, vault, { actor: "extractor", action: "auto_accept", claim_id: "clm_1" });
    const sha = vault.writeClaim(claimFixture({ id: "clm_1" }), "accept clm_1 from cc:s1");
    expect(git(dir, "rev-parse", "HEAD")).toBe(sha);
    expect(git(dir, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual(["accept clm_1 from cc:s1", "", "claims/2026/clm_1.md", "log.md"]);
    expect(git(dir, "status", "--porcelain")).toContain("unrelated.md");
  });

  it("writing an unchanged claim makes no commit", () => {
    const c = claimFixture();
    const sha = vault.writeClaim(c, "one");
    expect(vault.writeClaim(c, "two")).toBe(sha);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("commits with no global git identity", () => {
    process.env.HOME = tmpDir("brain-home-");
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[k];
    const v = new Vault(tmpDir("brain-vault-"));
    expect(v.writeClaim(claimFixture(), "accept")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("every write appends a log row and a log.md line", () => {
    const db = openDb(":memory:");
    migrate(db);
    appendLog(db, vault, { actor: "extractor", action: "auto_accept", claim_id: "clm_X", payload: { source: "cc:s1" } }, new Date("2026-10-26T10:00:00Z"));
    appendLog(db, vault, { actor: "user", action: "reject" }, new Date("2026-10-26T10:00:05Z"));
    expect(db.prepare("SELECT actor, action, claim_id FROM log").all()).toEqual([
      { actor: "extractor", action: "auto_accept", claim_id: "clm_X" },
      { actor: "user", action: "reject", claim_id: null },
    ]);
    const md = readFileSync(join(dir, "log.md"), "utf8");
    expect(md).toContain('- 2026-10-26T10:00:00Z · extractor · auto_accept · clm_X · {"source":"cc:s1"}\n');
    expect(md).toContain("- 2026-10-26T10:00:05Z · user · reject\n");
  });

  it("lists every claim file in path order, with broken ones as errors", () => {
    vault.writeClaim(claimFixture({ id: "clm_B" }), "b");
    vault.writeClaim(claimFixture({ id: "clm_A", recorded_at: "2025-01-01T00:00:00Z" }), "a");
    writeFileSync(join(dir, "claims/2026/clm_Z.md"), "garbage");
    const { entries, errors } = vault.readAll();
    expect(entries.map((e) => e.path)).toEqual(["claims/2025/clm_A.md", "claims/2026/clm_B.md"]);
    expect(entries[0]!.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(errors).toEqual([expect.stringMatching(/^claims\/2026\/clm_Z\.md: /)]);
  });

  it("refuses to overwrite a claim file that changed on disk since it was read", () => {
    const c = claimFixture({ id: "clm_X" });
    vault.writeClaim(c, "one");
    const entry = vault.readAll().entries[0]!;
    writeFileSync(join(dir, entry.path), "half-finished edit");
    expect(() => vault.writeClaim({ ...c, confidence: 0.5 }, "two", { expectSha: entry.sha })).toThrow(/changed on disk/);
    expect(readFileSync(join(dir, entry.path), "utf8")).toBe("half-finished edit");
  });

  it("commits whatever the user's global git config says, and leaves the vault's config alone", () => {
    const home = tmpDir("brain-home-");
    writeFileSync(join(home, ".gitconfig"), "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = /nonexistent\n");
    process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
    const v = new Vault(tmpDir("brain-vault-"));
    expect(v.writeClaim(claimFixture(), "accept")).toMatch(/^[0-9a-f]{40}$/);
    expect(git(v.dir, "log", "-1", "--format=%an <%ae>")).toBe("glia <glia@localhost>");
    expect(readFileSync(join(v.dir, ".git", "config"), "utf8")).not.toContain("glia@localhost");
  });
});

