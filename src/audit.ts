// The write-precision audit (#42, SPEC.md "Metrics"): a sample of auto-accepted claims is
// resurfaced as audit items, judged by hand in `brain review --audit`, and counted. The Phase 1
// gate needs 80% or more kept, and no AI-origin claim ever auto-accepted.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { statementKey } from "./claims.js";
import { AUTO_ORIGINS, isoSeconds, PROPOSAL_DAYS } from "./route.js";
import { ulid } from "./ulid.js";
import { appendLog, type Vault } from "./vault.js";

export const AUDIT_SAMPLE = 50;
export const PRECISION_TARGET = 0.8;

/** Opens audit items for up to `n` auto-accepted active claims never audited, in a fixed hash order. */
export function sampleAudit(db: Database.Database, vault: Vault, n = AUDIT_SAMPLE, now = new Date()): number {
  const claims = db
    .prepare(
      `SELECT id, statement FROM claims c WHERE review = 'auto_accepted' AND status = 'active'
       AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.kind = 'audit' AND p.claim_id = c.id)`,
    )
    .all() as { id: string; statement: string }[];
  const order = (id: string) => createHash("sha256").update(`audit:${id}`).digest("hex");
  const picked = claims.sort((a, b) => order(a.id).localeCompare(order(b.id))).slice(0, n);
  const put = db.prepare(
    `INSERT INTO proposals (id, kind, claim_id, claim_json, statement_key, reason, created_at, expires_at, state)
     VALUES (?, 'audit', ?, NULL, ?, 'audit', ?, ?, 'open')`,
  );
  const expires = isoSeconds(new Date(now.getTime() + PROPOSAL_DAYS * 86_400_000));
  db.transaction(() => {
    for (const c of picked) put.run(`prp_${ulid(now.getTime())}`, c.id, statementKey(c.statement), isoSeconds(now), expires);
  })();
  if (picked.length) appendLog(db, vault, { actor: "user", action: "audit_sample", payload: { claims: picked.length } }, now);
  return picked.length;
}

export interface AuditReport {
  /** Audit items decided. */
  judged: number;
  /** Right as written. */
  kept: number;
  /** Right in substance, but the statement had to be fixed: not counted as kept. */
  edited: number;
  retracted: number;
  open: number;
  precision: number | null;
  /** Claims auto-accepted with an origin that must always be queued; the gate needs zero. */
  aiAutoAccepted: number;
}

export function auditReport(db: Database.Database): AuditReport {
  const count = (state: string) => (db.prepare("SELECT count(*) AS n FROM proposals WHERE kind = 'audit' AND state = ?").get(state) as { n: number }).n;
  const kept = count("accepted");
  const edited = count("edited");
  const retracted = count("rejected");
  const judged = kept + edited + retracted;
  const aiAutoAccepted = (
    db
      .prepare(`SELECT count(*) AS n FROM claims WHERE review = 'auto_accepted' AND origin NOT IN (${AUTO_ORIGINS.map(() => "?").join(", ")})`)
      .get(...AUTO_ORIGINS) as { n: number }
  ).n;
  return { judged, kept, edited, retracted, open: count("open"), precision: judged ? kept / judged : null, aiAutoAccepted };
}

export function formatAudit(r: AuditReport): string {
  const pct = r.precision === null ? "-" : `${Math.round(r.precision * 100)}%`;
  const gate =
    r.precision === null ? "not decided (nothing judged yet)" : r.precision >= PRECISION_TARGET && r.aiAutoAccepted === 0 ? "met" : "NOT met";
  return [
    `Write precision: ${r.kept}/${r.judged} (${pct}); ${r.edited} edited, ${r.retracted} retracted; ${r.open} still open`,
    `AI-origin claims auto-accepted: ${r.aiAutoAccepted}`,
    `Phase 1 gate (precision ${PRECISION_TARGET * 100}% or more, zero AI-origin auto-accepted): ${gate}`,
  ].join("\n");
}
