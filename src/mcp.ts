// The local stdio MCP server (#8, #41, SPEC.md "MCP tools"): `search_evidence` and `open_evidence`
// over the evidence layer, `recall` and `brief` over claims. Read-only; every result stays well
// under 25k tokens.

import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Embedder } from "./embed.js";
import { brief, CLAIMS_TAG, logRetrievals, MAX_RECALL_LIMIT, recall, type ClaimHit } from "./recall.js";
import { search } from "./search.js";
import { syncClaimRows } from "./claimIndex.js";
import type { Vault } from "./vault.js";
import { indexStatus } from "./vectors.js";

export const SOURCE_KINDS = ["cc", "cai", "cap", "cad", "caa", "mem"] as const;
export const MAX_LIMIT = 50;
export const MAX_WINDOW = 20;
/** The cited turn is cut here, its neighbours at NEIGHBOUR_CHARS. */
export const TURN_CHARS = 24_000;
export const NEIGHBOUR_CHARS = 2_000;
/**
 * The whole `open_evidence` text: about 18k tokens at the 2.75 characters per token measured on
 * the stored turns, under the 25k-token tool-result cap even for denser text.
 */
export const RESULT_CHARS = 50_000;

/** Room kept for the source line (titles are cut at TITLE_CHARS) and the closing note, and for each turn's header line. */
const TITLE_CHARS = 300;
const SOURCE_HEADER_CHARS = 1_000;
const TURN_HEADER_CHARS = 200;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "an ISO date (2026-10-20) or datetime");

interface TurnRow {
  id: number;
  source_id: number;
  external_uuid: string;
  parent_uuid: string | null;
  role: string;
  ts: string | null;
  text: string;
  is_injected: number;
}

/** A recalled statement is cut here: 20 of them stay under RESULT_CHARS. */
const STATEMENT_CHARS = 2_000;
/** Evidence entries listed per claim; a fact merged from many sessions says how many more it has. */
const EVIDENCE_SHOWN = 5;
const scopeSchema = z.string().regex(/^(global|project:.+|context:.+)$/, "global, project:<slug> or context:<tag>");

/** The claims as text, as many as fit under RESULT_CHARS; returns the ids actually served. */
function formatHits(hits: ClaimHit[], notes: string[]): { text: string; served: string[] } {
  const lines: string[] = [];
  const served: string[] = [];
  let size = SOURCE_HEADER_CHARS;
  for (const [i, h] of hits.entries()) {
    const validity = [`as of ${h.as_of}`, h.valid_to && `valid to ${h.valid_to}`, h.status !== "active" && h.status].filter(Boolean).join(" · ");
    const shown = h.evidence.slice(0, EVIDENCE_SHOWN).map((e) => (e.turn_id === null ? e.source : `turn ${e.turn_id} (${cut(e.source, 120).text})`));
    if (h.evidence.length > EVIDENCE_SHOWN) shown.push(`(+${h.evidence.length - EVIDENCE_SHOWN} more)`);
    const line = `${i + 1}. ${h.id} · ${h.kind} · ${h.scope} · ${h.origin} · ${validity}\n   ${cut(h.statement.replace(/\s+/g, " "), STATEMENT_CHARS).text}\n   evidence: ${shown.join(", ")}`;
    if (size + line.length + 1 > RESULT_CHARS) {
      notes.push(`${hits.length - i} more claims left out to stay under the size cap`);
      break;
    }
    lines.push(line);
    served.push(h.id);
    size += line.length + 1;
  }
  const body = [lines.length ? lines.join("\n") : "No claims match.", ...notes.map((n) => `Note: ${n}`)].join("\n\n");
  return { text: `<${CLAIMS_TAG}>\n${body}\n</${CLAIMS_TAG}>`, served };
}

const cut = (text: string, max: number) => (text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false });

/** The turn `id` with up to `window` turns before it (its parents) and after it (earliest child at each step). */
export function openEvidence(db: Database.Database, id: number, window = 6) {
  const turnById = db.prepare(
    `SELECT t.id, t.source_id, t.external_uuid, t.parent_uuid, t.role, t.ts, t.text, t.is_injected
     FROM turns t JOIN sources s ON s.id = t.source_id WHERE t.id = ? AND s.excluded = 0`,
  );
  const parentOf = db.prepare(
    `SELECT id, source_id, external_uuid, parent_uuid, role, ts, text, is_injected FROM turns WHERE source_id = ? AND external_uuid = ?`,
  );
  const firstChildOf = db.prepare(
    `SELECT id, source_id, external_uuid, parent_uuid, role, ts, text, is_injected FROM turns
     WHERE source_id = ? AND parent_uuid = ? ORDER BY ts IS NULL, ts, id LIMIT 1`,
  );
  const cited = turnById.get(id) as TurnRow | undefined;
  if (!cited) return null;
  const source = db
    .prepare("SELECT kind, title, project_hint, cwd, created_at, updated_at FROM sources WHERE id = ?")
    .get(cited.source_id) as { kind: string; title: string | null; project_hint: string | null; cwd: string | null; created_at: string | null; updated_at: string | null };

  // Injected turns (reminders, hook context) are walked through but not shown or counted.
  const before: TurnRow[] = [];
  const seen = new Set([cited.id]);
  for (let t = cited; before.length < window && t.parent_uuid; ) {
    const p = parentOf.get(t.source_id, t.parent_uuid) as TurnRow | undefined;
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    if (!p.is_injected) before.unshift(p);
    t = p;
  }
  const after: TurnRow[] = [];
  for (let t = cited; after.length < window; ) {
    const c = firstChildOf.get(t.source_id, t.external_uuid) as TurnRow | undefined;
    if (!c || seen.has(c.id)) break;
    seen.add(c.id);
    if (!c.is_injected) after.push(c);
    t = c;
  }

  const show = (t: TurnRow, max: number) => ({ id: t.id, role: t.role, ts: t.ts, isInjected: t.is_injected === 1, cited: t.id === cited.id, ...cut(t.text, max) });
  // The neighbours nearest the cited turn are kept first when the result would pass the cap.
  // Room is kept for the source line, every turn's header line and the closing note.
  let budget = RESULT_CHARS - SOURCE_HEADER_CHARS - TURN_HEADER_CHARS;
  const main = show(cited, Math.min(TURN_CHARS, budget));
  budget -= main.text.length;
  const keptBefore: ReturnType<typeof show>[] = [];
  const keptAfter: ReturnType<typeof show>[] = [];
  // Once a side has no room, the turns past it are left out too, so no gap opens in the middle.
  const full = { before: false, after: false };
  let omitted = 0;
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    for (const side of ["after", "before"] as const) {
      const t = side === "after" ? after[i] : before[before.length - 1 - i];
      if (!t) continue;
      const s = show(t, NEIGHBOUR_CHARS);
      if (full[side] || s.text.length + TURN_HEADER_CHARS > budget) {
        full[side] = true;
        omitted++;
        continue;
      }
      budget -= s.text.length + TURN_HEADER_CHARS;
      if (side === "after") keptAfter.push(s);
      else keptBefore.unshift(s);
    }
  }
  return { source: { ...source }, turns: [...keptBefore, main, ...keptAfter], ...(omitted ? { omittedTurns: omitted } : {}) };
}

export function formatOpen(r: NonNullable<ReturnType<typeof openEvidence>>): string {
  const s = r.source;
  const head = [`[${s.kind}] ${cut(s.title ?? "(untitled)", TITLE_CHARS).text}`, s.project_hint && `project: ${cut(s.project_hint, TITLE_CHARS).text}`, s.created_at && `created ${s.created_at}`].filter(Boolean).join(" · ");
  const turns = r.turns.map((t) => {
    const mark = t.cited ? " ← cited" : "";
    return `--- turn ${t.id} · ${t.role}${t.ts ? ` · ${t.ts}` : ""}${t.isInjected ? " (injected)" : ""}${mark}${t.truncated ? " (truncated)" : ""}\n${t.text}`;
  });
  const tail = r.omittedTurns ? `\n\n(${r.omittedTurns} neighbouring turns left out to stay under the size cap)` : "";
  return `${head}\n\n${turns.join("\n\n")}${tail}`;
}

/**
 * With a vault, every recall and brief first brings the claim rows in line with its files, so a
 * claim retracted or corrected in Obsidian is served as it now reads (statements edited since are
 * found by keyword until the next `glia index --claims` embeds them).
 */
export function createMcpServer(db: Database.Database, embedder: Embedder | null, vault?: Vault): McpServer {
  const server = new McpServer({ name: "glia", version: "0.0.0" }, { capabilities: { tools: {} } });

  server.registerTool(
    "search_evidence",
    {
      title: "Search evidence",
      description:
        "Hybrid keyword + meaning search over every stored Claude conversation turn (Claude Code sessions, claude.ai chats, projects, " +
        "artifacts, memory). Returns turn ids with a snippet; pass an id to open_evidence to read the turn in context.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What to look for, in any language"),
        source_kind: z
          .enum(SOURCE_KINDS)
          .optional()
          .describe("cc = Claude Code session, cai = claude.ai chat, cap = claude.ai project doc, cad = Claude Design chat, caa = claude.ai artifact, mem = memory file"),
        from: isoDate.optional().describe("Only turns at or after this date (ISO)"),
        to: isoDate.optional().describe("Only turns at or before this date (ISO, inclusive: 2026-10-20 covers the whole day)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(10).describe("Number of results"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, source_kind, from, to, limit }) => {
      const result = await search(db, embedder, query, { limit, kind: source_kind, from, to });
      const notes: string[] = [];
      if (result.meaningError) notes.push(`meaning search unavailable (${result.meaningError}); keyword results only`);
      if (embedder) {
        const status = indexStatus(db, embedder.model);
        if (status.missing) notes.push(`${status.missing} turns are not in the meaning index yet; they can only match by keyword`);
      }
      const lines = result.hits.map((h, i) => {
        const when = h.ts ? ` · ${h.ts.slice(0, 16).replace("T", " ")}` : "";
        return `${i + 1}. turn ${h.turnId} · [${h.kind}] ${cut(h.sourceTitle ?? "(untitled)", 120).text}${when} · ${h.role}\n   ${h.snippet}`;
      });
      const text = [lines.length ? lines.join("\n") : "No results.", ...notes.map((n) => `Note: ${n}`)].join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "open_evidence",
    {
      title: "Open evidence",
      description:
        "Reads a turn found by search_evidence, with the conversation around it: up to `window` turns before and after. " +
        `Long turns are cut (the cited one at ${TURN_CHARS} characters, others at ${NEIGHBOUR_CHARS}).`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("Turn id, as returned by search_evidence"),
        window: z.number().int().min(0).max(MAX_WINDOW).default(6).describe("Turns to show on each side"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, window }) => {
      const r = openEvidence(db, id, window);
      if (!r) return { content: [{ type: "text", text: `No turn ${id}.` }], isError: true };
      return { content: [{ type: "text", text: formatOpen(r) }] };
    },
  );

  // Every served claim is logged with the client that asked, so it is known when it comes back.
  const client = () => server.server.getClientVersion()?.name ?? "unknown";

  server.registerTool(
    "recall",
    {
      title: "Recall claims",
      description:
        "Hybrid search over the user's reviewed claims: facts, preferences, decisions and lessons drawn from their conversations, " +
        "each with its origin (did the user say it, or did Claude suggest it), its scope and when it became true. Superseded " +
        "claims are hidden unless include_superseded is set, or as_of asks what was true at a past date. Evidence ids open " +
        "with open_evidence.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What to look for, in any language"),
        scope: scopeSchema.optional().describe("Only claims of this scope (and global ones): project:<slug>, context:<tag> or global"),
        as_of: isoDate.optional().describe("Only claims valid at this date (ISO): what was true then, superseded claims included"),
        include_superseded: z.boolean().default(false).describe("Also return claims a later claim superseded"),
        limit: z.number().int().min(1).max(MAX_RECALL_LIMIT).default(8).describe("Number of claims"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (vault) syncClaimRows(db, vault);
      const r = await recall(db, embedder, args);
      const notes = r.meaningError ? [`meaning search unavailable (${r.meaningError}); keyword results only`] : [];
      const out = formatHits(r.hits, notes);
      logRetrievals(db, out.served, client());
      return { content: [{ type: "text", text: out.text }] };
    },
  );

  server.registerTool(
    "brief",
    {
      title: "Brief",
      description:
        "A compact briefing on the user: their profile and preferences, open decisions, and the active facts of one project, " +
        "newest first, each with the date it holds from (as of). Call it at the start of a task about a project.",
      inputSchema: z.object({
        scope: scopeSchema.optional().describe("The project or context to brief on, e.g. project:ai-brain"),
        budget_tokens: z.number().int().min(200).max(4000).default(1500).describe("Size of the briefing"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (vault) syncClaimRows(db, vault);
      const r = brief(db, args);
      logRetrievals(db, r.claimIds, client());
      return { content: [{ type: "text", text: r.text }] };
    },
  );

  return server;
}
