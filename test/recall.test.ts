import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { syncClaims } from "../src/claimIndex.js";
import { type Claim, evidenceEntry } from "../src/claims.js";
import { openDb } from "../src/db.js";
import { createMcpServer, RESULT_CHARS } from "../src/mcp.js";
import { migrate } from "../src/migrations.js";
import { brief, CLAIMS_TAG, recall } from "../src/recall.js";
import { type TurnRow, writeSource } from "../src/sources.js";
import { Vault } from "../src/vault.js";
import { claimFixture, tmpDir, VectorEmbedder } from "./helpers.js";

let db: ReturnType<typeof openDb>;
let vault: Vault;
let emb: VectorEmbedder;
const ids = (r: { hits: { id: string }[] }) => r.hits.map((h) => h.id);

const turn = (externalUuid: string): TurnRow => ({ externalUuid, parentUuid: null, role: "user", ts: "2026-10-14T09:00:00Z", text: "x", isSidechain: false, isInjected: false });

async function seed(claims: Claim[]) {
  for (const c of claims) vault.writeClaim(c, c.id);
  await syncClaims(db, vault, emb);
}

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  vault = new Vault(tmpDir("brain-vault-"));
  emb = new VectorEmbedder({
    "index database": [1, 0, 0],
    "L'utilisateur utilise SQLite pour l'index.": [0.9, 0.1, 0],
    "L'utilisateur utilise Postgres pour l'index.": [0.95, 0.05, 0],
    "The user prefers short answers.": [0, 1, 0],
  });
  writeSource(db, { kind: "cc", external_id: "s1", title: "s1", project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: "a", parser_version: "t" }, [turn("u1")]);
});

const A = () => claimFixture({ id: "clm_A", statement: "L'utilisateur utilise SQLite pour l'index.", status: "superseded", superseded_by: "clm_B", valid_from: "2026-03", valid_to: "2026-09" });
const B = () => claimFixture({ id: "clm_B", statement: "L'utilisateur utilise Postgres pour l'index.", supersedes: ["clm_A"], valid_from: "2026-10", evidence: [evidenceEntry("cc:s1", "u1", "x")] });
const P = () => claimFixture({ id: "clm_P", kind: "preference", scope: "global", statement: "The user prefers short answers.", statement_lang: "en", valid_from: null, valid_from_precision: "unknown" });

describe("recall", () => {
  it("ranks by keyword and meaning, filtered by scope or global", async () => {
    await seed([B(), P(), claimFixture({ id: "clm_O", scope: "project:other", statement: "L'utilisateur utilise Postgres ailleurs." })]);
    const r = await recall(db, emb, { query: "index database", scope: "project:ai-brain" });
    expect(ids(r)).toEqual(["clm_B", "clm_P"]);
    expect(r.hits[0]).toMatchObject({ kind: "project_fact", origin: "user_stated", status: "active", as_of: "2026-10", evidence: [{ source: "cc:s1", turn_id: expect.any(Number) }] });
  });

  it("hides superseded claims unless include_superseded or as_of asks", async () => {
    await seed([A(), B()]);
    expect(ids(await recall(db, emb, { query: "index database" }))).toEqual(["clm_B"]);
    expect(ids(await recall(db, emb, { query: "index database", include_superseded: true })).sort()).toEqual(["clm_A", "clm_B"]);
    expect(ids(await recall(db, emb, { query: "index database", as_of: "2026-05" }))).toEqual(["clm_A"]);
    expect(ids(await recall(db, emb, { query: "index database", as_of: "2026-10-20" }))).toEqual(["clm_B"]);
  });

  it("never returns proposed, retracted, rejected or expired claims", async () => {
    await seed((["proposed", "retracted", "rejected", "expired"] as const).map((status, i) => claimFixture({ id: `clm_${i}`, status, statement: "L'utilisateur utilise SQLite pour l'index." })));
    expect(ids(await recall(db, emb, { query: "SQLite index", include_superseded: true, as_of: "2026-12" }))).toEqual([]);
  });

  it("recall without embedder answers by keyword with a note", async () => {
    await seed([B()]);
    const r = await recall(db, null, { query: "Postgres" });
    expect(ids(r)).toEqual(["clm_B"]);
    const down = await recall(db, { model: "fake@1", embed: async () => Promise.reject(new Error("ECONNREFUSED")) }, { query: "Postgres" });
    expect(ids(down)).toEqual(["clm_B"]);
    expect(down.meaningError).toMatch(/ECONNREFUSED/);
  });

  it("caps limit at 20", async () => {
    await seed(Array.from({ length: 25 }, (_, i) => claimFixture({ id: `clm_${String(i).padStart(2, "0")}`, statement: `SQLite fact number ${i}.` })));
    expect(ids(await recall(db, null, { query: "SQLite", limit: 50 }))).toHaveLength(20);
    expect(ids(await recall(db, null, { query: "SQLite" }))).toHaveLength(8);
  });
});

describe("brief", () => {
  it("holds profile, project claims and open decisions with as_of dates, under budget", async () => {
    await seed([
      P(),
      B(),
      A(),
      claimFixture({ id: "clm_D", kind: "decision", statement: "On garde SQLite pour la v1.", recorded_at: "2026-10-21T00:00:00Z" }),
      ...Array.from({ length: 30 }, (_, i) => claimFixture({ id: `clm_F${i}`, statement: `Fait numéro ${i} sur le projet, assez long pour remplir le budget.` })),
    ]);
    const r = brief(db, { scope: "project:ai-brain", budget_tokens: 300 });
    expect(r.text.startsWith(`<${CLAIMS_TAG}>\n`) && r.text.endsWith(`</${CLAIMS_TAG}>`)).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(300 * 2.25 + `<${CLAIMS_TAG}>\n\n</${CLAIMS_TAG}>`.length);
    expect(r.text).toContain("Profile\n- The user prefers short answers. (as of 2026-10-20, user_stated)");
    expect(r.text).toMatch(/Project project:ai-brain\n- /);
    expect(r.text).toContain("(as of 2026-10, user_stated)");
    expect(r.text).not.toContain("SQLite pour l'index");
    expect(r.claimIds).toContain("clm_P");
    expect(r.claimIds).not.toContain("clm_A");
  });

  it("puts open decisions in even when facts fill the budget", async () => {
    await seed([
      claimFixture({ id: "clm_D", kind: "decision", statement: "On garde SQLite pour la v1." }),
      ...Array.from({ length: 30 }, (_, i) => claimFixture({ id: `clm_F${i}`, statement: `Fait numéro ${i} sur le projet, assez long pour remplir le budget.` })),
    ]);
    expect(brief(db, { scope: "project:ai-brain", budget_tokens: 200 }).text).toContain("On garde SQLite pour la v1.");
  });

  it("an empty brain gives an empty briefing", () => {
    expect(brief(db, {}).text).toBe(`<${CLAIMS_TAG}>\nNo claims yet.\n</${CLAIMS_TAG}>`);
  });
});

describe("MCP tools", () => {
  let client: Client;
  beforeEach(async () => {
    const server = createMcpServer(db, emb);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    client = new Client({ name: "test", version: "0" });
    await client.connect(c);
  });
  afterEach(async () => client.close());
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

  it("every served claim is logged in retrievals with the client's name", async () => {
    await seed([B(), P()]);
    const text = await call("recall", { query: "Postgres" });
    expect(text).toContain("clm_B");
    expect(text.startsWith(`<${CLAIMS_TAG}>`)).toBe(true);
    await call("brief", { scope: "project:ai-brain" });
    // recall serves B, then P by meaning (the nearest other claim); brief serves the profile, then the project.
    expect(db.prepare("SELECT claim_id, client FROM retrievals ORDER BY rowid").all()).toEqual([
      { claim_id: "clm_B", client: "test" },
      { claim_id: "clm_P", client: "test" },
      { claim_id: "clm_P", client: "test" },
      { claim_id: "clm_B", client: "test" },
    ]);
  });

  it("both tools are read-only", async () => {
    const tools = (await client.listTools()).tools.filter((t) => t.name === "recall" || t.name === "brief");
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
      ["recall", true],
      ["brief", true],
    ]);
  });

  it("results stay under RESULT_CHARS at limit 20 with long statements", async () => {
    await seed(Array.from({ length: 25 }, (_, i) => claimFixture({ id: `clm_${String(i).padStart(2, "0")}`, statement: `SQLite ${"très long énoncé ".repeat(300)}${i}.` })));
    const text = await call("recall", { query: "SQLite", limit: 20 });
    expect(text.length).toBeLessThanOrEqual(RESULT_CHARS);
    expect((text.match(/^\d+\. clm_/gm) ?? []).length).toBe(20);
  });
});
