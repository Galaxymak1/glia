import { beforeEach, describe, expect, it } from "vitest";
import { syncClaims } from "../src/claimIndex.js";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { ago, formatObserve, observe } from "../src/observe.js";
import { type TurnRow, writeSource } from "../src/sources.js";
import type { Config } from "../src/config.js";
import { Vault } from "../src/vault.js";
import { claimFixture, tmpDir } from "./helpers.js";

let db: ReturnType<typeof openDb>;
const NOW = new Date("2026-10-28T12:00:00Z");
const MODEL = "bge-m3";
const turn = (externalUuid: string, ts: string): TurnRow => ({ externalUuid, parentUuid: null, role: "user", ts, text: "bonjour", isSidechain: false, isInjected: false });
const CONFIG: Config = { claudeCode: { exclude: [] } };
const source = (kind: Parameters<typeof writeSource>[1]["kind"], ext: string, turns: TurnRow[]) =>
  writeSource(db, { kind, external_id: ext, title: ext, project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "r", raw_sha256: ext, parser_version: "t" }, turns);
function propose(id: string, kind: string, reason: string, over: { created?: string; expires?: string; snoozed?: string; state?: string } = {}) {
  db.prepare("INSERT INTO proposals (id, kind, claim_id, claim_json, reason, created_at, expires_at, snoozed_until, state) VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?)").run(
    id,
    kind,
    `clm_${id}`,
    reason,
    over.created ?? "2026-10-27T12:00:00Z",
    over.expires ?? "2026-11-26T12:00:00Z",
    over.snoozed ?? null,
    over.state ?? "open",
  );
}

beforeEach(async () => {
  db = openDb(":memory:");
  migrate(db);
  source("cc", "s1", [turn("u1", "2026-10-26T12:00:00Z"), turn("u2", "2026-10-28T11:00:00Z")]);
  source("cai", "c1", [turn("u1", "2026-10-20T12:00:00Z")]);
  source("cai", "c2", [turn("u1", "2026-10-28T11:30:00Z")]);
  db.prepare("UPDATE sources SET excluded = 1 WHERE external_id = 'c2'").run();
  const vault = new Vault(tmpDir("brain-vault-"));
  vault.writeClaim(claimFixture({ id: "clm_a", statement: "A." }), "a");
  vault.writeClaim(claimFixture({ id: "clm_b", statement: "B.", kind: "decision", origin: "user_confirmed" }), "b");
  vault.writeClaim(claimFixture({ id: "clm_c", statement: "C.", status: "retracted" }), "c");
  await syncClaims(db, vault, null);
  propose("p1", "claim", "sensitive");
  propose("p2", "claim", "similar:clm_a", { created: "2026-10-20T12:00:00Z", expires: "2026-11-01T12:00:00Z" });
  propose("p3", "claim", "similar:clm_b", { snoozed: "2026-11-01T00:00:00Z" });
  propose("p4", "audit", "audit");
  propose("p5", "claim", "origin:ai_suggested", { state: "rejected" });
  db.prepare("UPDATE proposals SET decided_at = '2026-10-27T10:00:00Z', decision_ms = 3000 WHERE id = 'p5'").run();
});

describe("observe", () => {
  it("counts what the brain holds, leaving excluded sources out", () => {
    const o = observe(db, "/x/glia.db", CONFIG, MODEL, NOW);
    expect(o.evidence).toMatchObject({ sources: { cc: 1, cai: 1 }, excluded: 1, turns: 3, lastTurn: "2026-10-28T11:00:00Z" });
    expect(o.claims.status).toEqual({ active: 2, retracted: 1 });
    expect(o.claims.kind).toMatchObject({ decision: 1 });
    expect(o.claims.origin).toMatchObject({ user_confirmed: 1 });
    expect(o.index).toMatchObject({ chunks: 0, embedded: 0, missingTurns: 3, claims: 3, claimsEmbedded: 0 });
  });

  it("groups the inbox by why each item is queued, similar ones together", () => {
    const o = observe(db, "/x/glia.db", CONFIG, MODEL, NOW);
    expect(o.inbox).toEqual({ open: 4, reasons: { sensitive: 1, similar: 2 }, audits: 1, snoozed: 1, oldest: "2026-10-20T12:00:00Z", expiringWeek: 1 });
    expect(o.review).toEqual({ week: 1, rejected: 1 });
  });

  it("reports no jobs and no evaluation before there are any", () => {
    const o = observe(db, "/x/glia.db", CONFIG, MODEL, NOW);
    expect(o.jobs).toEqual([]);
    expect(o.eval).toBeNull();
    expect(o.audit.gate).toBeNull();
  });

  it("shows the latest run of each job type", () => {
    db.prepare("INSERT INTO jobs (type, state, started_at, finished_at) VALUES ('sweep', 'done', '2026-10-28T10:00:00Z', '2026-10-28T10:01:00Z'), ('sweep', 'failed', '2026-10-28T11:00:00Z', '2026-10-28T11:01:00Z')").run();
    const o = observe(db, "/x/glia.db", CONFIG, MODEL, NOW);
    expect(o.jobs).toEqual([{ type: "sweep", state: "failed", at: "2026-10-28T11:01:00Z" }]);
    expect(o.failedDay).toBe(1);
  });
});

describe("formatObserve", () => {
  it("prints every section, plain without color", () => {
    const out = formatObserve(observe(db, "/x/glia.db", CONFIG, MODEL, NOW), { color: false });
    for (const h of ["Evidence", "Meaning index", "Extraction", "Claims", "Review inbox", "Audit", "Jobs", "Evaluation"]) expect(out).toContain(`\n${h}\n`);
    expect(out).toContain("3 to review");
    expect(out).toContain("sensitive 1, similar 2");
    expect(out).toContain("behind (run: glia index, glia index --claims)");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("colors only when asked", () => {
    expect(formatObserve(observe(db, "/x/glia.db", CONFIG, MODEL, NOW), { color: true })).toMatch(/\x1b\[/);
  });
});

describe("ago", () => {
  it("says how long ago, coarsely", () => {
    expect(ago(null, NOW)).toBe("never");
    expect(ago("2026-10-28T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-10-28T11:15:00Z", NOW)).toBe("45 min ago");
    expect(ago("2026-10-28T07:00:00Z", NOW)).toBe("5 h ago");
    expect(ago("2026-10-25T12:00:00Z", NOW)).toBe("3 d ago");
  });
});
