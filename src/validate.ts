// Validation of extracted candidates (#37, SPEC.md "Nightly extraction", steps 4 and 5, and
// "Origin rules"): a quote must be in the cited turn word for word, the origin must agree with who
// wrote the cited turns, relative time is resolved against the turn's timestamp, and
// psychological or personality judgements are dropped.

import type Database from "better-sqlite3";
import { evidenceEntry, type Origin, type Precision } from "./claims.js";
import { recalledStatements, requestText } from "./extractInput.js";

export type DropReason = "empty_statement" | "no_evidence" | "unknown_turn" | "quote_not_verbatim" | "personality" | "bad_scope";
export type Correction = "origin" | "quote_whitespace" | "valid_from";

/**
 * Judgements about who the user is inside, not what they do. "tends to" is left out on purpose:
 * "the user tends to deploy on Fridays" is a habit worth keeping.
 */
export const PERSONALITY_PATTERNS =
  /\b(personality|personnalité|anxious|anxieu[xs]e?|insecure|narciss\w*|perfectionnist\w*|perfectionist\w*|introvert\w*|extravert\w*|extrovert\w*|is the kind of person|est quelqu'un de|struggles with (?:self|confidence)|manque de confiance)\b/i;
const SCOPE = /^(global|project:[a-z0-9][a-z0-9-]*|context:[a-z0-9][a-z0-9-]*)$/;
const PASTED = /<pasted_content\b[^>\n]*>[\s\S]*?<\/pasted_content>/g;
const ATTACHMENT = /(?:^|\n)\[attachment [^\]\n]*\]/;

export interface CitedTurn {
  role: string;
  ts: string | null;
  /** The quote sits in pasted text or an attached file, not in the user's own words. */
  inPasted: boolean;
  sourceKind: string;
}

/**
 * The origin the cited turns support. An origin is only ever lowered, never raised to one that
 * can be auto-accepted: Claude's suggestion stays a suggestion whatever it cites.
 */
export function checkOrigin(claimed: Origin, cited: CitedTurn[]): Origin {
  if (claimed !== "user_stated" && claimed !== "user_confirmed") return claimed;
  if (cited.length && cited.every((t) => t.sourceKind === "mem" || t.role === "memory")) return "imported_memory";
  const own = cited.filter((t) => t.role === "user" && !t.inPasted && t.sourceKind !== "cap" && t.sourceKind !== "mem");
  if (!own.length && cited.some((t) => t.inPasted || t.sourceKind === "cap")) return "external_doc";
  if (!own.length) return "ai_suggested";
  if (claimed === "user_confirmed") {
    const proposed = cited.filter((t) => t.role === "assistant" && t.ts).map((t) => t.ts!);
    const agreed = own.some((t) => t.ts && proposed.some((p) => t.ts! > p));
    return agreed ? "user_confirmed" : "user_stated";
  }
  return "user_stated";
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
};
const MONTH_WORD = new RegExp(`(?<![\\p{L}])(${Object.keys(MONTHS).join("|")})(?![\\p{L}])(?:\\s+(\\d{4}))?`, "iu");
const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The model's date, if it is a date at all and not later than the turn; its precision follows its length. */
function modelDate(model: { valid_from: string | null; precision: Precision }, turnTs: string | null): { valid_from: string | null; valid_from_precision: Precision } {
  const v = model.valid_from;
  if (!v || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) return { valid_from: null, valid_from_precision: "unknown" };
  if (turnTs && v > turnTs.slice(0, v.length)) return { valid_from: null, valid_from_precision: "unknown" };
  const byLength: Precision = v.length === 4 ? "year" : v.length === 7 ? "month" : "day";
  return { valid_from: v, valid_from_precision: model.precision === "approx" ? "approx" : byLength };
}

/** Resolves the claim's time words against the timestamp of the turn that says them, not today. */
export function resolveValidFrom(
  expression: string | null,
  turnTs: string | null,
  model: { valid_from: string | null; precision: Precision },
): { valid_from: string | null; valid_from_precision: Precision } {
  const e = expression?.toLowerCase().replace(/’/g, "'").trim();
  if (!e || !turnTs || !/^\d{4}-\d{2}-\d{2}/.test(turnTs)) return modelDate(model, turnTs);
  // A future time says when something will start, not since when it holds.
  if (/\b(next|prochain|prochaine|coming|bientôt|soon)\b/.test(e)) return modelDate(model, turnTs);
  const day = new Date(`${turnTs.slice(0, 10)}T00:00:00Z`);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth() + 1;
  if (/\b(last year|l'an dernier|l'année dernière|l'an passé|l'année passée)/.test(e)) return { valid_from: String(y - 1), valid_from_precision: "year" };
  if (/\b(last month|le mois dernier|le mois passé)/.test(e)) {
    return { valid_from: m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`, valid_from_precision: "month" };
  }
  if (/\b(yesterday|hier)\b/.test(e)) return { valid_from: isoDay(new Date(day.getTime() - 86_400_000)), valid_from_precision: "day" };
  if (/\b(last week|la semaine dernière|la semaine passée)/.test(e)) return { valid_from: isoDay(new Date(day.getTime() - 7 * 86_400_000)), valid_from_precision: "approx" };
  const month = MONTH_WORD.exec(e);
  if (month) {
    const n = MONTHS[month[1]!]!;
    if (month[2]) return { valid_from: `${month[2]}-${pad(n)}`, valid_from_precision: "month" };
    return { valid_from: `${n <= m ? y : y - 1}-${pad(n)}`, valid_from_precision: "month" };
  }
  const year = /\b(\d{4})\b/.exec(e);
  if (year && Number(year[1]) <= y) return { valid_from: year[1]!, valid_from_precision: "year" };
  return modelDate(model, turnTs);
}

/** The span of `text` the quote matches, word for word with any spacing; null when it is not there. */
function findQuote(text: string, quote: string): { span: string; index: number; exact: boolean } | null {
  const q = quote.trim();
  if (!q) return null;
  const at = text.indexOf(q);
  if (at >= 0) return { span: q, index: at, exact: true };
  const words = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const m = new RegExp(words.join("\\s+")).exec(text);
  return m ? { span: m[0], index: m.index, exact: false } : null;
}

function inPasted(text: string, index: number): boolean {
  for (const m of text.matchAll(PASTED)) if (index >= m.index! && index < m.index! + m[0].length) return true;
  const attachment = ATTACHMENT.exec(text);
  return attachment !== null && index >= attachment.index;
}

export interface ValidationReport {
  checked: number;
  kept: number;
  corrected: Partial<Record<Correction, number>>;
  dropped: Partial<Record<DropReason, number>>;
}

interface CandidateEvidence {
  ref: string;
  turn_id: number | null;
  quote: string;
}

/** Validates every new candidate: kept ones become `valid` with evidence in vault form, the rest `dropped` with a reason. */
export function validateCandidates(db: Database.Database): ValidationReport {
  const report: ValidationReport = { checked: 0, kept: 0, corrected: {}, dropped: {} };
  const recalled = recalledStatements(db);
  const rows = db.prepare("SELECT id, claim_json FROM candidates WHERE state = 'new' ORDER BY id").all() as { id: number; claim_json: string }[];
  const turnOf = db.prepare(
    `SELECT t.external_uuid, t.role, t.ts, t.text, s.kind, s.external_id FROM turns t JOIN sources s ON s.id = t.source_id WHERE t.id = ?`,
  );
  const drop = db.prepare("UPDATE candidates SET state = 'dropped', reason = ? WHERE id = ?");
  const keep = db.prepare("UPDATE candidates SET state = 'valid', claim_json = ? WHERE id = ?");
  const bump = <K extends string>(counts: Partial<Record<K, number>>, k: K) => (counts[k] = (counts[k] ?? 0) + 1);

  db.transaction(() => {
    for (const row of rows) {
      report.checked++;
      const claim = JSON.parse(row.claim_json);
      const fail = (reason: DropReason) => {
        bump(report.dropped, reason);
        drop.run(reason, row.id);
      };
      const evidence = claim.evidence as CandidateEvidence[];
      if (typeof claim.statement !== "string" || !claim.statement.trim()) {
        fail("empty_statement");
        continue;
      }
      if (!evidence.length) {
        fail("no_evidence");
        continue;
      }
      if (PERSONALITY_PATTERNS.test(claim.statement)) {
        fail("personality");
        continue;
      }
      const scope = String(claim.scope).toLowerCase().trim();
      if (!SCOPE.test(scope)) {
        fail("bad_scope");
        continue;
      }
      const cited: CitedTurn[] = [];
      const entries: (ReturnType<typeof evidenceEntry> & { turn_id: number })[] = [];
      let reason: DropReason | null = null;
      let whitespace = false;
      for (const ev of evidence) {
        const t = ev.turn_id === null ? undefined : (turnOf.get(ev.turn_id) as { external_uuid: string; role: string; ts: string | null; text: string; kind: string; external_id: string } | undefined);
        if (!t) {
          reason = "unknown_turn";
          break;
        }
        // The text the model was sent: quotes are checked against nothing else.
        const text = requestText(t.text, recalled);
        const found = findQuote(text, ev.quote);
        if (!found) {
          reason = "quote_not_verbatim";
          break;
        }
        if (!found.exact) whitespace = true;
        cited.push({ role: t.role, ts: t.ts, inPasted: inPasted(text, found.index), sourceKind: t.kind });
        entries.push({ ...evidenceEntry(`${t.kind}:${t.external_id}`, t.external_uuid, found.span), turn_id: ev.turn_id! });
      }
      if (reason) {
        fail(reason);
        continue;
      }
      if (whitespace) bump(report.corrected, "quote_whitespace");
      const origin = checkOrigin(claim.origin, cited);
      if (origin !== claim.origin) bump(report.corrected, "origin");
      const time = resolveValidFrom(claim.time_expression, cited[0]!.ts, { valid_from: claim.valid_from, precision: claim.valid_from_precision });
      if (time.valid_from !== claim.valid_from) bump(report.corrected, "valid_from");
      const out = {
        ...claim,
        scope,
        origin,
        evidence: entries,
        ...time,
        decision: claim.kind === "decision" ? claim.decision : null,
      };
      keep.run(JSON.stringify(out), row.id);
      report.kept++;
    }
  })();
  return report;
}

export function formatValidation(r: ValidationReport): string {
  const labels: Record<Correction, string> = { origin: "origin corrected", quote_whitespace: "quote whitespace fixed", valid_from: "date resolved" };
  const corrected = Object.entries(r.corrected).map(([k, n]) => `${labels[k as Correction]} ${n}`);
  const dropped = Object.entries(r.dropped).map(([k, n]) => `${k} ${n}`);
  const total = Object.values(r.dropped).reduce((a, b) => a + (b ?? 0), 0);
  return (
    `Validated ${r.checked}: kept ${r.kept}` +
    (corrected.length ? ` (${corrected.join(", ")})` : "") +
    (total ? `; dropped ${total} (${dropped.join(", ")})` : "")
  );
}
