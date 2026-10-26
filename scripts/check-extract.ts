// Check #32: does Haiku 5.5 return claims that parse against the claim schema, keep each
// statement in its source's language, and quote turns verbatim? Runs the draft prompt in
// src/extractPrompt.ts on 20 real sources (10 French, 5 English, 5 mixed) through the
// Messages API, then writes every response to a JSONL file and prints a summary.
//
//   npx tsx scripts/check-extract.ts [--db path] [--dry-run]
//
// The key comes from ~/.config/ai_second_brain/env, never from the shell: a Claude Code session
// sets its own ANTHROPIC_API_KEY and an ANTHROPIC_BASE_URL that may point at a proxy rewriting
// the content. --dry-run lists the sample and its size without calling the API.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { defaultDbPath } from "../src/db.js";
import { detectLang, type Lang } from "../src/enrich.js";
import {
  EXTRACT_MODEL,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SYSTEM,
  ExtractionSchema,
  extractView,
  renderSource,
  type ExtractedClaim,
  type SourceTurn,
} from "../src/extractPrompt.js";

/** About 70k tokens at 3.5 characters a token: with the prompt, under Haiku's 100k price step. */
const MAX_SOURCE_CHARS = 240_000;
const SAMPLE: Record<Lang, number> = { fr: 10, en: 5, mixed: 5 };
const PRICE_PER_MTOK = { input: 0.1, output: 0.5 };
const CONCURRENCY = 4;

interface SourceRow {
  id: number;
  kind: string;
  title: string | null;
  created_at: string | null;
}
interface TurnRow {
  id: number;
  role: string;
  ts: string | null;
  text: string;
  lang: Lang | null;
}

function args(): { db: string; dryRun: boolean } {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--db");
  return { db: i >= 0 && argv[i + 1] ? argv[i + 1]! : defaultDbPath(), dryRun: argv.includes("--dry-run") };
}

function apiKey(): string {
  const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ai_second_brain", "env");
  const key = parseEnv(readFileSync(path, "utf8")).ANTHROPIC_API_KEY;
  if (!key) throw new Error(`${path}: no ANTHROPIC_API_KEY`);
  return key;
}

/** The turns extraction reads: no tool output, no sidechains, no wholly injected turns. */
function sourceTurns(db: Database.Database, sourceId: number): TurnRow[] {
  return (
    db
      .prepare(
        `SELECT id, role, ts, text, lang FROM turns
         WHERE source_id = ? AND is_injected = 0 AND is_sidechain = 0 AND role <> 'tool'
         ORDER BY ts, id`,
      )
      .all(sourceId) as TurnRow[]
  )
    .map((t) => ({ ...t, text: extractView(t.text) }))
    .filter((t) => t.text !== "");
}

/** fr or en when 80% or more of the user's turns with a language are in it, else mixed. */
function sourceLang(turns: TurnRow[]): Lang | null {
  const langs = turns.filter((t) => t.role === "user" && t.lang).map((t) => t.lang);
  if (langs.length === 0) return null;
  for (const l of ["fr", "en"] as const) if (langs.filter((x) => x === l).length / langs.length >= 0.8) return l;
  return "mixed";
}

/** The turns that fit in one request, from the start; a longer source is cut, as the chunker (#35) will. */
function firstChunk(turns: TurnRow[]): TurnRow[] {
  let chars = 0;
  const kept: TurnRow[] = [];
  for (const t of turns) {
    if (chars + t.text.length > MAX_SOURCE_CHARS && kept.length > 0) break;
    kept.push(t);
    chars += t.text.length;
  }
  return kept;
}

/** A stable shuffle: the same database always gives the same sample. */
const order = (id: number) => createHash("sha256").update(`check-32:${id}`).digest("hex");

function pickSample(db: Database.Database) {
  const sources = db
    .prepare(`SELECT id, kind, title, created_at FROM sources WHERE excluded = 0 AND kind IN ('cc', 'cai') ORDER BY id`)
    .all() as SourceRow[];
  const picked: { source: SourceRow; turns: TurnRow[]; lang: Lang }[] = [];
  const count: Record<Lang, number> = { fr: 0, en: 0, mixed: 0 };
  for (const source of sources.sort((a, b) => order(a.id).localeCompare(order(b.id)))) {
    const turns = firstChunk(sourceTurns(db, source.id));
    const lang = sourceLang(turns);
    if (!lang || count[lang] >= SAMPLE[lang]) continue;
    if (!turns.some((t) => t.role === "user")) continue;
    picked.push({ source, turns, lang });
    count[lang]++;
  }
  return { picked, count };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

interface ClaimCheck {
  turnsFound: boolean;
  noEvidence: boolean;
  quotesVerbatim: number;
  quotesWhitespaceOnly: number;
  quotesMissing: number;
  statementLang: Lang | null;
  evidenceLang: Lang | null;
  declaredLang: string;
  originRoleMismatch: boolean;
}

/** Checks one claim against the turns it cites. */
function checkClaim(claim: ExtractedClaim, byRef: Map<string, TurnRow>): ClaimCheck {
  const check: ClaimCheck = {
    turnsFound: true,
    noEvidence: claim.evidence.length === 0,
    quotesVerbatim: 0,
    quotesWhitespaceOnly: 0,
    quotesMissing: 0,
    statementLang: detectLang(claim.statement),
    evidenceLang: null,
    declaredLang: claim.statement_lang,
    originRoleMismatch: false,
  };
  const cited: TurnRow[] = [];
  for (const ev of claim.evidence) {
    const turn = byRef.get(ev.turn);
    if (!turn) {
      check.turnsFound = false;
      check.quotesMissing++;
      continue;
    }
    cited.push(turn);
    if (turn.text.includes(ev.quote)) check.quotesVerbatim++;
    else if (squash(turn.text).includes(squash(ev.quote))) check.quotesWhitespaceOnly++;
    else check.quotesMissing++;
  }
  check.evidenceLang = detectLang(cited.map((t) => t.text).join("\n"));
  if (claim.origin === "user_stated" && cited.length > 0 && !cited.some((t) => t.role === "user")) check.originRoleMismatch = true;
  return check;
}

async function main(): Promise<void> {
  const opts = args();
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const { picked, count } = pickSample(db);
  console.log(`sample: ${JSON.stringify(count)} (wanted ${JSON.stringify(SAMPLE)})`);
  for (const p of picked) {
    const chars = p.turns.reduce((n, t) => n + t.text.length, 0);
    console.log(`  ${p.lang.padEnd(5)} ${p.source.kind}:${p.source.id} ${p.turns.length} turns ${chars} chars  ${(p.source.title ?? "").slice(0, 50)}`);
  }
  if (opts.dryRun) return;

  const client = new Anthropic({ apiKey: apiKey(), baseURL: "https://api.anthropic.com" });
  const outDir = join(dirname(opts.db), "checks");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `extract-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

  const results: { lang: Lang; outcome: string; claims: number; checks: ClaimCheck[]; input: number; output: number; seconds: number }[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < picked.length; i = next++) {
      const { source, turns, lang } = picked[i]!;
      const refTurns: SourceTurn[] = turns.map((t, j) => ({ ref: `T${j + 1}`, role: t.role, ts: t.ts, text: t.text }));
      const byRef = new Map(turns.map((t, j) => [`T${j + 1}`, t]));
      const started = Date.now();
      let outcome = "ok";
      let parsed: { claims: ExtractedClaim[] } | null = null;
      let usage = { input_tokens: 0, output_tokens: 0 };
      let raw: unknown = null;
      try {
        const res = await client.messages.parse({
          model: EXTRACT_MODEL,
          max_tokens: 16000,
          system: EXTRACT_SYSTEM,
          messages: [{ role: "user", content: renderSource(source, refTurns) }],
          output_config: { format: zodOutputFormat(ExtractionSchema), effort: "medium" },
        });
        usage = res.usage;
        raw = res.content;
        if (res.stop_reason === "refusal") outcome = "refusal";
        else if (res.stop_reason === "max_tokens") outcome = "max_tokens";
        else if (!res.parsed_output) outcome = "unparsed";
        else parsed = res.parsed_output;
      } catch (err) {
        outcome = err instanceof Anthropic.APIError ? `api_error ${err.status}` : `parse_error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
      }
      const checks = (parsed?.claims ?? []).map((c) => checkClaim(c, byRef));
      const seconds = (Date.now() - started) / 1000;
      results.push({ lang, outcome, claims: parsed?.claims.length ?? 0, checks, input: usage.input_tokens, output: usage.output_tokens, seconds });
      appendFileSync(
        outPath,
        JSON.stringify({ prompt: EXTRACT_PROMPT_VERSION, model: EXTRACT_MODEL, source: `${source.kind}:${source.id}`, lang, outcome, usage, seconds, claims: parsed?.claims ?? null, checks, raw: parsed ? undefined : raw }) + "\n",
      );
      console.log(`${source.kind}:${source.id} ${lang} ${outcome} claims=${parsed?.claims.length ?? 0} in=${usage.input_tokens} out=${usage.output_tokens} ${seconds.toFixed(1)}s`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const all = results.flatMap((r) => r.checks.map((c) => ({ ...c, lang: r.lang })));
  const quotes = all.reduce((n, c) => n + c.quotesVerbatim + c.quotesWhitespaceOnly + c.quotesMissing, 0);
  const sum = (f: (c: ClaimCheck) => number) => all.reduce((n, c) => n + f(c), 0);
  const tokens = { input: results.reduce((n, r) => n + r.input, 0), output: results.reduce((n, r) => n + r.output, 0) };
  const cost = (tokens.input * PRICE_PER_MTOK.input + tokens.output * PRICE_PER_MTOK.output) / 1e6;
  const outcomes: Record<string, number> = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const langRow = (l: Lang) => {
    const cs = all.filter((c) => c.lang === l);
    const judged = cs.filter((c) => c.statementLang && c.evidenceLang);
    const same = judged.filter((c) => c.statementLang === c.evidenceLang || c.evidenceLang === "mixed").length;
    return `| ${l} | ${results.filter((r) => r.lang === l).length} | ${cs.length} | ${same} / ${judged.length} | ${cs.length - judged.length} |`;
  };

  console.log(`\nresults: ${outPath}\n`);
  console.log(`Outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`Claims: ${all.length}; no evidence: ${all.filter((c) => c.noEvidence).length}; cited turn missing: ${all.filter((c) => !c.turnsFound).length}; user_stated without a user turn: ${all.filter((c) => c.originRoleMismatch).length}`);
  console.log(`Quotes: ${quotes}; verbatim ${sum((c) => c.quotesVerbatim)}, whitespace differs ${sum((c) => c.quotesWhitespaceOnly)}, not in the turn ${sum((c) => c.quotesMissing)}`);
  console.log(`\n| Sources | n | Claims | Statement in evidence language | Too short to tell |\n| --- | --- | --- | --- | --- |`);
  for (const l of ["fr", "en", "mixed"] as const) console.log(langRow(l));
  console.log(`\nTokens: ${tokens.input} in, ${tokens.output} out; $${cost.toFixed(4)} at standard rates ($${(cost / 2).toFixed(4)} batched)`);
  console.log(`Median latency: ${results.map((r) => r.seconds).sort((a, b) => a - b)[Math.floor(results.length / 2)]?.toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
