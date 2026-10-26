// One claim, one Markdown file (#34, SPEC.md "Claim layer"): YAML frontmatter carries the
// metadata, the body is the statement in its original language. The vault is the truth; the
// claim tables are rebuilt from these files, and Obsidian may rewrite them.

import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { z } from "zod";
import { CLAIM_KINDS, ORIGINS } from "./extractPrompt.js";

export const STATUSES = ["proposed", "active", "superseded", "retracted", "rejected", "expired"] as const;
export const REVIEWS = ["auto_accepted", "pending", "approved", "edited", "rejected"] as const;
export const PRECISIONS = ["day", "month", "year", "approx", "unknown"] as const;
export type Precision = (typeof PRECISIONS)[number];
export type Origin = (typeof ORIGINS)[number];

// YAML reads an unquoted 2024 as a number: a date field takes it back as text.
const dateText = z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string());
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const EvidenceSchema = z.object({
  source: z.string().regex(/^(cc|cai|cap|cad|caa|mem):.+$/, "kind:external_id"),
  turn: z.string().min(1),
  quote: z.string(),
  quote_sha256: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ClaimSchema = z.looseObject({
  id: z.string().regex(/^clm_[0-9A-Za-z_]+$/),
  kind: z.enum(CLAIM_KINDS),
  scope: z.string().regex(/^(global|project:.+|context:.+)$/),
  statement_lang: z.enum(["fr", "en", "mixed"]),
  origin: z.enum(ORIGINS),
  evidence: z.array(EvidenceSchema),
  extractor: z.object({ model: z.string(), prompt: z.string(), batch: z.string().nullable() }).nullable(),
  confidence: z.number().min(0).max(1),
  valid_from: dateText.nullable(),
  valid_from_precision: z.enum(PRECISIONS),
  valid_to: dateText.nullable(),
  recorded_at: dateText,
  supersedes: z.array(z.string()),
  superseded_by: z.string().nullable(),
  status: z.enum(STATUSES),
  review: z.enum(REVIEWS),
  reviewed_at: dateText.nullable(),
  sensitivity: z.enum(["normal", "sensitive"]),
  options: z.array(z.object({ option: z.string(), rejected_because: z.string().nullable().optional() })).optional(),
  rationale: z.string().nullable().optional(),
  expected_outcome: z.object({ text: z.string(), confidence: z.number() }).nullable().optional(),
  revisit_on: dateText.nullable().optional(),
  statement: z.string().min(1),
});
export type Claim = z.infer<typeof ClaimSchema>;

/** Frontmatter keys in the SPEC's order; properties added by hand follow them. */
const ORDER = [
  "id", "kind", "scope", "statement_lang", "origin", "evidence", "extractor", "confidence", "valid_from", "valid_from_precision",
  "valid_to", "recorded_at", "supersedes", "superseded_by", "status", "review", "reviewed_at", "sensitivity",
  "options", "rationale", "expected_outcome", "revisit_on",
];

/** An evidence entry for `quote` in turn `turn` of source `source` (`cc:<session>`, ...). */
export const evidenceEntry = (source: string, turn: string, quote: string): Evidence => ({ source, turn, quote, quote_sha256: sha256(quote) });

export function serializeClaim(c: Claim): string {
  const { statement, ...rest } = c;
  const front: Record<string, unknown> = {};
  for (const k of ORDER) if (k in rest && (rest as Record<string, unknown>)[k] !== undefined) front[k] = (rest as Record<string, unknown>)[k];
  for (const [k, v] of Object.entries(rest)) if (!(k in front) && v !== undefined) front[k] = v;
  // JSON_SCHEMA: timestamps stay strings, and a string that reads as a number is quoted.
  const text = yaml.dump(front, { schema: yaml.JSON_SCHEMA, lineWidth: -1 });
  return `---\n${text}---\n\n${statement.trim()}\n`;
}

/** Parses a claim file; throws naming `path` and the first bad field. */
export function parseClaimFile(text: string, path: string): Claim {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n?---\n([\s\S]*)$/);
  if (!m) throw new Error(`${path}: no frontmatter`);
  let front: unknown;
  try {
    front = yaml.load(m[1]!, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new Error(`${path}: frontmatter is not valid YAML (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
  }
  if (!front || typeof front !== "object" || Array.isArray(front)) throw new Error(`${path}: frontmatter is not a mapping`);
  const r = ClaimSchema.safeParse({ ...front, statement: m[2]!.trim() });
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new Error(`${path}: ${issue.path.join(".") || "claim"}: ${issue.message}`);
  }
  return r.data;
}

/**
 * The identity of a statement for "the same words": NFKC, lowercase, accents and spacing
 * folded, a final stop dropped. A rejected statement is remembered by this key.
 */
export function statementKey(statement: string): string {
  const norm = statement
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?…]+$/u, "")
    .trim();
  return sha256(norm);
}
