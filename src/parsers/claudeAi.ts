// claude.ai export parser (SPEC.md, "Server-side parsing"; format checked on a real export in #14).
// The export is one ZIP per category. Pure functions: parsed JSON in, sources and turns out.
// Defensive like the Claude Code parser: unknown blocks are skipped and counted, never fatal;
// the raw entry stays in the evidence store.

import type { SourceRow, TurnRow } from "../sources.js";

export const CAI_PARSER_VERSION = "cai@1";

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

/** Searchable text of a chat message: its blocks, then the extracted text of its attachments. */
function messageText(m: Json, stats: CaiStats): string {
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
      default:
        // thinking, injected_prompt_block (injected context, #6) and unknown types.
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
      const texts = new Map(messages.map((m) => [str(m.uuid)!, messageText(m, stats)]));
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
        const text = texts.get(str(m.uuid)!)!;
        if (!text) continue;
        turns.push({
          externalUuid: str(m.uuid)!,
          parentUuid: nearestStored(str(m.parent_message_uuid)),
          role: m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : String(m.sender ?? "unknown"),
          ts: str(m.created_at),
          text,
          isSidechain: false,
        });
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

/** `memories/<account>.json`: claude.ai's conversation memory and its memory files. */
export function parseMemories(data: unknown): ParsedSource | null {
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
    source: { kind: "mem", external_id: `claude.ai/${str(data.account_uuid)}`, title: "claude.ai memory", project_hint: null, cwd: null, created_at: times[0] ?? null, updated_at: times.at(-1) ?? null },
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

/** Visible text of an HTML artifact: scripts, styles and tags removed, entities for the common few decoded. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/**
 * An artifact folder (`artifacts/<id>/`): its doc page, or the newest HTML version's text,
 * plus its comments. `versionHtml` maps each HTML version file name to its content.
 */
export function parseArtifact(meta: unknown, page: string | null, versionHtml: Map<string, string>, comments: unknown): ParsedSource | null {
  if (!isObject(meta) || !str(meta.id)) return null;
  const versions = list(meta.versions).filter(isObject);
  const active = versions.find((v) => v.id === meta.active_version) ?? versions.at(-1);
  const turns: TurnRow[] = [];
  if (page?.trim()) {
    turns.push({ externalUuid: "page", parentUuid: null, role: "doc", ts: str(meta.updated_at), text: page, isSidechain: false });
  } else if (versionHtml.size) {
    // Version files are named `<epoch>-<suffix>.html`: the highest epoch is the newest.
    const newest = [...versionHtml.keys()].sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0]!;
    const text = htmlText(versionHtml.get(newest)!);
    if (text) turns.push({ externalUuid: `version/${newest}`, parentUuid: null, role: "doc", ts: str(meta.updated_at), text, isSidechain: false });
  }
  list(comments).forEach((thread, i) => {
    if (!isObject(thread)) return;
    list(thread.comments).forEach((c, j) => {
      if (isObject(c) && str(c.body)?.trim()) {
        turns.push({ externalUuid: `comment/${i}/${j}`, parentUuid: j ? `comment/${i}/${j - 1}` : null, role: "comment", ts: str(c.created_at), text: str(c.body)!, isSidechain: false });
      }
    });
  });
  const created = versions.map((v) => str(v.created_at)).filter((t): t is string => !!t).sort();
  return {
    source: { kind: "caa", external_id: str(meta.id)!, title: active ? str(active.title) : null, project_hint: null, cwd: null, created_at: created[0] ?? null, updated_at: str(meta.updated_at) },
    turns,
  };
}
