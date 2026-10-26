import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import type { ExtractedClaim } from "../src/extractPrompt.js";
import { migrate } from "../src/migrations.js";
import { type SourceRow, type TurnRow, writeSource } from "../src/sources.js";
import { checkOrigin, formatValidation, resolveValidFrom, validateCandidates } from "../src/validate.js";

let db: ReturnType<typeof openDb>;

const turn = (externalUuid: string, role: string, text: string, ts: string | null): TurnRow => ({ externalUuid, parentUuid: null, role, ts, text, isSidechain: false, isInjected: false });
function source(kind: SourceRow["kind"], external_id: string, turns: TurnRow[]): void {
  writeSource(db, { kind, external_id, title: external_id, project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "raw", raw_sha256: "abc", parser_version: "test" }, turns);
}
const tid = (uuid: string) => (db.prepare("SELECT id FROM turns WHERE external_uuid = ?").get(uuid) as { id: number }).id;
const sid = (ext: string) => (db.prepare("SELECT id FROM sources WHERE external_id = ?").get(ext) as { id: number }).id;

type Ev = { uuid: string; quote: string };
function candidate(name: string, over: Partial<ExtractedClaim> & { cites: Ev[]; src?: string }): void {
  const { cites, src = "s1", ...rest } = over;
  const claim = {
    kind: "project_fact",
    scope: "project:ai-brain",
    statement: `Statement ${name}.`,
    statement_lang: "fr",
    origin: "user_stated",
    time_expression: null,
    valid_from: null,
    valid_from_precision: "unknown",
    confidence: 0.9,
    sensitivity: "normal",
    decision: null,
    ...rest,
    evidence: cites.map((c) => ({ ref: "T1", turn_id: c.uuid === "missing" ? null : tid(c.uuid), quote: c.quote })),
  };
  db.prepare(
    "INSERT INTO candidates (job_id, custom_id, ord, source_id, claim_json, model, prompt, batch_id, state) VALUES (1, ?, 0, ?, ?, 'm', 'p', 'b', 'new')",
  ).run(name, sid(src), JSON.stringify(claim));
}
const row = (name: string) => {
  const r = db.prepare("SELECT state, reason, claim_json FROM candidates WHERE custom_id = ?").get(name) as { state: string; reason: string | null; claim_json: string };
  return { state: r.state, reason: r.reason, claim: JSON.parse(r.claim_json) };
};

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  db.prepare("INSERT INTO jobs (id, type, state) VALUES (1, 'extract', 'done')").run();
  source("cc", "s1", [
    turn("u1", "user", "Bon, on part sur SQLite, pas Postgres, pour l'index du brain.", "2026-10-14T09:00:00Z"),
    turn("a1", "assistant", "Je propose aussi d'utiliser Hono pour le serveur MCP.", "2026-10-14T09:00:10Z"),
    turn("u2", "user", "Oui, va pour Hono.", "2026-10-14T09:01:00Z"),
    turn("u3", "user", "Voici la doc:\n<pasted_content>The service requires Node 22 or later to run.</pasted_content>\nqu'en penses-tu ?", "2026-10-14T09:02:00Z"),
    turn("u4", "user", "On   part   sur\nSQLite pour de bon.", "2026-10-14T09:03:00Z"),
  ]);
  source("mem", "m1", [turn("n1", "memory", "The user deploys with Docker Compose on the VPS.", null)]);
  source("cap", "p1", [turn("d1", "user", "Project rule: all commits must be signed off.", "2026-10-14T09:00:00Z")]);
});

describe("validateCandidates", () => {
  it("drops a planted fake quote, a personality inference, and corrects a mislabelled origin", () => {
    candidate("c1", { cites: [{ uuid: "u1", quote: "on part sur MySQL" }] });
    candidate("c2", { statement: "L'utilisateur est perfectionniste et anxieux.", cites: [{ uuid: "u1", quote: "on part sur SQLite" }] });
    candidate("c3", { statement: "Le serveur MCP utilise Hono.", origin: "user_stated", cites: [{ uuid: "a1", quote: "utiliser Hono pour le serveur MCP" }] });
    const r = validateCandidates(db);
    expect(r.dropped).toMatchObject({ quote_not_verbatim: 1, personality: 1 });
    expect(row("c1")).toMatchObject({ state: "dropped", reason: "quote_not_verbatim" });
    expect(row("c2")).toMatchObject({ state: "dropped", reason: "personality" });
    expect(row("c3")).toMatchObject({ state: "valid" });
    expect(row("c3").claim.origin).toBe("ai_suggested");
    expect(r.corrected.origin).toBe(1);
  });

  it("writes kept evidence in vault form", () => {
    candidate("c1", { cites: [{ uuid: "u1", quote: "on part sur SQLite, pas Postgres" }] });
    validateCandidates(db);
    expect(row("c1").claim.evidence).toEqual([
      { source: "cc:s1", turn: "u1", quote: "on part sur SQLite, pas Postgres", quote_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), turn_id: tid("u1") },
    ]);
  });

  it("accepts a quote that differs only by whitespace and stores the turn's exact text", () => {
    candidate("c1", { cites: [{ uuid: "u4", quote: "On part sur SQLite pour de bon" }] });
    const r = validateCandidates(db);
    expect(row("c1").state).toBe("valid");
    expect(row("c1").claim.evidence[0].quote).toBe("On   part   sur\nSQLite pour de bon");
    expect(r.corrected.quote_whitespace).toBe(1);
  });

  it("drops a translated quote", () => {
    candidate("c1", { cites: [{ uuid: "u1", quote: "we are going with SQLite, not Postgres" }] });
    validateCandidates(db);
    expect(row("c1").reason).toBe("quote_not_verbatim");
  });

  it("drops a claim citing no turn, or a turn the request did not hold", () => {
    candidate("c1", { cites: [] });
    candidate("c2", { cites: [{ uuid: "missing", quote: "x" }] });
    validateCandidates(db);
    expect(row("c1").reason).toBe("no_evidence");
    expect(row("c2").reason).toBe("unknown_turn");
  });

  it("drops a bad scope, lowercases a good one, and strips decision fields from a non-decision", () => {
    candidate("c1", { scope: "the brain", cites: [{ uuid: "u1", quote: "on part sur SQLite" }] });
    candidate("c2", { scope: "Project:AI-Brain", cites: [{ uuid: "u1", quote: "on part sur SQLite" }], decision: { options: [], rationale: "x", revisit_on: null } });
    validateCandidates(db);
    expect(row("c1").reason).toBe("bad_scope");
    expect(row("c2").claim).toMatchObject({ scope: "project:ai-brain", decision: null });
  });

  it("dates a claim from the turn that says it", () => {
    candidate("c1", { time_expression: "depuis mars", valid_from: "2026-10-14", valid_from_precision: "day", cites: [{ uuid: "u1", quote: "on part sur SQLite" }] });
    validateCandidates(db);
    expect(row("c1").claim).toMatchObject({ valid_from: "2026-03", valid_from_precision: "month" });
  });

  it("only validates new candidates", () => {
    candidate("c1", { cites: [{ uuid: "u1", quote: "on part sur SQLite" }] });
    validateCandidates(db);
    expect(validateCandidates(db)).toMatchObject({ kept: 0 });
  });

  it("counts drops by reason in the run summary", () => {
    candidate("c1", { cites: [{ uuid: "u1", quote: "on part sur MySQL" }] });
    candidate("c2", { statement: "The user is an introvert.", cites: [{ uuid: "u1", quote: "on part sur SQLite" }] });
    candidate("c3", { cites: [{ uuid: "u1", quote: "on part sur SQLite" }] });
    expect(formatValidation(validateCandidates(db))).toBe("Validated 3: kept 1; dropped 2 (quote_not_verbatim 1, personality 1)");
  });

  it("keeps a habit: 'tends to' is not a personality judgement", () => {
    candidate("c1", { statement: "The user tends to deploy on Fridays.", cites: [{ uuid: "u1", quote: "on part sur SQLite" }] });
    validateCandidates(db);
    expect(row("c1").state).toBe("valid");
  });

  it("marks a quote from pasted text external_doc, from memory imported_memory, from a project doc external_doc", () => {
    candidate("c1", { cites: [{ uuid: "u3", quote: "The service requires Node 22 or later" }] });
    candidate("c2", { src: "m1", cites: [{ uuid: "n1", quote: "deploys with Docker Compose on the VPS" }] });
    candidate("c3", { src: "p1", cites: [{ uuid: "d1", quote: "all commits must be signed off" }] });
    validateCandidates(db);
    expect([row("c1"), row("c2"), row("c3")].map((r) => r.claim.origin)).toEqual(["external_doc", "imported_memory", "external_doc"]);
  });
});

describe("resolveValidFrom", () => {
  const none = { valid_from: null, precision: "unknown" as const };
  it.each([
    ["since March", "2026-10-14T09:00:00Z", "2026-03", "month"],
    ["depuis mars", "2026-10-14T09:00:00Z", "2026-03", "month"],
    ["since November", "2026-10-14T09:00:00Z", "2025-11", "month"],
    ["en octobre", "2026-10-14T09:00:00Z", "2026-10", "month"],
    ["depuis mars 2024", "2026-10-14T09:00:00Z", "2024-03", "month"],
    ["depuis 2024", "2026-10-14T09:00:00Z", "2024", "year"],
    ["last year", "2026-10-14T09:00:00Z", "2025", "year"],
    ["l'année dernière", "2026-10-14T09:00:00Z", "2025", "year"],
    ["le mois dernier", "2026-01-14T09:00:00Z", "2025-12", "month"],
    ["yesterday", "2026-10-14T09:00:00Z", "2026-10-13", "day"],
    ["hier", "2026-03-01T09:00:00Z", "2026-02-28", "day"],
    ["la semaine dernière", "2026-10-14T09:00:00Z", "2026-10-07", "approx"],
  ] as const)("resolves %s in a message of %s to %s, precision %s", (expr, ts, from, precision) => {
    expect(resolveValidFrom(expr, ts, none)).toEqual({ valid_from: from, valid_from_precision: precision });
  });

  it("keeps the model's date only when it is well formed and not after the turn", () => {
    const ts = "2026-10-14T09:00:00Z";
    expect(resolveValidFrom(null, ts, { valid_from: "2026-09", precision: "month" })).toEqual({ valid_from: "2026-09", valid_from_precision: "month" });
    expect(resolveValidFrom(null, ts, { valid_from: "2026-09-01", precision: "approx" })).toEqual({ valid_from: "2026-09-01", valid_from_precision: "approx" });
    expect(resolveValidFrom(null, ts, { valid_from: "2026-11", precision: "month" })).toEqual({ valid_from: null, valid_from_precision: "unknown" });
    expect(resolveValidFrom(null, ts, { valid_from: "Sept 2026", precision: "month" })).toEqual({ valid_from: null, valid_from_precision: "unknown" });
    expect(resolveValidFrom(null, ts, { valid_from: "2026", precision: "day" })).toEqual({ valid_from: "2026", valid_from_precision: "year" });
  });

  it("does not move 'next March' into the past", () => {
    expect(resolveValidFrom("next March", "2026-10-14T09:00:00Z", { valid_from: null, precision: "unknown" })).toEqual({ valid_from: null, valid_from_precision: "unknown" });
  });

  it("with no timestamp, keeps a well-formed model date", () => {
    expect(resolveValidFrom("since March", null, { valid_from: "2026-03", precision: "month" })).toEqual({ valid_from: "2026-03", valid_from_precision: "month" });
  });
});

describe("checkOrigin", () => {
  const T0 = "2026-10-14T09:00:00Z";
  const T1 = "2026-10-14T09:01:00Z";
  const t = (role: string, extra: Partial<{ ts: string | null; inPasted: boolean; sourceKind: string }> = {}) => ({ role, ts: T0, inPasted: false, sourceKind: "cc", ...extra });
  it.each([
    ["user_stated", [t("assistant")], "ai_suggested"],
    ["user_confirmed", [t("assistant", { ts: T0 }), t("user", { ts: T1 })], "user_confirmed"],
    ["user_confirmed", [t("user", { ts: T0 }), t("assistant", { ts: T1 })], "user_stated"],
    ["user_confirmed", [t("assistant")], "ai_suggested"],
    ["user_confirmed", [t("user")], "user_stated"],
    ["user_stated", [t("user", { inPasted: true })], "external_doc"],
    ["user_stated", [t("memory", { sourceKind: "mem", ts: null })], "imported_memory"],
    ["user_stated", [t("user", { sourceKind: "cap" })], "external_doc"],
    ["ai_suggested", [t("user")], "ai_suggested"],
    ["ai_inferred", [t("user")], "ai_inferred"],
  ] as const)("origin %s citing %j becomes %s", (claimed, cited, expected) => {
    expect(checkOrigin(claimed, [...cited])).toBe(expected);
  });
});
