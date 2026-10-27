// The extraction prompt and its output schema (SPEC.md, "Nightly extraction", steps 3 and 4).
// Draft checked by #32 on French, English and mixed sources; v2 adds the four fixes #32 found.
// The extractor (#36) sends it through the Batch API. A change to the prompt or schema bumps EXTRACT_PROMPT_VERSION,
// which every claim records in `extractor.prompt`.

import { z } from "zod";
import { embedView } from "./chunk.js";
import { splitInjected } from "./enrich.js";

export const EXTRACT_PROMPT_VERSION = "extract@v3";
export const EXTRACT_MODEL = "claude-haiku-5-5";

export const CLAIM_KINDS = ["profile", "preference", "project_fact", "decision", "lesson", "procedure"] as const;
export const ORIGINS = ["user_stated", "user_confirmed", "ai_suggested", "ai_inferred", "external_doc", "imported_memory"] as const;

const Evidence = z.object({
  turn: z.string().describe("The id of the turn holding the quote, e.g. T12"),
  quote: z.string().describe("Words copied exactly from that turn, 5 to 40 words, never translated or paraphrased"),
});

const Claim = z.object({
  kind: z.enum(CLAIM_KINDS),
  scope: z.string().describe("global, project:<slug> or context:<tag>"),
  statement: z.string().describe("One self-contained sentence, in the language of the quoted turns"),
  statement_lang: z.enum(["fr", "en", "mixed"]),
  origin: z.enum(ORIGINS),
  evidence: z.array(Evidence),
  time_expression: z.string().nullable().describe("The words that date the claim, as written, or null"),
  valid_from: z.string().nullable().describe("YYYY, YYYY-MM or YYYY-MM-DD, resolved against the turn's timestamp, or null"),
  valid_from_precision: z.enum(["day", "month", "year", "approx", "unknown"]),
  confidence: z.number().describe("0 to 1: how sure you are the user holds this as true"),
  sensitivity: z.enum(["normal", "sensitive"]),
  decision: z
    .object({
      options: z.array(z.object({ option: z.string(), rejected_because: z.string().nullable() })),
      rationale: z.string().nullable(),
      revisit_on: z.string().nullable(),
    })
    .nullable()
    .describe("Only for kind decision; null otherwise"),
});

export const ExtractionSchema = z.object({ claims: z.array(Claim) });
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedClaim = Extraction["claims"][number];

export const EXTRACT_SYSTEM = `You extract durable facts about one person, the user, from a conversation they had with Claude. The facts go into their personal memory, which later sessions read back to them, so a wrong or invented fact is worse than a missing one.

Extract a claim only when it will still be useful in a month: who the user is, what they prefer, facts about their projects, decisions with their reasons, lessons learned, and procedures they follow. Skip small talk, one-off tasks, code details that live in the code itself, and anything about Claude rather than the user. Never extract psychological or personality judgements about the user. Skip facts that will not hold in a month: one game, build or purchase, a single bug, a one-off errand. Most conversations hold zero to five claims; return an empty list when there are none.

Kinds:
- profile: a stable fact about the user (role, skills, tools they own, where they work).
- preference: how the user likes things done.
- project_fact: a fact about one of their projects (stack, status, constraint).
- decision: a choice the user made, with the options rejected and why when the conversation says so.
- lesson: something the user learned, often from a failure.
- procedure: steps the user follows to do something.

Origin, decided from who said it:
- user_stated: the user says it in their own turn.
- user_confirmed: Claude proposed it and the user explicitly agreed in a later turn; cite both turns.
- ai_suggested: Claude proposed it and the user did not confirm.
- ai_inferred: nobody said it; you derived it. Use sparingly.
- external_doc: it comes from a document or pasted text, not from either speaker.
- imported_memory: the turn is a stored memory (role memory).

Rules:
- Write each statement as one self-contained sentence in the language of the turns it rests on: French turns give a French statement, English turns an English one. Never translate.
- In a conversation that mixes languages, write the statement in the language of the user turn you quote.
- Name the person "the user" in English statements and "l'utilisateur" in French ones, never by name.
- Every claim cites at least one turn. Each quote is copied character for character from that turn, 5 to 40 words, never translated, shortened inside or paraphrased.
- Dates: resolve relative time ("depuis mars", "last week", "next year") against the timestamp of the turn that says it, not today. Set valid_from_precision to how precise the result is; use unknown with a null valid_from when nothing dates the claim.
- When the time words give only a month or a year ("depuis mars", "in 2024", "last summer"), use that precision (month, year, approx); use day only when the day is known.
- Scope: project:<slug> when the claim is about one project (a short lowercase slug from its name), global when it is about the user in general, context:<tag> for a recurring situation. A hobby or a recurring situation is context:<tag>, never project:<slug>; project: is for something the user builds or runs.
- When <source> carries a scope, use the scope given on <source> for facts about that project, never another slug for it.
- sensitivity is sensitive for health, money, relationships, legal matters, or anything about other identifiable people.
- confidence: 0.9 or more only for a clear statement by the user; lower for hedged, hypothetical or old statements.`;

export interface SourceTurn {
  ref: string;
  role: string;
  ts: string | null;
  text: string;
}

export interface RenderableSource {
  kind: string;
  title: string | null;
  created_at: string | null;
  /** The project the source belongs to, from its folder (src/projects.ts); absent when unknown. */
  scope?: string | null;
}

/**
 * The text a turn is extracted from: harness-injected spans removed, a long tool call cut to its
 * start, as the meaning index sees it. Quotes are checked against this text.
 */
export function extractView(text: string): string {
  return embedView(splitInjected(text).own).trim();
}

/** The user message of one extraction request: the source's header, then each turn under its id. */
export function renderSource(source: RenderableSource, turns: SourceTurn[]): string {
  const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const head = `<source kind="${source.kind}" title="${attr(source.title ?? "")}" created="${source.created_at ?? ""}"${source.scope ? ` scope="${attr(source.scope)}"` : ""}>`;
  const body = turns.map((t) => `<turn id="${t.ref}" role="${t.role}" ts="${t.ts ?? ""}">\n${t.text}\n</turn>`);
  return [head, ...body, "</source>"].join("\n");
}
