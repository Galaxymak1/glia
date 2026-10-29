import { beforeEach, describe, expect, it } from "vitest";
import { claimRow } from "../src/claimIndex.js";
import { evidenceEntry, statementKey } from "../src/claims.js";
import { openDb } from "../src/db.js";
import { CLAIM_KINDS, ORIGINS } from "../src/extractPrompt.js";
import { migrate } from "../src/migrations.js";
import { AUDIT_SHARE, AUTO_ORIGINS, expireProposals, isAuditPick, PROPOSAL_DAYS, rerouteProposals, routeCandidates, routeFor } from "../src/route.js";
import { type TurnRow, writeSource } from "../src/sources.js";
import { ulid } from "../src/ulid.js";
import { Vault } from "../src/vault.js";
import { git, tmpDir } from "./helpers.js";

let db: ReturnType<typeof openDb>;
let vault: Vault;
const NOW = new Date("2026-10-26T10:00:00Z");
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

const turn = (externalUuid: string): TurnRow => ({ externalUuid, parentUuid: null, role: "user", ts: "2026-10-14T09:00:00Z", text: "x", isSidechain: false, isInjected: false });
const sid = (kind: string, ext: string) => (db.prepare("SELECT id FROM sources WHERE kind = ? AND external_id = ?").get(kind, ext) as { id: number }).id;

let n = 0;
function candidate(over: Record<string, unknown> = {}, src: [string, string] = ["cc", "s1"]): number {
  const claim = {
    kind: "project_fact",
    scope: "project:ai-brain",
    statement: `L'utilisateur utilise SQLite ${++n}.`,
    statement_lang: "fr",
    origin: "user_stated",
    time_expression: "depuis mars",
    valid_from: "2026-03",
    valid_from_precision: "month",
    confidence: 0.9,
    sensitivity: "normal",
    decision: null,
    evidence: [{ ...evidenceEntry(`${src[0]}:${src[1]}`, "u1", `quote ${n}`), turn_id: 1 }],
    ...over,
  };
  const { lastInsertRowid } = db
    .prepare("INSERT INTO candidates (job_id, custom_id, ord, source_id, claim_json, model, prompt, batch_id, state, similar_to) VALUES (1, ?, 0, ?, ?, 'claude-haiku-5-5', 'extract@v2', 'msgbatch_9', 'valid', ?)")
    .run(`c${n}`, sid(src[0], src[1]), JSON.stringify(claim), (over.similar_to as string | undefined) ?? null);
  return Number(lastInsertRowid);
}
const cand = (id: number) => db.prepare("SELECT state, reason, claim_id FROM candidates WHERE id = ?").get(id) as { state: string; reason: string | null; claim_id: string | null };
const proposals = () => db.prepare("SELECT * FROM proposals ORDER BY rowid").all() as Record<string, string>[];

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  vault = new Vault(tmpDir("brain-vault-"));
  db.prepare("INSERT INTO jobs (id, type, state) VALUES (1, 'extract', 'done')").run();
  writeSource(db, { kind: "cc", external_id: "s1", title: "s1", project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: "a", parser_version: "t" }, [turn("u1")]);
  writeSource(db, { kind: "cai", external_id: "c2", title: "c2", project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: "a", parser_version: "t" }, [turn("u1")]);
});

describe("routeFor", () => {
  it.each(ORIGINS)("origin %s: auto-accepted only if not Claude's, normal and not similar, decisions included", (origin) => {
    for (const sensitivity of ["normal", "sensitive"])
      for (const kind of CLAIM_KINDS)
        for (const similar_to of [null, "clm_X"]) {
          const r = routeFor({ origin, sensitivity, kind, similar_to });
          expect(r.auto).toBe((AUTO_ORIGINS as readonly string[]).includes(origin) && sensitivity === "normal" && similar_to === null);
        }
  });

  it("only Claude's origins are queued for origin; imported memory and external documents are not", () => {
    expect([...AUTO_ORIGINS].sort()).toEqual(["external_doc", "imported_memory", "user_confirmed", "user_stated"]);
    expect(routeFor({ origin: "ai_inferred", sensitivity: "normal", kind: "profile", similar_to: null })).toEqual({ auto: false, reason: "origin:ai_inferred" });
    expect(routeFor({ origin: "user_stated", sensitivity: "normal", kind: "decision", similar_to: null })).toEqual({ auto: true });
  });

  it("names why an item is queued, in order", () => {
    expect(routeFor({ origin: "ai_suggested", sensitivity: "sensitive", kind: "decision", similar_to: null })).toEqual({ auto: false, reason: "origin:ai_suggested" });
    expect(routeFor({ origin: "user_stated", sensitivity: "sensitive", kind: "decision", similar_to: null })).toEqual({ auto: false, reason: "sensitive" });
    expect(routeFor({ origin: "user_stated", sensitivity: "sensitive", kind: "lesson", similar_to: null })).toEqual({ auto: false, reason: "sensitive" });
    expect(routeFor({ origin: "user_stated", sensitivity: "normal", kind: "lesson", similar_to: "clm_X" })).toEqual({ auto: false, reason: "similar:clm_X" });
  });
});

describe("routeCandidates", () => {
  it("each accepted claim is one git commit naming its source", () => {
    const a = candidate({}, ["cc", "s1"]);
    const b = candidate({}, ["cai", "c2"]);
    const r = routeCandidates(db, vault, NOW);
    expect(r.accepted).toBe(2);
    expect(git(vault.dir, "log", "--format=%s").split("\n")).toEqual([
      expect.stringMatching(/^accept clm_\w+ from cai:c2: L'utilisateur utilise SQLite \d+\.$/),
      expect.stringMatching(/^accept clm_\w+ from cc:s1: /),
    ]);
    const c = claimRow(db, cand(a).claim_id!)!;
    expect(c).toMatchObject({
      review: "auto_accepted",
      status: "active",
      recorded_at: "2026-10-26T10:00:00Z",
      valid_from: "2026-03",
      extractor: { model: "claude-haiku-5-5", prompt: "extract@v2", batch: "msgbatch_9" },
    });
    expect(c.evidence[0]).not.toHaveProperty("turn_id");
    expect(cand(b).state).toBe("accepted");
    expect(db.prepare("SELECT action FROM log WHERE claim_id = ?").all(c.id)).toEqual([{ action: "auto_accept" }]);
  });

  it("a decision of the user's is auto-accepted with its decision fields", () => {
    const d = candidate({ kind: "decision", decision: { options: [{ option: "Postgres", rejected_because: "RAM" }, { option: "SQLite", rejected_because: null }], rationale: "zero ops", revisit_on: "2027-01-15" } });
    expect(routeCandidates(db, vault, NOW)).toMatchObject({ accepted: 1, queued: 0 });
    const c = claimRow(db, cand(d).claim_id!)!;
    expect(c).toMatchObject({ kind: "decision", status: "active", review: "auto_accepted", rationale: "zero ops", revisit_on: "2027-01-15" });
    expect(c.options).toEqual([{ option: "Postgres", rejected_because: "RAM" }, { option: "SQLite", rejected_because: null }]);
  });

  it("every sensitive claim and every decision Claude suggested is queued, with its decision fields", () => {
    const d = candidate({ kind: "decision", origin: "ai_suggested", decision: { options: [{ option: "Postgres", rejected_because: "RAM" }, { option: "SQLite", rejected_because: null }], rationale: "zero ops", revisit_on: "2027-01-15" } });
    const s = candidate({ sensitivity: "sensitive" });
    const r = routeCandidates(db, vault, NOW);
    expect(r).toMatchObject({ accepted: 0, queued: 2 });
    expect([cand(d).state, cand(s).state]).toEqual(["queued", "queued"]);
    const [pd, ps] = proposals();
    expect(pd).toMatchObject({ kind: "decision", reason: "origin:ai_suggested", state: "open", expires_at: "2026-11-25T10:00:00Z" });
    expect(ps).toMatchObject({ kind: "claim", reason: "sensitive" });
    const claim = JSON.parse(pd!.claim_json!);
    expect(claim).toMatchObject({ status: "proposed", review: "pending", rationale: "zero ops", revisit_on: "2027-01-15", options: [{ option: "Postgres", rejected_because: "RAM" }, { option: "SQLite", rejected_because: null }] });
    expect(claim.id).toBe(pd!.claim_id);
    expect(pd!.statement_key).toBe(statementKey(claim.statement));
    expect(vault.readAll().entries).toEqual([]);
  });

  it("a similar candidate is queued with what it is similar to", () => {
    candidate({ similar_to: "clm_A" });
    routeCandidates(db, vault, NOW);
    expect(proposals()[0]).toMatchObject({ reason: "similar:clm_A", similar_to: "clm_A" });
  });

  it("a statement once rejected is never proposed again", () => {
    const statement = "L'utilisateur aime le jazz.";
    db.prepare(
      "INSERT INTO proposals (id, kind, claim_id, claim_json, statement_key, reason, created_at, expires_at, state) VALUES ('prp_old', 'claim', 'clm_old', '{}', ?, 'origin:ai_inferred', 'x', 'y', 'rejected')",
    ).run(statementKey(statement));
    const c = candidate({ statement: "l'utilisateur aime le JAZZ", origin: "ai_inferred" });
    const r = routeCandidates(db, vault, NOW);
    expect(r.previouslyRejected).toBe(1);
    expect(cand(c)).toMatchObject({ state: "dropped", reason: "previously_rejected" });
    expect(proposals()).toHaveLength(1);
  });

  it("routing is idempotent: candidates already routed are not routed again", () => {
    candidate();
    routeCandidates(db, vault, NOW);
    expect(routeCandidates(db, vault, NOW)).toMatchObject({ accepted: 0, queued: 0 });
  });

  it("an auto-accepted claim picked for audit gets an audit proposal", () => {
    for (let i = 0; i < 40; i++) candidate();
    const r = routeCandidates(db, vault, NOW);
    const audits = proposals().filter((p) => p.kind === "audit");
    expect(audits).toHaveLength(r.audits);
    for (const a of audits) {
      expect(isAuditPick(a.claim_id!)).toBe(true);
      expect(a).toMatchObject({ reason: "audit", state: "open" });
    }
  });
});

describe("audit and expiry", () => {
  it("about 10% of auto-accepted claims get an audit proposal", () => {
    const picks = Array.from({ length: 1000 }, () => `clm_${ulid()}`).filter(isAuditPick).length;
    expect(AUDIT_SHARE).toBe(0.1);
    expect(picks).toBeGreaterThanOrEqual(70);
    expect(picks).toBeLessThanOrEqual(130);
  });

  it("proposals unreviewed after 30 days expire and leave the inbox", () => {
    candidate({ origin: "ai_suggested" });
    routeCandidates(db, vault, NOW);
    expect(PROPOSAL_DAYS).toBe(30);
    expect(expireProposals(db, vault, addDays(NOW, 29))).toBe(0);
    expect(expireProposals(db, vault, addDays(NOW, 31))).toBe(1);
    expect(proposals()[0]!.state).toBe("expired");
    expect(db.prepare("SELECT action FROM log WHERE action = 'expire'").all()).toHaveLength(1);
  });
});

describe("rerouteProposals", () => {
  /** A proposal queued under the old policy: written as routeCandidates wrote it, with that reason. */
  function queuedUnder(reason: string, over: Record<string, unknown> = {}): { candidate: number; proposal: string } {
    const id = candidate({ origin: "ai_suggested" });
    routeCandidates(db, vault, NOW);
    const p = proposals().find((x) => x.claim_id === cand(id).claim_id)!;
    const claim = { ...JSON.parse(p.claim_json!), ...over };
    db.prepare("UPDATE proposals SET claim_json = ?, reason = ? WHERE id = ?").run(JSON.stringify(claim), reason, p.id);
    return { candidate: id, proposal: p.id! };
  }
  const prop = (id: string) => db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Record<string, string | null>;

  it("auto-accepts what the current routing accepts, leaves the inbox, and counts no review decision", () => {
    const d = queuedUnder("decision", { kind: "decision", origin: "user_stated" });
    const m = queuedUnder("origin:imported_memory", { origin: "imported_memory" });
    const r = rerouteProposals(db, vault, addDays(NOW, 1));
    expect(r.accepted).toBe(2);
    for (const x of [d, m]) {
      expect(prop(x.proposal)).toMatchObject({ state: "accepted", decided_at: "2026-10-27T10:00:00Z", decision_ms: null });
      expect(cand(x.candidate).state).toBe("accepted");
      expect(claimRow(db, cand(x.candidate).claim_id!)).toMatchObject({ status: "active", review: "auto_accepted" });
    }
    expect(vault.readAll().entries).toHaveLength(2);
  });

  it("leaves real risks open: Claude's, sensitive, similar", () => {
    const ai = queuedUnder("origin:ai_suggested");
    const sens = queuedUnder("decision", { kind: "decision", origin: "user_stated", sensitivity: "sensitive" });
    const sim = queuedUnder("similar:clm_A", { origin: "user_stated" });
    db.prepare("UPDATE proposals SET similar_to = 'clm_A' WHERE id = ?").run(sim.proposal);
    expect(rerouteProposals(db, vault, NOW)).toEqual({ accepted: 0, audits: 0 });
    for (const x of [ai, sens, sim]) expect(prop(x.proposal).state).toBe("open");
    expect([prop(ai.proposal).reason, prop(sens.proposal).reason, prop(sim.proposal).reason]).toEqual(["origin:ai_suggested", "sensitive", "similar:clm_A"]);
    expect(vault.readAll().entries).toEqual([]);
  });

  it("is idempotent", () => {
    queuedUnder("decision", { kind: "decision", origin: "user_stated" });
    expect(rerouteProposals(db, vault, NOW).accepted).toBe(1);
    expect(rerouteProposals(db, vault, NOW).accepted).toBe(0);
  });
});

describe("robustness", () => {
  it("leaves held candidates for a later poll", () => {
    const c = candidate();
    db.prepare("UPDATE candidates SET reason = 'held:no_meaning_index' WHERE id = ?").run(c);
    expect(routeCandidates(db, vault, NOW)).toMatchObject({ accepted: 0, queued: 0 });
    expect(cand(c).state).toBe("valid");
  });

  it("one bad candidate is dropped and does not stop the others", () => {
    const bad = candidate({ statement: "   " });
    const good = candidate();
    const r = routeCandidates(db, vault, NOW);
    expect(cand(bad)).toMatchObject({ state: "dropped", reason: expect.stringMatching(/^invalid: /) });
    expect(cand(good).state).toBe("accepted");
    expect(r).toMatchObject({ accepted: 1, invalid: 1 });
  });
});

