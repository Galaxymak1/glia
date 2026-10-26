import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claimRow, syncClaims } from "../src/claimIndex.js";
import { type Claim, evidenceEntry, statementKey } from "../src/claims.js";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { formatCard, inbox, resolveProposal, reviewStats, runReview, SNOOZE_DAYS } from "../src/review.js";
import { isoSeconds } from "../src/route.js";
import { type TurnRow, writeSource } from "../src/sources.js";
import { Vault } from "../src/vault.js";
import { claimFixture, git, tmpDir } from "./helpers.js";

let db: ReturnType<typeof openDb>;
let vault: Vault;
const NOW = new Date("2026-10-22T10:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 86_400_000;

const turn = (externalUuid: string, text: string): TurnRow => ({ externalUuid, parentUuid: null, role: "user", ts: "2026-10-14T09:00:00Z", text, isSidechain: false, isInjected: false });

let n = 0;
function propose(kind: "claim" | "decision" | "audit", over: Partial<Claim> = {}, extra: { similar_to?: string; reason?: string; created?: Date } = {}): string {
  const id = `prp_${++n}`;
  const claim = claimFixture({ id: `clm_P${n}`, status: "proposed", review: "pending", origin: "ai_suggested", evidence: [evidenceEntry("cc:s1", "u1", "on part sur SQLite")], ...over });
  const created = extra.created ?? NOW;
  db.prepare(
    `INSERT INTO proposals (id, kind, claim_id, claim_json, statement_key, reason, similar_to, created_at, expires_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(id, kind, claim.id, kind === "audit" ? null : JSON.stringify(claim), statementKey(claim.statement), extra.reason ?? (kind === "audit" ? "audit" : "origin:ai_suggested"), extra.similar_to ?? null, isoSeconds(created), isoSeconds(new Date(created.getTime() + 30 * DAY)));
  return id;
}
const prop = (id: string) => db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Record<string, unknown>;
const logActions = () => (db.prepare("SELECT action FROM log ORDER BY rowid").all() as { action: string }[]).map((r) => r.action);
const head = () => git(vault.dir, "log", "-1", "--format=%s");

beforeEach(async () => {
  n = 0;
  db = openDb(":memory:");
  migrate(db);
  vault = new Vault(tmpDir("brain-vault-"));
  writeSource(db, { kind: "cc", external_id: "s1", title: "Brain session", project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: "a", parser_version: "t" }, [turn("u1", "Bon, on part sur SQLite, pas Postgres.")]);
  vault.writeClaim(claimFixture({ id: "clm_A", statement: "L'utilisateur utilise SQLite pour l'index." }), "seed");
  await syncClaims(db, vault, null);
});

describe("resolveProposal", () => {
  const opts = { shownAt: NOW, now: later(6000) };

  it("accept writes the claim approved and active, commits it, logs it", () => {
    const id = propose("claim");
    resolveProposal(db, vault, id, "accept", opts);
    expect(claimRow(db, "clm_P1")).toMatchObject({ review: "approved", status: "active", reviewed_at: "2026-10-22T10:00:06Z" });
    expect(head()).toBe("approve clm_P1 from cc:s1");
    expect(prop(id)).toMatchObject({ state: "accepted", decided_at: "2026-10-22T10:00:06Z", decision_ms: 6000 });
    expect(logActions()).toEqual(["accept"]);
  });

  it("edit writes the new statement, review edited", () => {
    const id = propose("claim");
    resolveProposal(db, vault, id, "edit", { ...opts, statement: "L'utilisateur a choisi SQLite." });
    expect(claimRow(db, "clm_P1")).toMatchObject({ statement: "L'utilisateur a choisi SQLite.", review: "edited", status: "active" });
    expect(head()).toBe("edit clm_P1 from cc:s1");
    expect(prop(id).state).toBe("edited");
    expect(logActions()).toEqual(["edit"]);
  });

  it("edit refuses an empty statement", () => {
    const id = propose("claim");
    expect(() => resolveProposal(db, vault, id, "edit", { ...opts, statement: "  " })).toThrow(/statement/);
    expect(prop(id).state).toBe("open");
  });

  it("merge attaches the evidence to the similar claim instead of creating one", () => {
    const id = propose("claim", { evidence: [evidenceEntry("cc:s1", "u1", "pas Postgres")] }, { similar_to: "clm_A" });
    resolveProposal(db, vault, id, "merge", opts);
    expect(claimRow(db, "clm_P1")).toBeNull();
    expect(claimRow(db, "clm_A")!.evidence).toHaveLength(2);
    expect(head()).toBe("evidence clm_A from cc:s1");
    expect(prop(id)).toMatchObject({ state: "merged" });
    expect(logActions()).toEqual(["merge"]);
  });

  it("merge into a claim that does not exist fails and changes nothing", () => {
    const id = propose("claim");
    expect(() => resolveProposal(db, vault, id, "merge", { ...opts, mergeInto: "clm_nope" })).toThrow(/clm_nope/);
    expect(prop(id).state).toBe("open");
  });

  it("reject writes nothing to the vault and keeps the statement key", () => {
    const id = propose("claim");
    const before = git(vault.dir, "rev-parse", "HEAD");
    resolveProposal(db, vault, id, "reject", opts);
    expect(git(vault.dir, "rev-parse", "HEAD")).toBe(before);
    expect(prop(id)).toMatchObject({ state: "rejected", statement_key: statementKey(claimFixture().statement) });
    expect(logActions()).toEqual(["reject"]);
  });

  it("snooze hides the item for 7 days and is not a decision", () => {
    const id = propose("claim");
    resolveProposal(db, vault, id, "snooze", opts);
    expect(SNOOZE_DAYS).toBe(7);
    expect(prop(id)).toMatchObject({ state: "open", snoozed_until: "2026-10-29T10:00:06Z", decided_at: null, decision_ms: null });
    expect(logActions()).toEqual(["snooze"]);
  });

  it("audit: accept leaves the claim unchanged, reject retracts it", () => {
    const ok = propose("audit", { id: "clm_A" });
    const before = git(vault.dir, "rev-parse", "HEAD");
    resolveProposal(db, vault, ok, "accept", opts);
    expect(git(vault.dir, "rev-parse", "HEAD")).toBe(before);
    expect(claimRow(db, "clm_A")!.status).toBe("active");
    const bad = propose("audit", { id: "clm_A" });
    resolveProposal(db, vault, bad, "reject", opts);
    expect(claimRow(db, "clm_A")).toMatchObject({ status: "retracted", review: "rejected" });
    expect(head()).toBe("retract clm_A");
    expect(logActions()).toEqual(["audit_ok", "reject"]);
  });

  it("audit: never overwrites a claim file edited since it was indexed", () => {
    const id = propose("audit", { id: "clm_A" });
    const path = join(vault.dir, "claims/2026/clm_A.md");
    writeFileSync(path, "half-finished edit");
    expect(() => resolveProposal(db, vault, id, "reject", opts)).toThrow(/changed on disk/);
    expect(readFileSync(path, "utf8")).toBe("half-finished edit");
    expect(prop(id).state).toBe("open");
  });

  it("audit: merge is not offered", () => {
    const id = propose("audit", { id: "clm_A" });
    expect(() => resolveProposal(db, vault, id, "merge", opts)).toThrow(/audit/);
  });

  it("a proposal already decided cannot be decided again", () => {
    const id = propose("claim");
    resolveProposal(db, vault, id, "reject", opts);
    expect(() => resolveProposal(db, vault, id, "accept", opts)).toThrow(/not open/);
  });
});

describe("inbox and card", () => {
  it("lists open items oldest first; a snoozed item comes back after 7 days; an expired one never shows", () => {
    const a = propose("claim", {}, { created: later(-2 * DAY) });
    const b = propose("decision", { kind: "decision" }, { created: later(-DAY) });
    const c = propose("claim");
    db.prepare("UPDATE proposals SET state = 'expired' WHERE id = ?").run(c);
    resolveProposal(db, vault, b, "snooze", { shownAt: NOW, now: NOW });
    expect(inbox(db, NOW).map((p) => p.id)).toEqual([a]);
    expect(inbox(db, later(7 * DAY + 1000)).map((p) => p.id)).toEqual([a, b]);
  });

  it("--audit lists audit items only", () => {
    propose("claim");
    const au = propose("audit", { id: "clm_A" });
    expect(inbox(db, NOW, { audit: true }).map((p) => p.id)).toEqual([au]);
    expect(inbox(db, NOW).map((p) => p.id)).toHaveLength(2);
  });

  it("a card shows statement, origin, scope, validity, reason and the quote with its turn", () => {
    const id = propose("claim", {}, { similar_to: "clm_A", reason: "similar:clm_A" });
    const card = formatCard(db, inbox(db, NOW).find((p) => p.id === id)!);
    const turnId = (db.prepare("SELECT id FROM turns WHERE external_uuid = 'u1'").get() as { id: number }).id;
    expect(card).toContain("L'utilisateur utilise SQLite pour l'index du brain.");
    expect(card).toContain("ai_suggested · project:ai-brain · from 2026-10 (month)");
    expect(card).toContain("queued: similar:clm_A");
    expect(card).toContain(`"on part sur SQLite" — turn ${turnId} (cc:s1)`);
    expect(card).toContain("similar to clm_A: L'utilisateur utilise SQLite pour l'index.");
  });

  it("a card fits on one screen", () => {
    const quotes = Array.from({ length: 12 }, (_, i) => evidenceEntry("cc:s1", "u1", `${"long quote ".repeat(60)}${i}`));
    const id = propose("decision", { kind: "decision", statement: "x".repeat(2000), evidence: quotes, options: [{ option: "A", rejected_because: "slow" }, { option: "B" }], rationale: "because" });
    const lines = formatCard(db, inbox(db, NOW).find((p) => p.id === id)!).split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.every((l) => l.length <= 400)).toBe(true);
  });
});

describe("runReview", () => {
  function scripted(keys: string[], answers: string[] = []) {
    const out: string[] = [];
    const k = keys[Symbol.iterator]();
    const a = answers[Symbol.iterator]();
    return {
      out,
      io: {
        keys: { next: async () => k.next() } as AsyncIterator<string>,
        ask: async () => a.next().value ?? "",
        write: (s: string) => void out.push(s),
      },
    };
  }

  it("the key loop triages a scripted session", async () => {
    for (let i = 0; i < 5; i++) propose("claim", {}, { created: later(i * 1000) });
    let t = NOW.getTime();
    const s = scripted(["a", "r", "x", "s", "e", "q"], ["Reworded."]);
    const r = await runReview(db, vault, s.io, () => new Date((t += 2000)));
    expect(r.decided).toBe(3);
    expect((db.prepare("SELECT state FROM proposals ORDER BY created_at").all() as { state: string }[]).map((p) => p.state)).toEqual(["accepted", "rejected", "open", "edited", "open"]);
    expect(claimRow(db, "clm_P4")!.statement).toBe("Reworded.");
    expect(s.out.join("")).toMatch(/\[a\]ccept/);
  });

  it("o shows the evidence in context without deciding", async () => {
    propose("claim");
    const s = scripted(["o", "q"]);
    expect((await runReview(db, vault, s.io, () => NOW)).decided).toBe(0);
    expect(s.out.join("")).toContain("Bon, on part sur SQLite, pas Postgres.");
  });

  it("an empty inbox says so", async () => {
    const s = scripted([]);
    await runReview(db, vault, s.io, () => NOW);
    expect(s.out.join("")).toContain("Inbox empty.");
  });
});

describe("reviewStats", () => {
  it("reports rejection rate and median decision time per week", () => {
    const ids = [propose("claim"), propose("claim"), propose("claim"), propose("claim"), propose("claim")];
    resolveProposal(db, vault, ids[0]!, "accept", { shownAt: NOW, now: later(4000) });
    resolveProposal(db, vault, ids[1]!, "accept", { shownAt: NOW, now: later(6000) });
    resolveProposal(db, vault, ids[2]!, "reject", { shownAt: NOW, now: later(6000) });
    resolveProposal(db, vault, ids[3]!, "edit", { shownAt: NOW, now: later(20000), statement: "Autre." });
    resolveProposal(db, vault, ids[4]!, "snooze", { shownAt: NOW, now: later(1000) });
    expect(reviewStats(db)).toEqual([{ week: "2026-W43", decided: 4, rejectionRate: 0.25, medianSeconds: 6 }]);
  });
});
