// claude.ai export parser (SPEC.md, "Server-side parsing"; format checked on a real export in #14).
// The export is one ZIP per category. Pure functions: parsed JSON in, sources and turns out.
// Defensive like the Claude Code parser: unknown blocks are skipped and counted, never fatal;
// the raw entry stays in the evidence store.

import { createHash } from "node:crypto";
import { ENRICH_VERSION, splitInjected } from "../enrich.js";
import type { SourceRow, TurnRow } from "../sources.js";

export const CAI_PARSER_VERSION = `cai@3+${ENRICH_VERSION}`;

/** Categories found in an export, and whether they are ingested (owner decision, #5). */
export const EXPORT_CATEGORIES = {
  conversations: true,
  projects: true,
  memories: true,
  design_chats: true,
  frames: true,
  light_metadata: false, // account details and login IP addresses
  claude_code_cloud: false, // routine metadata only, no transcripts
} as const;
export type ExportCategory = keyof typeof EXPORT_CATEGORIES;

/** The category a ZIP entry belongs to, by its path; null for anything unrecognised. */
export function exportCategory(entry: string): ExportCategory | null {
  if (entry === "conversations.json") return "conversations";
  if (/^projects\/[^/]+\.json$/.test(entry)) return "projects";
  if (/^memories\/[^/]+\.json$/.test(entry)) return "memories";
  if (/^design_chats\/[^/]+\.json$/.test(entry)) return "design_chats";
  if (/^artifacts\//.test(entry)) return "frames";
  if (entry === "users.json" || entry === "login_history.json") return "light_metadata";
  if (/^claude_code_cloud\//.test(entry)) return "claude_code_cloud";
  return null;
}

/**
 * Whether an entry is kept. Of an artifact folder only its metadata, doc page, comments and
 * top-level HTML versions are kept; bundled app code (JS, CSS) is not evidence.
 */
export function isIngestedEntry(entry: string): boolean {
  const category = exportCategory(entry);
  if (!category || !EXPORT_CATEGORIES[category]) return false;
  if (category !== "frames") return true;
  return /^artifacts\/[^/]+\/(artifact\.json|page\.md|comments\.json|versions\/[^/]+\.html)$/.test(entry);
}

/**
 * Whether a parsed JSON entry has the shape claude.ai gives it, so a ZIP that only shares
 * file names with an export (a ChatGPT export has a root `conversations.json` too) is not
 * taken for one. Entries that fail are not stored.
 */
export function looksLikeExportJson(entry: string, data: unknown): boolean {
  switch (exportCategory(entry)) {
    case "conversations":
      // One odd conversation does not reject the file: the parser skips what it cannot read.
      return Array.isArray(data) && data.some((c) => isObject(c) && !!str(c.uuid) && Array.isArray(c.chat_messages));
    case "projects":
      return isObject(data) && !!str(data.uuid) && ("docs" in data || "prompt_template" in data);
    case "memories":
      return isObject(data) && !!str(data.account_uuid) && ("conversations_memory" in data || "memory_files" in data);
    case "design_chats":
      return isObject(data) && !!str(data.uuid) && Array.isArray(data.messages);
    case "frames":
      if (entry.endsWith("/artifact.json")) return isObject(data) && !!str(data.id) && Array.isArray(data.versions);
      if (entry.endsWith("/comments.json")) return Array.isArray(data) && data.every((t) => isObject(t) && Array.isArray(t.comments));
      return false;
    default:
      return false;
  }
}

/** The newest of an artifact's HTML version files, named `<epoch>-<suffix>.html`; unnumbered names come last. */
export function newestVersion(names: Iterable<string>): string | undefined {
  const epoch = (n: string) => (/^\d+(?=-)/.exec(n)?.[0] ?? "").padStart(20, "0");
  return [...names].sort((a, b) => (epoch(a) === epoch(b) ? (a < b ? 1 : a > b ? -1 : 0) : epoch(a) < epoch(b) ? 1 : -1))[0];
}

export interface ParsedSource {
  source: Omit<SourceRow, "raw_path" | "raw_sha256" | "parser_version">;
  turns: TurnRow[];
}

export interface CaiStats {
  /** Content blocks left out of turn text, by type (thinking, injected prompts, unknown). */
  skippedBlocks: Record<string, number>;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bump = (stats: CaiStats, key: string) => {
  stats.skippedBlocks[key] = (stats.skippedBlocks[key] ?? 0) + 1;
};
const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";

function toolResultText(content: unknown, stats: CaiStats): string {
  return list(content)
    .map((b) => {
      if (!isObject(b)) return "";
      switch (b.type) {
        case "text":
          return str(b.text) ?? "";
        // Web and knowledge results are external pages: indexed by title and URL; their
        // text stays in the raw export.
        case "knowledge":
          return `[source] ${str(b.title) ?? ""} ${str(b.url) ?? ""}`.trim();
        case "local_resource":
          return `[file] ${str(b.name) ?? ""}`.trim();
        case "image":
        case "image_gallery":
          return "[image]";
        default:
          bump(stats, `tool_result/${String(b.type)}`);
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Searchable text of a chat message: its blocks, then the extracted text of its attachments;
 * `injected` collects the context claude.ai added to it (memory snapshots, date notes, reminders).
 */
function messageText(m: Json, stats: CaiStats, injected: string[] = []): string {
  const parts: string[] = [];
  for (const b of list(m.content)) {
    if (!isObject(b)) continue;
    switch (b.type) {
      case "text":
        parts.push(str(b.text) ?? "");
        break;
      case "tool_use":
        parts.push(`[tool_use ${str(b.name) ?? "?"}] ${JSON.stringify(b.input ?? {})}`);
        break;
      case "tool_result":
        parts.push(toolResultText(b.content, stats));
        break;
      case "document":
        parts.push(`[document] ${str(b.title) ?? ""}`.trim());
        break;
      case "image":
        parts.push("[image]");
        break;
      case "injected_prompt_block":
        if (str(b.prompt)?.trim()) injected.push(str(b.prompt)!.trim());
        break;
      default:
        // thinking and unknown types.
        bump(stats, String(b.type));
    }
  }
  let text = parts.filter(Boolean).join("\n");
  if (!text.trim()) text = str(m.text) ?? "";
  for (const a of list(m.attachments)) {
    if (isObject(a) && str(a.extracted_content)) text += `\n[attachment ${str(a.file_name) ?? ""}]\n${str(a.extracted_content)}`;
  }
  // Uploaded files come without their content; their names keep the message (and its thread).
  for (const f of list(m.files)) {
    if (isObject(f) && str(f.file_name)) text += `\n[file] ${str(f.file_name)}`;
  }
  return text.trim();
}

/** `conversations.json`: one source per conversation, one turn per message, every branch kept. */
export function parseConversations(data: unknown, stats: CaiStats): ParsedSource[] {
  return list(data)
    .filter(isObject)
    .filter((c) => str(c.uuid))
    .map((c) => {
      const turns: TurnRow[] = [];
      const messages = list(c.chat_messages).filter((m): m is Json => isObject(m) && !!str(m.uuid));
      // The export has messages with no content at all: they are not stored, so a turn's
      // parent is its nearest ancestor that is.
      const parentOf = new Map(messages.map((m) => [str(m.uuid)!, str(m.parent_message_uuid)]));
      // A human message's own words and the context injected into it (blocks and tagged spans).
      const injectedOf = new Map<string, string[]>();
      const texts = new Map(
        messages.map((m) => {
          const injected: string[] = [];
          let text = messageText(m, stats, injected);
          if (m.sender === "human") {
            const split = splitInjected(text);
            text = split.own;
            injected.push(...split.injected);
          }
          injectedOf.set(str(m.uuid)!, injected);
          // A message holding nothing but injected context is stored whole, flagged.
          return [str(m.uuid)!, text || injected.join("\n\n")];
        }),
      );
      const nearestStored = (start: string | null): string | null => {
        const seen = new Set<string>();
        let p = start;
        while (p && p !== ROOT_PARENT && !texts.get(p) && !seen.has(p)) {
          seen.add(p);
          p = parentOf.get(p) ?? null;
        }
        return p && p !== ROOT_PARENT && texts.get(p) ? p : null;
      };
      for (const m of messages) {
        const uuid = str(m.uuid)!;
        const text = texts.get(uuid)!;
        if (!text) continue;
        // Never its own parent, directly or through a cycle of empty messages.
        const parent = nearestStored(str(m.parent_message_uuid));
        const injected = injectedOf.get(uuid)!;
        const onlyInjected = injected.length > 0 && text === injected.join("\n\n");
        const turn: TurnRow = {
          externalUuid: uuid,
          parentUuid: parent === uuid ? null : parent,
          role: m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : String(m.sender ?? "unknown"),
          ts: str(m.created_at),
          text,
          isSidechain: false,
          isInjected: onlyInjected,
        };
        turns.push(turn);
        // The injected context becomes a child turn of the message, flagged: searchable, never extracted.
        if (injected.length && !onlyInjected) turns.push({ ...turn, externalUuid: `${uuid}#injected`, parentUuid: uuid, text: injected.join("\n\n"), isInjected: true });
      }
      return {
        source: { kind: "cai", external_id: str(c.uuid)!, title: str(c.name), project_hint: null, cwd: null, created_at: str(c.created_at), updated_at: str(c.updated_at) },
        turns,
      } satisfies ParsedSource;
    });
}

/** `projects/<uuid>.json`: the project's description, instructions and docs. */
export function parseProject(data: unknown): ParsedSource | null {
  if (!isObject(data) || !str(data.uuid)) return null;
  const turns: TurnRow[] = [];
  const add = (externalUuid: string, role: string, text: string | null, ts: string | null) => {
    if (text?.trim()) turns.push({ externalUuid, parentUuid: null, role, ts, text, isSidechain: false });
  };
  add("description", "doc", str(data.description), str(data.created_at));
  add("prompt_template", "instructions", str(data.prompt_template), str(data.updated_at));
  for (const d of list(data.docs)) {
    if (isObject(d) && str(d.uuid)) add(str(d.uuid)!, "doc", [str(d.filename), str(d.content)].filter(Boolean).join("\n"), str(d.created_at));
  }
  return {
    source: { kind: "cap", external_id: str(data.uuid)!, title: str(data.name), project_hint: str(data.name), cwd: null, created_at: str(data.created_at), updated_at: str(data.updated_at) },
    turns,
  };
}

/**
 * `memories/<account>.json`: claude.ai's conversation memory and its memory files. The file
 * has no date of its own, and the newest memory file's date goes back when that file is
 * deleted: the source is dated by `exportedAt`, the time the export wrote the entry, when known.
 */
export function parseMemories(data: unknown, exportedAt: string | null = null): ParsedSource | null {
  if (!isObject(data) || !str(data.account_uuid)) return null;
  const turns: TurnRow[] = [];
  const summary = str(data.conversations_memory);
  if (summary?.trim()) turns.push({ externalUuid: "conversations_memory", parentUuid: null, role: "memory", ts: null, text: summary, isSidechain: false });
  const times: string[] = [];
  for (const f of list(data.memory_files)) {
    if (!isObject(f) || !str(f.path) || !str(f.content)?.trim()) continue;
    turns.push({ externalUuid: str(f.path)!, parentUuid: null, role: "memory", ts: str(f.updated_at), text: str(f.content)!, isSidechain: false });
    if (str(f.updated_at)) times.push(str(f.updated_at)!);
  }
  times.sort();
  return {
    source: { kind: "mem", external_id: `claude.ai/${str(data.account_uuid)}`, title: "claude.ai memory", project_hint: null, cwd: null, created_at: times[0] ?? null, updated_at: exportedAt ?? times.at(-1) ?? null },
    turns,
  };
}

/** `design_chats/<uuid>.json`: a Claude Design chat. */
export function parseDesignChat(data: unknown): ParsedSource | null {
  if (!isObject(data) || !str(data.uuid)) return null;
  const turns: TurnRow[] = [];
  let parent: string | null = null;
  for (const m of list(data.messages)) {
    if (!isObject(m) || !str(m.uuid)) continue;
    const body = isObject(m.content) ? m.content : {};
    let text = str(body.content) ?? "";
    for (const a of list(body.attachments)) {
      if (isObject(a) && str(a.content)) text += `\n[attachment ${str(a.name) ?? ""}]\n${str(a.content)}`;
    }
    if (!text.trim()) continue;
    turns.push({ externalUuid: str(m.uuid)!, parentUuid: parent, role: str(m.role) ?? "unknown", ts: str(m.created_at), text: text.trim(), isSidechain: false });
    parent = str(m.uuid);
  }
  const project = isObject(data.project) ? str(data.project.name) : null;
  return {
    source: { kind: "cad", external_id: str(data.uuid)!, title: str(data.title), project_hint: project, cwd: null, created_at: str(data.created_at), updated_at: str(data.updated_at) },
    turns,
  };
}

const BLOCK_TAGS = new Set(["p", "div", "br", "hr", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "table", "pre", "section", "article", "header", "footer", "blockquote"]);
const NAMED_ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/**
 * End of the tag opening at `start` (just past its `>`), skipping quoted attribute values; -1
 * if it never closes. A quote opens a value only right after `=`, as in a browser: the
 * apostrophe of `title=don't` is part of an unquoted value.
 */
function tagEnd(html: string, start: number): number {
  let afterEquals = false;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i]!;
    if (ch === ">") return i + 1;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") continue;
    const opensValue = afterEquals && (ch === '"' || ch === "'");
    afterEquals = ch === "=";
    if (opensValue) {
      const close = html.indexOf(ch, i + 1);
      if (close < 0) return -1;
      i = close;
    }
  }
  return -1;
}

/**
 * Visible text of an HTML artifact, as a reader sees it: scripts, styles and comments removed,
 * block tags turned into line breaks, inline tags removed without a gap (so `DB_PASS<b></b>WORD`
 * reads `DB_PASSWORD`), and named and numeric entities decoded. A `<` that opens no tag stays
 * text, and a `>` inside a quoted attribute does not end its tag. Like a browser, a tag or
 * comment left open runs to the end. One pass, linear in the input. The export stores this
 * text, not the HTML, so the scrubber sees what the markup would hide.
 */
export function htmlText(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      // Doctype, CDATA, processing instruction: up to the next `>`.
      const close = html.indexOf(">", lt);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    const name = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt + 1, lt + 40));
    if (!name) {
      out += "<"; // `a < b`: text
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end < 0) break;
    const tag = name[1]!.toLowerCase();
    const closing = next === "/";
    if (BLOCK_TAGS.has(tag)) out += "\n";
    i = end;
    if (!closing && (tag === "script" || tag === "style")) {
      const close = new RegExp(`</${tag}\\s*>`, "gi");
      close.lastIndex = end;
      const m = close.exec(html);
      i = m ? m.index + m[0].length : html.length;
      out += " ";
    }
  }
  return out
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
      const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
    })
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * An artifact folder (`artifacts/<id>/`): its doc page, or the newest HTML version's text,
 * plus its comments. `versionText` maps each HTML version file name to its text (`htmlText`,
 * applied when the export is stored).
 */
export function parseArtifact(meta: unknown, page: string | null, versionText: Map<string, string>, comments: unknown): ParsedSource | null {
  if (!isObject(meta) || !str(meta.id)) return null;
  const versions = list(meta.versions).filter(isObject);
  const active = versions.find((v) => v.id === meta.active_version) ?? versions.at(-1);
  const turns: TurnRow[] = [];
  if (page?.trim()) {
    turns.push({ externalUuid: "page", parentUuid: null, role: "doc", ts: str(meta.updated_at), text: page, isSidechain: false });
  } else if (versionText.size) {
    const newest = newestVersion(versionText.keys())!;
    const text = versionText.get(newest)!.trim();
    if (text) turns.push({ externalUuid: `version/${newest}`, parentUuid: null, role: "doc", ts: str(meta.updated_at), text, isSidechain: false });
  }
  // Comments have no id in the export: each is keyed by its time and a hash of its text, so
  // deleting or reordering one leaves the others' ids alone.
  const seen = new Map<string, number>();
  for (const thread of list(comments)) {
    if (!isObject(thread)) continue;
    let previous: string | null = null; // the last comment of the thread that was kept
    for (const c of list(thread.comments)) {
      if (!isObject(c) || !str(c.body)?.trim()) continue;
      const key = `comment/${str(c.created_at) ?? ""}/${createHash("sha256").update(str(c.body)!).digest("hex").slice(0, 16)}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const id = n === 1 ? key : `${key}/${n}`;
      turns.push({ externalUuid: id, parentUuid: previous, role: "comment", ts: str(c.created_at), text: str(c.body)!, isSidechain: false });
      previous = id;
    }
  }
  const created = versions.map((v) => str(v.created_at)).filter((t): t is string => !!t).sort();
  return {
    source: { kind: "caa", external_id: str(meta.id)!, title: active ? str(active.title) : null, project_hint: null, cwd: null, created_at: created[0] ?? null, updated_at: str(meta.updated_at) },
    turns,
  };
}
