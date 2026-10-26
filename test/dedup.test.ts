import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { syncClaims } from "../src/claimIndex.js";
import { evidenceEntry } from "../src/claims.js";
import { openDb } from "../src/db.js";
import { addEvidence, dedupCandidates, sameFact } from "../src/dedup.js";
import { migrate } from "../src/migrations.js";
import { type TurnRow, writeSource } from "../src/sources.js";
import { Vault } from "../src/vault.js";
import { atCosine, claimFixture, failingEmbedder, git, tmpDir, VectorEmbedder } from "./helpers.js";

let db: ReturnType<typeof openDb>;
let vault: Vault;

const turn = (externalUuid: string): TurnRow => ({ externalUuid, parentUuid: null, role: "user", ts: "2026-10-14T09:00:00Z", text: "x", isSidechain: false, isInjected: false });
const sid = (ext: string) => (db.prepare("SELECT id FROM sources WHERE external_id = ?").get(ext) as { id: number }).id;

let n = 0;
/** A validated candidate, as validation leaves it: evidence in vault form plus turn_id. */
function candidate(statement: string, src: string, scope = "project:ai-brain", quote = `quote ${++n}`): number {
  const claim = {
    kind: "project_fact",
    scope,
    statement,
    statement_lang: "fr",
    origin: "user_stated",
    time_expression: null,
    valid_from: null,
    valid_from_precision: "unknown",
    confidence: 0.9,
    sensitivity: "normal",
    decision: null,
    evidence: [{ ...evidenceEntry(`cc:${src}`, `u-${src}`, quote), turn_id: 1 }],
  };
  const { lastInsertRowid } = db
    .prepare("INSERT INTO candidates (job_id, custom_id, ord, source_id, claim_json, model, prompt, batch_id, state) VALUES (1, ?, 0, ?, ?, 'm', 'p', 'b', 'valid')")
    .run(`c${n}`, sid(src), JSON.stringify(claim));
  return Number(lastInsertRowid);
}
const rows = () => db.prepare("SELECT id, state, reason, similar_to, claim_id, claim_json FROM candidates ORDER BY id").all() as { id: number; state: string; reason: string | null; similar_to: string | null; claim_id: string | null; claim_json: string }[];
const states = () => rows().reduce<Record<string, number>>((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {});

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  vault = new Vault(tmpDir("brain-vault-"));
  db.prepare("INSERT INTO jobs (id, type, state) VALUES (1, 'extract', 'done')").run();
  for (const s of ["s1", "s2", "s3", "s9"]) writeSource(db, { kind: "cc", external_id: s, title: s, project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: "a", parser_version: "t" }, [turn(`u-${s}`)]);
});

describe("sameFact", () => {
  it("merges equal statements whatever the vectors", () => {
    expect(sameFact("L'utilisateur préfère SQLite.", "l'utilisateur prefere sqlite", null)).toBe("merge");
  });
  it("merges a rewording that keeps the names and most words", () => {
    expect(sameFact("L'utilisateur a choisi SQLite pour l'index du brain.", "L'utilisateur utilise SQLite pour l'index du brain.", 0.95)).toBe("merge");
  });
  it("never merges statements naming different things", () => {
    expect(sameFact("L'utilisateur utilise SQLite pour l'index.", "L'utilisateur utilise Postgres pour l'index.", 0.99)).toBe("different");
    expect(sameFact("The user runs Node 22.", "The user runs Node 20.", 0.99)).toBe("different");
  });
  it("calls a near statement with no distinctive difference similar", () => {
    expect(sameFact("The user prefers dark mode in the editor.", "The user prefers light mode in the editor.", 0.92)).toBe("similar");
  });
  it("without a cosine, only equal statements merge", () => {
    expect(sameFact("The user prefers dark mode.", "The user likes dark mode.", null)).toBe("different");
  });
});

describe("addEvidence", () => {
  it("adds new entries in vault form and skips ones already there", () => {
    const c = claimFixture();
    const again = { ...c.evidence[0]!, turn_id: 4 };
    const fresh = { ...evidenceEntry("cc:s2", "u2", "autre citation"), turn_id: 5 };
    const r = addEvidence(c, [again, fresh]);
    expect(r.added).toBe(1);
    expect(r.claim.evidence).toEqual([c.evidence[0], evidenceEntry("cc:s2", "u2", "autre citation")]);
  });
});

describe("dedupCandidates", () => {
  it("the same fact stated in three sessions gives one claim with three evidence entries", async () => {
    const a = "L'utilisateur a choisi SQLite pour l'index du brain.";
    const b = "L'utilisateur utilise SQLite pour l'index du brain.";
    const c = "L'utilisateur garde SQLite pour l'index du brain.";
    const emb = new VectorEmbedder({ [a]: [1, 0], [b]: [1, 0.2], [c]: [1, 0.1] });
    candidate(a, "s1");
    candidate(b, "s2");
    candidate(c, "s3");
    const r = await dedupCandidates(db, vault, emb);
    expect(states()).toEqual({ valid: 1, merged: 2 });
    expect(r.merged.intoCandidates).toBe(2);
    const kept = rows().find((x) => x.state === "valid")!;
    expect(JSON.parse(kept.claim_json).evidence.map((e: { source: string }) => e.source)).toEqual(["cc:s1", "cc:s2", "cc:s3"]);
  });

  it("two different facts with similar wording stay two claims", async () => {
    const a = "L'utilisateur utilise SQLite pour l'index.";
    const b = "L'utilisateur utilise Postgres pour l'index.";
    const [va, vb] = atCosine(0.96);
    candidate(a, "s1");
    candidate(b, "s2");
    await dedupCandidates(db, vault, new VectorEmbedder({ [a]: va, [b]: vb }));
    expect(rows().map((r) => [r.state, r.similar_to])).toEqual([["valid", null], ["valid", null]]);
  });

  it("a near fact with no distinctive difference is marked similar to the claim, not merged", async () => {
    const a = "The user prefers dark mode in the editor.";
    const b = "The user prefers light mode in the editor.";
    vault.writeClaim(claimFixture({ id: "clm_A", statement: a, statement_lang: "en" }), "a");
    const [va, vb] = atCosine(0.92);
    const emb = new VectorEmbedder({ [a]: va, [b]: vb });
    await syncClaims(db, vault, emb);
    candidate(b, "s2");
    const r = await dedupCandidates(db, vault, emb);
    expect(rows()[0]).toMatchObject({ state: "valid", similar_to: "clm_A" });
    expect(r.similar).toBe(1);
  });

  it("merges into an active claim in the same scope and commits the new evidence", async () => {
    const s = "L'utilisateur utilise SQLite pour l'index du brain.";
    vault.writeClaim(claimFixture({ id: "clm_A", statement: s }), "a");
    const emb = new VectorEmbedder({ [s]: [1, 0] });
    candidate(s, "s9");
    const r = await dedupCandidates(db, vault, emb);
    expect(r.merged.intoClaims).toBe(1);
    expect(rows()[0]).toMatchObject({ state: "merged", claim_id: "clm_A" });
    expect(git(vault.dir, "log", "-1", "--format=%s")).toBe("evidence clm_A from cc:s9");
    expect(db.prepare("SELECT actor, action, claim_id FROM log").all()).toEqual([{ actor: "extractor", action: "add_evidence", claim_id: "clm_A" }]);
    expect(db.prepare("SELECT evidence FROM claims WHERE id = 'clm_A'").get()).toEqual({ evidence: expect.stringContaining("cc:s9") });
  });

  it("never merges across scopes", async () => {
    const s = "L'utilisateur utilise SQLite.";
    vault.writeClaim(claimFixture({ id: "clm_A", statement: s, scope: "project:other" }), "a");
    candidate(s, "s1");
    await dedupCandidates(db, vault, new VectorEmbedder());
    expect(rows()[0]!.state).toBe("valid");
  });

  it("does not merge into a claim that is no longer active", async () => {
    const s = "L'utilisateur utilise SQLite.";
    vault.writeClaim(claimFixture({ id: "clm_A", statement: s, status: "retracted" }), "a");
    candidate(s, "s1");
    await dedupCandidates(db, vault, new VectorEmbedder());
    expect(rows()[0]!.state).toBe("valid");
  });

  it("merges into an open proposal's claim_json", async () => {
    const s = "L'utilisateur utilise SQLite.";
    const proposed = { ...claimFixture({ id: "clm_P", statement: s, status: "proposed", review: "pending" }) };
    db.prepare(
      "INSERT INTO proposals (id, kind, claim_id, claim_json, statement_key, reason, created_at, expires_at, state) VALUES ('prp_1', 'claim', 'clm_P', ?, 'k', 'origin:ai_suggested', 'now', 'later', 'open')",
    ).run(JSON.stringify(proposed));
    candidate(s, "s2");
    const r = await dedupCandidates(db, vault, new VectorEmbedder());
    expect(r.merged.intoProposals).toBe(1);
    expect(rows()[0]).toMatchObject({ state: "merged", claim_id: "clm_P" });
    const p = JSON.parse((db.prepare("SELECT claim_json FROM proposals").get() as { claim_json: string }).claim_json);
    expect(p.evidence.map((e: { source: string }) => e.source)).toEqual(["cc:s1", "cc:s2"]);
    expect(p.evidence[1]).not.toHaveProperty("turn_id");
  });

  it("re-extraction adds no evidence twice", async () => {
    const s = "L'utilisateur utilise SQLite.";
    const c = claimFixture({ id: "clm_A", statement: s });
    vault.writeClaim(c, "a");
    const head = git(vault.dir, "rev-parse", "HEAD");
    candidate(s, "s1", "project:ai-brain", c.evidence[0]!.quote);
    db.prepare("UPDATE candidates SET claim_json = json_set(claim_json, '$.evidence[0].turn', 'u1')").run();
    const r = await dedupCandidates(db, vault, new VectorEmbedder());
    expect(r.evidenceSkipped).toBe(1);
    expect(rows()[0]!.state).toBe("merged");
    expect(git(vault.dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("embedder down: exact statement match only, nothing marked similar", async () => {
    const a = "The user prefers dark mode in the editor.";
    vault.writeClaim(claimFixture({ id: "clm_A", statement: a, statement_lang: "en" }), "a");
    candidate("The user prefers light mode in the editor.", "s1");
    candidate(a, "s2");
    const r = await dedupCandidates(db, vault, failingEmbedder);
    expect(r.exactOnly).toBe(true);
    expect(rows().map((x) => [x.state, x.similar_to])).toEqual([["valid", null], ["merged", null]]);
  });

  it("never overwrites a claim whose file is broken: the candidate goes to review instead", async () => {
    const s = "L'utilisateur utilise SQLite pour l'index du brain.";
    vault.writeClaim(claimFixture({ id: "clm_A", statement: s }), "a");
    await syncClaims(db, vault, null);
    const path = join(vault.dir, "claims/2026/clm_A.md");
    writeFileSync(path, "kind: mood\nhalf-finished");
    candidate(s, "s9");
    const r = await dedupCandidates(db, vault, new VectorEmbedder({ [s]: [1, 0] }));
    expect(readFileSync(path, "utf8")).toBe("kind: mood\nhalf-finished");
    expect(rows()[0]).toMatchObject({ state: "valid", similar_to: "clm_A" });
    expect(r.syncErrors).toEqual([expect.stringMatching(/clm_A\.md/)]);
  });

  it("embedder down: candidates not merged are held until the meaning index is back", async () => {
    candidate("The user prefers light mode in the editor.", "s1");
    const r = await dedupCandidates(db, vault, failingEmbedder);
    expect(r.held).toBe(1);
    expect(rows()[0]).toMatchObject({ state: "valid", reason: "held:no_meaning_index" });
    await dedupCandidates(db, vault, new VectorEmbedder());
    expect(rows()[0]).toMatchObject({ state: "valid", reason: null });
  });

  it("embeds in batches, so one large run is not one huge request", async () => {
    for (let i = 0; i < 70; i++) candidate(`Fait distinct numéro ${i} sur un sujet ${i}.`, "s1");
    const emb = new VectorEmbedder();
    await dedupCandidates(db, vault, emb);
    expect(emb.calls).toBeGreaterThanOrEqual(3);
  });

  it("a rewording of a rejected statement is dropped as previously rejected", async () => {
    const a = "L'utilisateur a choisi SQLite pour l'index du brain.";
    const b = "L'utilisateur utilise SQLite pour l'index du brain.";
    db.prepare(
      "INSERT INTO proposals (id, kind, claim_id, claim_json, statement_key, reason, created_at, expires_at, state) VALUES ('prp_r', 'claim', 'clm_R', ?, 'k', 'origin:ai_suggested', 'x', 'y', 'rejected')",
    ).run(JSON.stringify(claimFixture({ id: "clm_R", statement: a, status: "proposed", review: "pending" })));
    candidate(b, "s1");
    await dedupCandidates(db, vault, new VectorEmbedder({ [a]: [1, 0], [b]: [1, 0.2] }));
    expect(rows()[0]).toMatchObject({ state: "dropped", reason: "previously_rejected" });
  });
});

