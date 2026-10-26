import { beforeEach, describe, expect, it } from "vitest";
import { auditReport, sampleAudit } from "../src/audit.js";
import { syncClaims } from "../src/claimIndex.js";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { resolveProposal } from "../src/review.js";
import { Vault } from "../src/vault.js";
import { claimFixture, tmpDir } from "./helpers.js";

let db: ReturnType<typeof openDb>;
let vault: Vault;
const NOW = new Date("2026-10-26T10:00:00Z");
const audits = () => db.prepare("SELECT id, claim_id FROM proposals WHERE kind = 'audit' AND state = 'open' ORDER BY rowid").all() as { id: string; claim_id: string }[];

beforeEach(async () => {
  db = openDb(":memory:");
  migrate(db);
  vault = new Vault(tmpDir("brain-vault-"));
  for (let i = 0; i < 60; i++) vault.writeClaim(claimFixture({ id: `clm_${String(i).padStart(3, "0")}`, statement: `Fait ${i}.` }), `c${i}`);
  vault.writeClaim(claimFixture({ id: "clm_approved", review: "approved" }), "approved");
  vault.writeClaim(claimFixture({ id: "clm_gone", status: "retracted" }), "gone");
  await syncClaims(db, vault, null);
});

describe("precision audit", () => {
  it("samples 50 auto-accepted active claims never audited before", () => {
    expect(sampleAudit(db, vault, 50, NOW)).toBe(50);
    const ids = audits().map((a) => a.claim_id);
    expect(new Set(ids).size).toBe(50);
    expect(ids).not.toContain("clm_approved");
    expect(ids).not.toContain("clm_gone");
    expect(sampleAudit(db, vault, 50, NOW)).toBe(10);
    expect(sampleAudit(db, vault, 50, NOW)).toBe(0);
  });

  it("picks the same claims from the same vault", async () => {
    sampleAudit(db, vault, 5, NOW);
    const first = audits().map((a) => a.claim_id);
    const other = openDb(":memory:");
    migrate(other);
    await syncClaims(other, vault, null);
    sampleAudit(other, vault, 5, NOW);
    expect((other.prepare("SELECT claim_id FROM proposals ORDER BY rowid").all() as { claim_id: string }[]).map((r) => r.claim_id)).toEqual(first);
  });

  it("precision is kept over judged; edits are counted apart", () => {
    sampleAudit(db, vault, 10, NOW);
    const opts = { shownAt: NOW, now: NOW };
    const [a, b, c, d, e] = audits();
    resolveProposal(db, vault, a!.id, "accept", opts);
    resolveProposal(db, vault, b!.id, "accept", opts);
    resolveProposal(db, vault, c!.id, "accept", opts);
    resolveProposal(db, vault, d!.id, "reject", opts);
    resolveProposal(db, vault, e!.id, "edit", { ...opts, statement: "Fixed." });
    expect(auditReport(db)).toEqual({ judged: 5, kept: 3, edited: 1, retracted: 1, open: 5, precision: 0.6, aiAutoAccepted: 0 });
  });

  it("counts AI-origin claims that were auto-accepted", async () => {
    vault.writeClaim(claimFixture({ id: "clm_ai", origin: "ai_suggested" }), "planted");
    await syncClaims(db, vault, null);
    expect(auditReport(db)).toMatchObject({ judged: 0, precision: null, aiAutoAccepted: 1 });
  });
});
