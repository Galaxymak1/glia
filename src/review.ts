// The review inbox in the terminal (#40, SPEC.md "Review inbox"): one card per proposal, one key
// per action. Every action is logged; nothing is deleted. Decision times feed the weekly health
// metrics: rejection rate and median decision time.

import type Database from "better-sqlite3";
import { claimRow, syncClaims } from "./claimIndex.js";
import { type Claim, ClaimSchema } from "./claims.js";
import { addEvidence } from "./dedup.js";
import { formatOpen, openEvidence } from "./mcp.js";
import { isoSeconds } from "./route.js";
import { appendLog, type Vault } from "./vault.js";

export type Action = "accept" | "edit" | "merge" | "reject" | "snooze";
export const KEYS: Record<string, Action> = { a: "accept", e: "edit", m: "merge", r: "reject", s: "snooze" };
export const SNOOZE_DAYS = 7;
const CARD_LINES = 20;
const QUOTE_CHARS = 300;
const STATEMENT_CHARS = 300;
const QUOTES_SHOWN = 4;

export interface Proposal {
  id: string;
  kind: "claim" | "decision" | "audit";
  claim_id: string;
  claim_json: string | null;
  reason: string;
  similar_to: string | null;
  created_at: string;
  state: string;
}

const cut = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const sourcesOf = (c: Claim) => [...new Set(c.evidence.map((e) => e.source))].join(", ");

/** Open items not snoozed past `now`, oldest first; `audit` lists the audit items only. */
export function inbox(db: Database.Database, now: Date, opts: { audit?: boolean } = {}): Proposal[] {
  return db
    .prepare(
      `SELECT id, kind, claim_id, claim_json, reason, similar_to, created_at, state FROM proposals
       WHERE state = 'open' AND (snoozed_until IS NULL OR snoozed_until <= ?) AND (? = 0 OR kind = 'audit')
       ORDER BY created_at, rowid`,
    )
    .all(isoSeconds(now), opts.audit ? 1 : 0) as Proposal[];
}

/** The claim a proposal is about: its own for a claim or decision, the vault's for an audit. */
function claimOf(db: Database.Database, p: Proposal): Claim {
  if (p.kind === "audit") {
    const c = claimRow(db, p.claim_id);
    if (!c) throw new Error(`${p.id}: claim ${p.claim_id} is not in the vault`);
    return c;
  }
  return ClaimSchema.parse(JSON.parse(p.claim_json!));
}

/** The turn id an evidence entry points to, for `open_evidence` and `o`. */
function turnIdOf(db: Database.Database, source: string, turn: string): number | null {
  const [kind, ...rest] = source.split(":");
  const r = db
    .prepare("SELECT t.id FROM turns t JOIN sources s ON s.id = t.source_id WHERE s.kind = ? AND s.external_id = ? AND t.external_uuid = ?")
    .get(kind, rest.join(":"), turn) as { id: number } | undefined;
  return r?.id ?? null;
}

export function formatCard(db: Database.Database, p: Proposal): string {
  const c = claimOf(db, p);
  const validity = c.valid_from ? `from ${c.valid_from} (${c.valid_from_precision})${c.valid_to ? ` → ${c.valid_to}` : ""}` : "undated";
  const lines = [
    `[${p.kind === "audit" ? `audit · ${c.kind}` : c.kind}] ${cut(c.statement, STATEMENT_CHARS)}`,
    `${c.origin} · ${c.scope} · ${validity}${c.sensitivity === "sensitive" ? " · sensitive" : ""}`,
    `queued: ${p.reason}`,
  ];
  if (c.options?.length) lines.push(`options: ${cut(c.options.map((o) => (o.rejected_because ? `${o.option} (rejected: ${o.rejected_because})` : o.option)).join("; "), QUOTE_CHARS)}`);
  if (c.rationale) lines.push(`rationale: ${cut(c.rationale, QUOTE_CHARS)}`);
  for (const e of c.evidence.slice(0, QUOTES_SHOWN)) {
    const id = turnIdOf(db, e.source, e.turn);
    lines.push(`"${cut(e.quote, QUOTE_CHARS)}" — turn ${id ?? "?"} (${e.source})`);
  }
  if (c.evidence.length > QUOTES_SHOWN) lines.push(`(+${c.evidence.length - QUOTES_SHOWN} more quotes)`);
  if (p.similar_to) {
    const s = claimRow(db, p.similar_to);
    lines.push(`similar to ${p.similar_to}: ${s ? cut(s.statement, STATEMENT_CHARS) : "(not in the vault)"}`);
  }
  return lines.slice(0, CARD_LINES).join("\n");
}

/** Applies one review action (SPEC.md "Actions"). Never deletes: a rejected statement keeps its key. */
export function resolveProposal(
  db: Database.Database,
  vault: Vault,
  id: string,
  action: Action,
  opts: { statement?: string; mergeInto?: string; shownAt: Date; now: Date },
): void {
  const p = db.prepare("SELECT id, kind, claim_id, claim_json, reason, similar_to, created_at, state FROM proposals WHERE id = ?").get(id) as Proposal | undefined;
  if (!p) throw new Error(`no proposal ${id}`);
  if (p.state !== "open") throw new Error(`${id} is not open (${p.state})`);
  const when = isoSeconds(opts.now);
  const log = (name: string, claimId: string, payload?: unknown) => appendLog(db, vault, { actor: "user", action: name, claim_id: claimId, payload: { proposal: id, ...(payload as object) } }, opts.now);
  const decide = db.prepare("UPDATE proposals SET state = ?, decided_at = ?, decision_ms = ?, shown_at = ? WHERE id = ?");
  const decided = (state: string) => decide.run(state, when, opts.now.getTime() - opts.shownAt.getTime(), isoSeconds(opts.shownAt), id);
  const c = claimOf(db, p);
  const statement = opts.statement?.trim();
  if (action === "edit" && !statement) throw new Error("edit needs a statement");

  if (action === "snooze") {
    const until = isoSeconds(new Date(opts.now.getTime() + SNOOZE_DAYS * 86_400_000));
    db.prepare("UPDATE proposals SET snoozed_until = ?, shown_at = ? WHERE id = ?").run(until, isoSeconds(opts.shownAt), id);
    log("snooze", c.id, { until });
    return;
  }

  if (p.kind === "audit") {
    if (action === "merge") throw new Error("an audit item cannot be merged: accept, edit or reject it");
    if (action === "accept") log("audit_ok", c.id);
    else if (action === "edit") {
      log("edit", c.id);
      vault.writeClaim({ ...c, statement: statement!, review: "edited", reviewed_at: when }, `edit ${c.id} from ${sourcesOf(c)}`);
    } else {
      log("reject", c.id);
      vault.writeClaim({ ...c, status: "retracted", review: "rejected", reviewed_at: when }, `retract ${c.id}`);
    }
    decided(action === "accept" ? "accepted" : action === "edit" ? "edited" : "rejected");
  } else if (action === "accept" || action === "edit") {
    log(action, c.id);
    const out: Claim = { ...c, status: "active", review: action === "edit" ? "edited" : "approved", reviewed_at: when, ...(action === "edit" ? { statement: statement! } : {}) };
    vault.writeClaim(out, `${action === "edit" ? "edit" : "approve"} ${c.id} from ${sourcesOf(c)}`);
    decided(action === "edit" ? "edited" : "accepted");
  } else if (action === "merge") {
    const targetId = opts.mergeInto ?? p.similar_to;
    if (!targetId) throw new Error("merge needs a claim to merge into");
    const target = claimRow(db, targetId);
    if (!target) throw new Error(`no claim ${targetId} in the vault`);
    const r = addEvidence(target, c.evidence);
    log("merge", targetId, { from: c.id, added: r.added });
    if (r.added) vault.writeClaim(r.claim, `evidence ${targetId} from ${sourcesOf(c)}`);
    decided("merged");
  } else {
    log("reject", c.id);
    decided("rejected");
  }
  // Without an embedder, syncClaims does all its work before it first awaits.
  void syncClaims(db, vault, null);
}

/** ISO 8601 week of a date: 2026-W43. */
function isoWeek(ts: string): string {
  const d = new Date(`${ts.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Per week: decisions made, share rejected, and the median time from card shown to key pressed. */
export function reviewStats(db: Database.Database): { week: string; decided: number; rejectionRate: number; medianSeconds: number }[] {
  const rows = db
    .prepare("SELECT state, decided_at, decision_ms FROM proposals WHERE state IN ('accepted', 'edited', 'merged', 'rejected') AND decided_at IS NOT NULL AND decision_ms IS NOT NULL ORDER BY decided_at")
    .all() as { state: string; decided_at: string; decision_ms: number }[];
  const weeks = new Map<string, typeof rows>();
  for (const r of rows) weeks.set(isoWeek(r.decided_at), [...(weeks.get(isoWeek(r.decided_at)) ?? []), r]);
  return [...weeks].map(([week, rs]) => {
    const ms = rs.map((r) => r.decision_ms).sort((a, b) => a - b);
    const mid = Math.floor(ms.length / 2);
    const median = ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2;
    return { week, decided: rs.length, rejectionRate: rs.filter((r) => r.state === "rejected").length / rs.length, medianSeconds: median / 1000 };
  });
}

export interface ReviewIo {
  keys: AsyncIterator<string>;
  ask(prompt: string, initial: string): Promise<string>;
  write(s: string): void;
}

const HINT = "[a]ccept  [e]dit  [m]erge  [r]eject  [s]nooze  [o]pen evidence  [q]uit";

/** Shows each inbox item and applies the key pressed, until the inbox is done or q. */
export async function runReview(db: Database.Database, vault: Vault, io: ReviewIo, now: () => Date, opts: { audit?: boolean } = {}): Promise<{ decided: number }> {
  const items = inbox(db, now(), opts);
  if (!items.length) {
    io.write("Inbox empty.\n");
    return { decided: 0 };
  }
  let decided = 0;
  for (const [i, p] of items.entries()) {
    io.write(`\n(${i + 1}/${items.length})\n${formatCard(db, p)}\n${HINT}\n`);
    const shownAt = now();
    for (;;) {
      const next = await io.keys.next();
      if (next.done || next.value === "q") return { decided };
      const key = next.value;
      if (key === "o") {
        const c = claimOf(db, p);
        const e = c.evidence[0];
        const turn = e ? turnIdOf(db, e.source, e.turn) : null;
        const r = turn === null ? null : openEvidence(db, turn, 2);
        io.write(`${r ? formatOpen(r) : "(evidence turn not found)"}\n${HINT}\n`);
        continue;
      }
      const action = KEYS[key];
      if (!action || (action === "merge" && p.kind === "audit")) continue;
      try {
        if (action === "edit") {
          const statement = await io.ask("statement: ", claimOf(db, p).statement);
          resolveProposal(db, vault, p.id, "edit", { statement, shownAt, now: now() });
        } else if (action === "merge") {
          const mergeInto = p.similar_to ?? (await io.ask("merge into claim id: ", ""));
          resolveProposal(db, vault, p.id, "merge", { mergeInto, shownAt, now: now() });
        } else resolveProposal(db, vault, p.id, action, { shownAt, now: now() });
      } catch (err) {
        io.write(`brain: ${err instanceof Error ? err.message : String(err)}\n${HINT}\n`);
        continue;
      }
      if (action !== "snooze") decided++;
      break;
    }
  }
  return { decided };
}
