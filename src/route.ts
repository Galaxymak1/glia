// Routing (#39, SPEC.md "Review inbox", routing policy): a validated candidate is either
// auto-accepted, written to the vault and committed, or queued as a proposal for review. Only the
// user's own words, not sensitive, not a decision and not near an existing claim, skip the inbox.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { syncClaimRows } from "./claimIndex.js";
import { type Claim, ClaimSchema, type Evidence, type Origin, statementKey } from "./claims.js";
import { z } from "zod";
import { ulid } from "./ulid.js";
import { appendLog, type Vault } from "./vault.js";

export const AUTO_ORIGINS = ["user_stated", "user_confirmed"] as const;
/** An unreviewed proposal leaves the inbox after this many days (SPEC.md "Expired"). */
export const PROPOSAL_DAYS = 30;
/** Share of auto-accepted claims resurfaced at random for audit. */
export const AUDIT_SHARE = 0.1;

const DAY_MS = 86_400_000;
export const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function routeFor(c: { origin: string; sensitivity: string; kind: string; similar_to: string | null }): { auto: true } | { auto: false; reason: string } {
  if (!(AUTO_ORIGINS as readonly string[]).includes(c.origin)) return { auto: false, reason: `origin:${c.origin}` };
  if (c.kind === "decision") return { auto: false, reason: "decision" };
  if (c.sensitivity !== "normal") return { auto: false, reason: "sensitive" };
  if (c.similar_to) return { auto: false, reason: `similar:${c.similar_to}` };
  return { auto: true };
}

/** Deterministic, so a claim is picked or not whatever run it came from: one in ten by hash. */
export function isAuditPick(claimId: string): boolean {
  return Number.parseInt(createHash("sha256").update(claimId).digest("hex").slice(0, 8), 16) % Math.round(1 / AUDIT_SHARE) === 0;
}

interface ValidCandidate {
  kind: Claim["kind"];
  scope: string;
  statement: string;
  statement_lang: Claim["statement_lang"];
  origin: Origin;
  evidence: (Evidence & { turn_id?: number })[];
  valid_from: string | null;
  valid_from_precision: Claim["valid_from_precision"];
  confidence: number;
  sensitivity: Claim["sensitivity"];
  decision: { options: { option: string; rejected_because: string | null }[]; rationale: string | null; revisit_on: string | null } | null;
}

/** The claim a validated candidate becomes, accepted or proposed. */
function toClaim(c: ValidCandidate, row: { model: string; prompt: string; batch_id: string }, now: Date, accepted: boolean): Claim {
  const claim: Claim = {
    id: `clm_${ulid(now.getTime())}`,
    kind: c.kind,
    scope: c.scope,
    statement_lang: c.statement_lang,
    origin: c.origin,
    evidence: c.evidence.map(({ source, turn, quote, quote_sha256 }) => ({ source, turn, quote, quote_sha256 })),
    extractor: { model: row.model, prompt: row.prompt, batch: row.batch_id },
    confidence: Math.min(1, Math.max(0, c.confidence)),
    valid_from: c.valid_from,
    valid_from_precision: c.valid_from_precision,
    valid_to: null,
    recorded_at: isoSeconds(now),
    supersedes: [],
    superseded_by: null,
    status: accepted ? "active" : "proposed",
    review: accepted ? "auto_accepted" : "pending",
    reviewed_at: null,
    sensitivity: c.sensitivity,
    statement: c.statement,
  };
  if (c.kind === "decision" && c.decision) {
    claim.options = c.decision.options;
    if (c.decision.rationale) claim.rationale = c.decision.rationale;
    if (c.decision.revisit_on) claim.revisit_on = c.decision.revisit_on;
  }
  return ClaimSchema.parse(claim);
}

const sourcesOf = (c: { evidence: Evidence[] }) => [...new Set(c.evidence.map((e) => e.source))].join(", ");
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export interface RouteReport {
  accepted: number;
  queued: number;
  audits: number;
  previouslyRejected: number;
  /** Candidates that could not become a claim (a blank statement, a bad field): dropped, named in their reason. */
  invalid: number;
}

/** Routes every valid candidate. The claim file is committed before its row: a crash in between is closed by the next sync. */
export function routeCandidates(db: Database.Database, vault: Vault, now = new Date()): RouteReport {
  const report: RouteReport = { accepted: 0, queued: 0, audits: 0, previouslyRejected: 0, invalid: 0 };
  const rows = db
    .prepare("SELECT id, claim_json, similar_to, model, prompt, batch_id FROM candidates WHERE state = 'valid' AND (reason IS NULL OR reason NOT LIKE 'held:%') ORDER BY id")
    .all() as { id: number; claim_json: string; similar_to: string | null; model: string; prompt: string; batch_id: string }[];
  const rejected = db.prepare("SELECT 1 FROM proposals WHERE statement_key = ? AND state = 'rejected' LIMIT 1");
  const setState = db.prepare("UPDATE candidates SET state = ?, reason = ?, claim_id = ? WHERE id = ?");
  const propose = db.prepare(
    `INSERT INTO proposals (id, kind, claim_id, claim_json, statement_key, reason, similar_to, created_at, expires_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  );
  const created = isoSeconds(now);
  const expires = isoSeconds(new Date(now.getTime() + PROPOSAL_DAYS * DAY_MS));

  for (const row of rows) {
    const c = JSON.parse(row.claim_json) as ValidCandidate;
    const key = statementKey(c.statement);
    if (rejected.get(key)) {
      setState.run("dropped", "previously_rejected", null, row.id);
      report.previouslyRejected++;
      continue;
    }
    const route = routeFor({ origin: c.origin, sensitivity: c.sensitivity, kind: c.kind, similar_to: row.similar_to });
    let claim: Claim;
    try {
      claim = toClaim(c, row, now, route.auto);
    } catch (err) {
      // One bad candidate is dropped, not left to stop every later poll at the same place.
      const first = err instanceof z.ZodError ? err.issues[0] : undefined;
      setState.run("dropped", `invalid: ${first ? `${first.path.join(".")}: ${first.message}` : err instanceof Error ? err.message : String(err)}`, null, row.id);
      report.invalid++;
      continue;
    }
    if (route.auto) {
      appendLog(db, vault, { actor: "extractor", action: "auto_accept", claim_id: claim.id, payload: { candidate: row.id, sources: sourcesOf(claim) } }, now);
      vault.writeClaim(claim, `accept ${claim.id} from ${sourcesOf(claim)}: ${cut(claim.statement, 72)}`);
      setState.run("accepted", null, claim.id, row.id);
      report.accepted++;
      if (isAuditPick(claim.id)) {
        propose.run(`prp_${ulid(now.getTime())}`, "audit", claim.id, null, key, "audit", null, created, expires);
        report.audits++;
      }
      continue;
    }
    const id = `prp_${ulid(now.getTime())}`;
    propose.run(id, c.kind === "decision" ? "decision" : "claim", claim.id, JSON.stringify(claim), key, route.reason, row.similar_to, created, expires);
    appendLog(db, vault, { actor: "extractor", action: "propose", claim_id: claim.id, payload: { proposal: id, reason: route.reason } }, now);
    setState.run("queued", route.reason, claim.id, row.id);
    report.queued++;
  }
  if (report.accepted) syncClaimRows(db, vault);
  return report;
}

/** Moves proposals unreviewed for PROPOSAL_DAYS out of the inbox, so it never becomes a backlog. */
export function expireProposals(db: Database.Database, vault: Vault, now = new Date()): number {
  const due = db.prepare("SELECT id, claim_id FROM proposals WHERE state = 'open' AND expires_at <= ? ORDER BY id").all(isoSeconds(now)) as { id: string; claim_id: string }[];
  const expire = db.prepare("UPDATE proposals SET state = 'expired', decided_at = ? WHERE id = ?");
  for (const p of due) {
    expire.run(isoSeconds(now), p.id);
    appendLog(db, vault, { actor: "extractor", action: "expire", claim_id: p.claim_id, payload: { proposal: p.id } }, now);
  }
  return due.length;
}
