import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { type Claim, parseClaimFile, serializeClaim, statementKey } from "../src/claims.js";
import { claimRow, syncClaims } from "../src/claimIndex.js";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { ulid } from "../src/ulid.js";
import { Vault } from "../src/vault.js";
import { claimFixture, tmpDir, VectorEmbedder } from "./helpers.js";

const fullDecisionClaim = (): Claim =>
  claimFixture({
    kind: "decision",
    statement: 'On part sur SQLite: "zéro ops", pas Postgres.',
    options: [{ option: "Postgres + pgvector", rejected_because: "RAM, ops" }, { option: "SQLite" }],
    rationale: "zero-ops, single file,\nrebuildable index",
    expected_outcome: { text: "index rebuild under 2 min", confidence: 0.7 },
    revisit_on: "2027-01-15",
    reviewed_at: "2026-10-20T18:40:00Z",
    review: "approved",
  });

/** What Obsidian's property editor writes back: block YAML, keys in its own order, dates unquoted. */
function obsidianRewrite(text: string): string {
  const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
  const data = yaml.load(front!, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
  const dumped = yaml.dump(data, { sortKeys: true, schema: yaml.JSON_SCHEMA, lineWidth: -1 }).replace(/'(\d{4}-\d{2}[^']*)'/g, "$1");
  return `---\n${dumped}---\n${body}`;
}

describe("claim files", () => {
  it("round-trips a decision claim with every field unchanged", () => {
    const c = fullDecisionClaim();
    expect(parseClaimFile(serializeClaim(c), "x.md")).toEqual(c);
  });

  it("reads obsidian-style block YAML with reordered keys", () => {
    const text = obsidianRewrite(serializeClaim(fullDecisionClaim()));
    expect(text).toMatch(/^confidence: 0\.86$/m);
    expect(text).toMatch(/^recorded_at: 2026-10-20T14:02:11Z$/m);
    expect(parseClaimFile(text, "x.md")).toEqual(fullDecisionClaim());
  });

  it("keeps dates as strings, a bare year included", () => {
    const c = claimFixture({ valid_from: "2024", valid_from_precision: "year" });
    const text = serializeClaim(c);
    expect(parseClaimFile(text, "x.md").recorded_at).toBe("2026-10-20T14:02:11Z");
    expect(parseClaimFile(text.replace(/^valid_from: .*$/m, "valid_from: 2024"), "x.md").valid_from).toBe("2024");
  });

  it("keeps a property added by hand", () => {
    const text = serializeClaim(claimFixture()).replace("\n---\n", "\ntags: [brain]\n---\n");
    const c = parseClaimFile(text, "x.md");
    expect((c as Record<string, unknown>).tags).toEqual(["brain"]);
    expect(serializeClaim(c)).toContain("tags:");
  });

  it("names the file and field of a broken claim", () => {
    const broken = serializeClaim(claimFixture()).replace("kind: project_fact", "kind: mood");
    expect(() => parseClaimFile(broken, "claims/2026/a.md")).toThrow(/claims\/2026\/a\.md: kind/);
    expect(() => parseClaimFile("no frontmatter", "claims/2026/b.md")).toThrow(/claims\/2026\/b\.md/);
  });

  it("statementKey ignores case, accents, spacing and the final stop", () => {
    expect(statementKey("Kylian préfère  SQLite.")).toBe(statementKey("kylian prefere sqlite"));
    expect(statementKey("Kylian préfère SQLite.")).not.toBe(statementKey("Kylian préfère Postgres."));
  });

  it("ulids sort by time and never repeat", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => ulid())).size).toBe(1000);
  });
});

describe("claim index", () => {
  let db: ReturnType<typeof openDb>;
  let dir: string;
  let vault: Vault;
  const emb = new VectorEmbedder();

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db);
    dir = tmpDir("brain-vault-");
    vault = new Vault(dir);
  });

  const old = () => claimFixture({ id: "clm_A", status: "superseded", superseded_by: "clm_B", valid_to: "2026-09" });
  const newer = () => claimFixture({ id: "clm_B", statement: "L'utilisateur utilise Postgres pour l'index.", supersedes: ["clm_A"], recorded_at: "2025-12-01T00:00:00Z" });
  const third = () => claimFixture({ id: "clm_C", kind: "preference", scope: "global", statement: "The user prefers short answers.", statement_lang: "en" });
  const snapshot = () => ({
    claims: db.prepare("SELECT * FROM claims ORDER BY id").all().map((r) => ({ ...(r as object), n: undefined })),
    edges: db.prepare("SELECT * FROM edges ORDER BY src, dst").all(),
    vec: db.prepare("SELECT c.id, v.model, v.input_sha256 FROM claims_vec v JOIN claims c ON c.n = v.claim_n ORDER BY c.id").all(),
  });

  it("rebuilding from the vault gives the same rows", async () => {
    for (const c of [old(), newer(), third()]) vault.writeClaim(c, `test ${c.id}`);
    const first = await syncClaims(db, vault, emb);
    expect(first).toMatchObject({ inserted: 3, updated: 0, removed: 0, embedded: 3, errors: [] });
    const before = snapshot();
    expect(before.edges).toEqual([{ src: "clm_B", dst: "clm_A", type: "supersedes", valid_from: "2026-10", valid_to: null }]);
    expect(before.claims[0]).toMatchObject({ file_path: "claims/2026/clm_A.md" });
    db.exec("DELETE FROM claims; DELETE FROM edges;");
    await syncClaims(db, vault, emb);
    expect(snapshot()).toEqual(before);
  });

  it("a second sync with nothing changed does nothing", async () => {
    vault.writeClaim(third(), "t");
    await syncClaims(db, vault, emb);
    const calls = emb.calls;
    expect(await syncClaims(db, vault, emb)).toMatchObject({ inserted: 0, updated: 0, removed: 0, embedded: 0 });
    expect(emb.calls).toBe(calls);
  });

  it("claimRow gives back the claim as written", async () => {
    vault.writeClaim(fullDecisionClaim(), "t");
    await syncClaims(db, vault, emb);
    expect(claimRow(db, fullDecisionClaim().id)).toEqual(fullDecisionClaim());
    expect(claimRow(db, "clm_nope")).toBeNull();
  });

  it("skips a broken file, reports it, and indexes the rest", async () => {
    vault.writeClaim(third(), "t");
    const path = vault.writeClaim(old(), "t") && join(dir, "claims/2026/clm_A.md");
    const brokenText = readFileSync(path, "utf8").replace("kind: project_fact", "kind: mood");
    writeFileSync(path, brokenText);
    const r = await syncClaims(db, vault, emb);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/claims\/2026\/clm_A\.md: kind/);
    expect(claimRow(db, "clm_C")).not.toBeNull();
    expect(readFileSync(path, "utf8")).toBe(brokenText);
  });

  it("keeps the last good row of a claim whose file broke", async () => {
    vault.writeClaim(old(), "t");
    await syncClaims(db, vault, emb);
    const path = join(dir, "claims/2026/clm_A.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("kind: project_fact", "kind: mood"));
    expect((await syncClaims(db, vault, emb)).removed).toBe(0);
    expect(claimRow(db, "clm_A")).not.toBeNull();
  });

  it("picks up an edited statement and re-embeds it", async () => {
    vault.writeClaim(third(), "t");
    await syncClaims(db, vault, emb);
    const path = join(dir, "claims/2026/clm_C.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("short answers", "terse answers"));
    expect(await syncClaims(db, vault, emb)).toMatchObject({ updated: 1, embedded: 1 });
    expect(db.prepare("SELECT c.id FROM claims_fts f JOIN claims c ON c.n = f.rowid WHERE claims_fts MATCH 'terse'").all()).toEqual([{ id: "clm_C" }]);
  });

  it("removes the row of a deleted file", async () => {
    vault.writeClaim(third(), "t");
    await syncClaims(db, vault, emb);
    vault.removeFile("claims/2026/clm_C.md");
    expect((await syncClaims(db, vault, emb)).removed).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM claims_vec").get()).toEqual({ n: 0 });
  });

  it("without an embedder, indexes rows and leaves vectors alone", async () => {
    vault.writeClaim(third(), "t");
    expect(await syncClaims(db, vault, null)).toMatchObject({ inserted: 1, embedded: 0 });
  });
});
