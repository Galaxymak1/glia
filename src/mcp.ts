// The local stdio MCP server (#8, SPEC.md "MCP tools"): `search_evidence` and `open_evidence`
// over the evidence layer. Read-only; every result stays well under 25k tokens.

import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Embedder } from "./embed.js";
import { search } from "./search.js";
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

/** Room kept for the source line and for each turn's header line. */
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
  let budget = RESULT_CHARS - SOURCE_HEADER_CHARS;
  const main = show(cited, Math.min(TURN_CHARS, budget));
  budget -= main.text.length;
  const keptBefore: ReturnType<typeof show>[] = [];
  const keptAfter: ReturnType<typeof show>[] = [];
  let omitted = 0;
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    for (const side of ["after", "before"] as const) {
      const t = side === "after" ? after[i] : before[before.length - 1 - i];
      if (!t) continue;
      const s = show(t, NEIGHBOUR_CHARS);
      if (s.text.length + TURN_HEADER_CHARS > budget) {
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

function formatOpen(r: NonNullable<ReturnType<typeof openEvidence>>): string {
  const s = r.source;
  const head = [`[${s.kind}] ${cut(s.title ?? "(untitled)", 300).text}`, s.project_hint && `project: ${cut(s.project_hint, 300).text}`, s.created_at && `created ${s.created_at}`].filter(Boolean).join(" · ");
  const turns = r.turns.map((t) => {
    const mark = t.cited ? " ← cited" : "";
    return `--- turn ${t.id} · ${t.role}${t.ts ? ` · ${t.ts}` : ""}${t.isInjected ? " (injected)" : ""}${mark}${t.truncated ? " (truncated)" : ""}\n${t.text}`;
  });
  const tail = r.omittedTurns ? `\n\n(${r.omittedTurns} neighbouring turns left out to stay under the size cap)` : "";
  return `${head}\n\n${turns.join("\n\n")}${tail}`;
}

export function createMcpServer(db: Database.Database, embedder: Embedder | null): McpServer {
  const server = new McpServer({ name: "ai-second-brain", version: "0.0.0" }, { capabilities: { tools: {} } });

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
        return `${i + 1}. turn ${h.turnId} · [${h.kind}] ${h.sourceTitle ?? "(untitled)"}${when} · ${h.role}\n   ${h.snippet}`;
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

  return server;
}
