// Deduplication (#38, SPEC.md "Nightly extraction", step 6): a candidate that states a fact the
// brain already holds adds its evidence to that claim, open proposal or earlier candidate instead
// of becoming a new one. A near statement that may say something different is left for review.

import type Database from "better-sqlite3";
import { claimFileSha, claimFromRow, syncClaims } from "./claimIndex.js";
import { type Claim, type Evidence, statementKey } from "./claims.js";
import type { Embedder } from "./embed.js";
import { isFunctionWord } from "./enrich.js";
import { appendLog, type Vault } from "./vault.js";

/**
 * BGE-M3 (Q8_0) cosines measured for #38: rewordings of one fact 0.953 to 0.974; a synonym
 * rewording with few shared words ("réponses courtes", "réponses brèves") 0.927; the same
 * sentence about the opposite thing ("dark mode", "light mode") 0.922, ("le matin", "le soir")
 * 0.891. Merging needs 0.94 and shared words, so the opposites are left for review.
 */
export const MERGE_SIMILARITY = 0.94;
export const SIMILAR_SIMILARITY = 0.85;
/** Share of content words two statements must share to merge. */
export const MERGE_OVERLAP = 0.5;

const words = (s: string) => s.split(/\s+/).map((w) => w.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")).filter(Boolean);

/**
 * Words that name something: a number or version, a capital past the start of a sentence
 * (SQLite, Postgres), a dotted, slashed or dashed name. Two statements naming different things
 * are never one fact, however close their vectors.
 */
function distinctive(s: string): string {
  const out = new Set<string>();
  let sentenceStart = true;
  for (const raw of s.split(/\s+/)) {
    const w = raw.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
    if (w && (/\d/.test(w) || /\p{L}[._/-]\p{L}/u.test(w) || (!sentenceStart && /\p{Lu}/u.test(w)) || /^.+\p{Lu}/u.test(w.replace(/^\p{L}'/u, "")))) out.add(w.toLowerCase());
    if (w) sentenceStart = /[.!?]$/.test(raw);
  }
  return [...out].sort().join(" ");
}

function contentWords(s: string): Set<string> {
  return new Set(
    words(s.toLowerCase().replace(/[’']/g, " "))
      .filter((w) => w.length >= 3 && !isFunctionWord(w)),
  );
}

/** Whether two statements in one scope are one fact (`merge`), maybe one fact (`similar`), or two. */
export function sameFact(a: string, b: string, cosine: number | null): "merge" | "similar" | "different" {
  if (statementKey(a) === statementKey(b)) return "merge";
  if (cosine === null || distinctive(a) !== distinctive(b)) return "different";
  const wa = contentWords(a);
  const wb = contentWords(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const overlap = shared / (new Set([...wa, ...wb]).size || 1);
  if (cosine >= MERGE_SIMILARITY && overlap >= MERGE_OVERLAP) return "merge";
  if (cosine >= SIMILAR_SIMILARITY) return "similar";
  return "different";
}

type CandidateEvidence = Evidence & { turn_id?: number };
const vaultForm = ({ source, turn, quote, quote_sha256 }: CandidateEvidence): Evidence => ({ source, turn, quote, quote_sha256 });
const sameEvidence = (a: Evidence, b: Evidence) => a.source === b.source && a.turn === b.turn && a.quote_sha256 === b.quote_sha256;

/** The claim with every entry it did not hold yet, in vault form. */
export function addEvidence<C extends { evidence: Evidence[] }>(target: C, evidence: CandidateEvidence[]): { claim: C; added: number } {
  const out = [...target.evidence];
  let added = 0;
  for (const e of evidence) {
    if (out.some((x) => sameEvidence(x, e))) continue;
    out.push(vaultForm(e));
    added++;
  }
  return { claim: { ...target, evidence: out }, added };
}

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
};
const asVector = (blob: Buffer) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

export interface DedupReport {
  merged: { intoClaims: number; intoProposals: number; intoCandidates: number };
  similar: number;
  evidenceSkipped: number;
  /** The embedder failed: only equal statements were merged, and nothing was marked similar. */
  exactOnly: boolean;
  /** Candidates kept back from routing until the meaning index is back (exactOnly runs). */
  held: number;
  previouslyRejected: number;
  /** Claim files that did not parse: their claims are not merged into. */
  syncErrors: string[];
}

/** Statements embedded per request, as syncClaims does: one large run is never one huge request. */
const EMBED_BATCH = 32;
export const HELD = "held:no_meaning_index";

interface Target {
  kind: "claim" | "proposal" | "candidate" | "rejected";
  id: string;
  scope: string;
  statement: string;
  vector: Float32Array | null;
}

/** Merges every valid candidate that repeats a claim, an open proposal or an earlier candidate of this run. */
export async function dedupCandidates(db: Database.Database, vault: Vault, embedder: Embedder | null): Promise<DedupReport> {
  const report: DedupReport = { merged: { intoClaims: 0, intoProposals: 0, intoCandidates: 0 }, similar: 0, evidenceSkipped: 0, exactOnly: false, held: 0, previouslyRejected: 0, syncErrors: [] };
  // Obsidian edits count: claims are compared as their files hold them now.
  report.syncErrors = (await syncClaims(db, vault, embedder)).errors;
  const rows = db.prepare("SELECT id, claim_json FROM candidates WHERE state = 'valid' ORDER BY id").all() as { id: number; claim_json: string }[];
  if (!rows.length) return report;
  const proposals = db.prepare("SELECT id, claim_id, claim_json FROM proposals WHERE state = 'open' AND claim_json IS NOT NULL ORDER BY id").all() as { id: string; claim_id: string; claim_json: string }[];
  // What the user rejected, in any wording close enough to merge: never proposed again.
  const rejected = db
    .prepare(
      `SELECT p.id, COALESCE(json_extract(p.claim_json, '$.statement'), c.statement) AS statement, COALESCE(json_extract(p.claim_json, '$.scope'), c.scope) AS scope
       FROM proposals p LEFT JOIN claims c ON c.id = p.claim_id WHERE p.state = 'rejected' ORDER BY p.id`,
    )
    .all() as { id: string; statement: string | null; scope: string | null }[];

  let vectors = new Map<string, Float32Array>();
  if (embedder) {
    const texts = [
      ...new Set([
        ...rows.map((r) => JSON.parse(r.claim_json).statement as string),
        ...proposals.map((p) => JSON.parse(p.claim_json).statement as string),
        ...rejected.flatMap((r) => (r.statement ? [r.statement] : [])),
      ]),
    ];
    try {
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const out = await embedder.embed(batch);
        batch.forEach((t, j) => vectors.set(t, out[j]!));
      }
    } catch {
      vectors = new Map();
      report.exactOnly = true;
    }
  } else report.exactOnly = true;

  const claimVector = db.prepare("SELECT embedding FROM claims_vec WHERE claim_n = ? AND model = ?");
  const claimTargets: Target[] = (db.prepare("SELECT n, id, scope, statement FROM claims WHERE status = 'active' ORDER BY id").all() as { n: number; id: string; scope: string; statement: string }[]).map((c) => {
    const v = !report.exactOnly && embedder ? (claimVector.get(BigInt(c.n), embedder.model) as { embedding: Buffer } | undefined) : undefined;
    return { kind: "claim", id: c.id, scope: c.scope, statement: c.statement, vector: v ? asVector(v.embedding) : null };
  });
  const proposalTargets: Target[] = proposals.map((p) => {
    const c = JSON.parse(p.claim_json) as Claim;
    return { kind: "proposal", id: p.id, scope: c.scope, statement: c.statement, vector: vectors.get(c.statement) ?? null };
  });
  const rejectedTargets: Target[] = rejected.flatMap((r) =>
    r.statement && r.scope ? [{ kind: "rejected" as const, id: r.id, scope: r.scope, statement: r.statement, vector: vectors.get(r.statement) ?? null }] : [],
  );
  const kept: Target[] = [];

  const setState = db.prepare("UPDATE candidates SET state = ?, claim_id = ?, similar_to = ?, reason = ? WHERE id = ?");
  const setJson = db.prepare("UPDATE candidates SET claim_json = ? WHERE id = ?");
  const setProposal = db.prepare("UPDATE proposals SET claim_json = ? WHERE id = ?");

  for (const row of rows) {
    const cand = JSON.parse(row.claim_json) as { statement: string; scope: string; evidence: CandidateEvidence[] };
    const v = vectors.get(cand.statement) ?? null;
    const judge = (t: Target) => sameFact(cand.statement, t.statement, report.exactOnly || !v || !t.vector ? null : cosine(v, t.vector));
    let merged = false;
    let similarTo: string | null = null;
    for (const t of [...rejectedTargets, ...claimTargets, ...proposalTargets, ...kept]) {
      if (t.scope !== cand.scope) continue;
      const verdict = judge(t);
      if (verdict === "similar" && t.kind === "claim" && !similarTo) similarTo = t.id;
      if (verdict !== "merge") continue;
      if (t.kind === "rejected") {
        merged = true;
        setState.run("dropped", null, null, "previously_rejected", row.id);
        report.previouslyRejected++;
        break;
      }
      if (t.kind === "claim") {
        const claim = claimFromRow(db.prepare("SELECT * FROM claims WHERE id = ?").get(t.id) as Record<string, unknown>);
        const r = addEvidence(claim, cand.evidence);
        if (r.added) {
          const sources = [...new Set(cand.evidence.map((e) => e.source))].join(", ");
          const sha = claimFileSha(db, t.id);
          // The user is editing that file (or left it broken): it is never overwritten, and the
          // candidate goes to review next to it instead.
          if (!vault.isUnchanged(r.claim, sha)) {
            similarTo = t.id;
            break;
          }
          appendLog(db, vault, { actor: "extractor", action: "add_evidence", claim_id: t.id, payload: { candidate: row.id, sources } });
          vault.writeClaim(r.claim, `evidence ${t.id} from ${sources}`, { expectSha: sha });
        } else report.evidenceSkipped++;
        merged = true;
        setState.run("merged", t.id, null, `merged:claim`, row.id);
        report.merged.intoClaims++;
      } else if (t.kind === "proposal") {
        merged = true;
        const p = db.prepare("SELECT claim_id, claim_json FROM proposals WHERE id = ?").get(t.id) as { claim_id: string; claim_json: string };
        const r = addEvidence(JSON.parse(p.claim_json) as Claim, cand.evidence);
        if (r.added) setProposal.run(JSON.stringify(r.claim), t.id);
        else report.evidenceSkipped++;
        setState.run("merged", p.claim_id, null, `merged:proposal:${t.id}`, row.id);
        report.merged.intoProposals++;
      } else {
        merged = true;
        const first = db.prepare("SELECT claim_json FROM candidates WHERE id = ?").get(Number(t.id)) as { claim_json: string };
        const target = JSON.parse(first.claim_json) as { evidence: CandidateEvidence[] };
        // Kept with its turn ids: the candidate is still on its way to routing.
        const fresh = cand.evidence.filter((e) => !target.evidence.some((x) => sameEvidence(x, e)));
        if (fresh.length) setJson.run(JSON.stringify({ ...target, evidence: [...target.evidence, ...fresh] }), Number(t.id));
        else report.evidenceSkipped++;
        setState.run("merged", null, null, `merged:candidate:${t.id}`, row.id);
        report.merged.intoCandidates++;
      }
      break;
    }
    if (merged) continue;
    // Without the meaning index, a rewording or a contradiction of a claim cannot be seen: the
    // candidate waits for the next poll instead of being auto-accepted next to it.
    const held = report.exactOnly ? HELD : null;
    setState.run("valid", null, similarTo, held, row.id);
    if (similarTo) report.similar++;
    if (held) report.held++;
    kept.push({ kind: "candidate", id: String(row.id), scope: cand.scope, statement: cand.statement, vector: v });
  }
  await syncClaims(db, vault, report.exactOnly ? null : embedder);
  return report;
}
