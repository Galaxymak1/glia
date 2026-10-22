// Claude Code transcript parser (SPEC.md, "Server-side parsing"; docs/notes/claude-code-transcripts.md).
// Pure functions: text in, turns out. Defensive: unknown line types and content blocks are
// skipped and counted, never fatal; the raw file stays in the evidence store, so nothing
// skipped here is lost.

import { basename, dirname, join, relative } from "node:path";

export const CC_PARSER_VERSION = "cc@1";

export type ClaudeCodeFile =
  | { kind: "session"; projectDir: string; sessionId: string }
  | { kind: "subagent"; projectDir: string; sessionId: string; agentId: string }
  | { kind: "memory"; projectDir: string; name: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_PATH = new RegExp(String.raw`/projects/([^/]+)/(${UUID})\.jsonl$`);
const SUBAGENT_PATH = new RegExp(String.raw`/projects/([^/]+)/(${UUID})/subagents/agent-([\w-]+)\.jsonl$`);
const MEMORY_PATH = /\/projects\/([^/]+)\/memory\/([^/]+\.md)$/;

/** What a root outside any `projects/` folder holds, as seen by the caller on disk. */
export type RootShape = "projects-folder" | "project-folder" | "session-file";

/**
 * Maps a file found while walking `root` to the path the Claude Code rules read,
 * `/projects/<dir>/...`. `realRoot` is `root` with symlinks resolved. A root inside a
 * `projects/` folder keeps its place there. Any other root is placed by its `shape`: a
 * single project folder (it holds sessions or `memory/` directly) is named after itself, a
 * lone session file after its parent folder, and anything else is taken to be a projects
 * folder (a copy, a spool, a symlink target). Exclusion and parsing therefore never depend
 * on what the folder is called.
 */
export function projectsView(root: string, realRoot: string, shape: RootShape = "projects-folder"): (path: string) => string {
  const at = realRoot.lastIndexOf("/projects/");
  let prefix: string;
  if (realRoot.endsWith("/projects")) prefix = "";
  else if (at >= 0) prefix = realRoot.slice(at + "/projects/".length);
  else if (shape === "project-folder") prefix = basename(realRoot);
  else if (shape === "session-file") prefix = join(basename(dirname(realRoot)), basename(realRoot));
  else prefix = "";
  return (path) => join("/projects", prefix, relative(root, path));
}

/** Whether a folder looks like one Claude Code project: session files or a memory/ folder directly in it. */
export function looksLikeProjectFolder(entries: string[]): boolean {
  return entries.some((name) => name === "memory" || new RegExp(`^${UUID}\\.jsonl$`).test(name));
}

/** Whether a file name is a Claude Code session file. */
export const isSessionFileName = (name: string) => new RegExp(`^${UUID}\\.jsonl$`).test(name);

/** Recognises a Claude Code file by where it sits under `<config>/projects/`; null for anything else. */
export function classifyClaudeCodePath(path: string): ClaudeCodeFile | null {
  let m = SUBAGENT_PATH.exec(path);
  if (m) return { kind: "subagent", projectDir: m[1]!, sessionId: m[2]!, agentId: m[3]! };
  m = SESSION_PATH.exec(path);
  if (m) return { kind: "session", projectDir: m[1]!, sessionId: m[2]! };
  m = MEMORY_PATH.exec(path);
  if (m) return { kind: "memory", projectDir: m[1]!, name: m[2]! };
  return null;
}

export interface ParsedTurn {
  externalUuid: string;
  /** The nearest stored ancestor, walking past lines that are not turns (attachments, system lines). */
  parentUuid: string | null;
  role: "user" | "assistant" | "tool" | "memory";
  ts: string | null;
  text: string;
  isSidechain: boolean;
}

export interface ParseStats {
  lines: number;
  turns: number;
  /** Line types that carry no turn, by type: metadata, attachments, markers for cut-off lines, unknown types. */
  skippedTypes: Record<string, number>;
  /** Content blocks left out of turn text, by block type (`thinking`, unknown types). */
  skippedBlocks: Record<string, number>;
  /** Turn lines whose content yields no text (e.g. thinking only). */
  emptyTurns: number;
  /** Lines that are valid JSON but not an object, or turn lines without a uuid or message. */
  malformed: number;
  /** Turn lines repeating a uuid already seen in the file; the last one wins. */
  duplicates: number;
}

export interface ParsedSession {
  turns: ParsedTurn[];
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  stats: ParseStats;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Text of a tool_result's `content`: a string, or blocks of text and images. */
function toolResultText(content: unknown, stats: ParseStats): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!isObject(b)) return "";
      if (b.type === "text") return str(b.text) ?? "";
      if (b.type === "image") return "[image]";
      bump(stats.skippedBlocks, `tool_result/${String(b.type)}`);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Searchable text of a message: text blocks, tool calls with their input, tool results. Thinking is left out. */
function messageText(content: unknown, stats: ParseStats): { text: string; onlyToolResults: boolean } {
  if (typeof content === "string") return { text: content, onlyToolResults: false };
  if (!Array.isArray(content)) return { text: "", onlyToolResults: false };
  const parts: string[] = [];
  let toolResults = 0;
  for (const b of content) {
    if (!isObject(b)) continue;
    switch (b.type) {
      case "text":
        parts.push(str(b.text) ?? "");
        break;
      case "tool_use":
        parts.push(`[tool_use ${str(b.name) ?? "?"}] ${JSON.stringify(b.input ?? {})}`);
        break;
      case "tool_result":
        toolResults++;
        parts.push(toolResultText(b.content, stats));
        break;
      case "image":
        parts.push("[image]");
        break;
      default:
        bump(stats.skippedBlocks, String(b.type));
    }
  }
  return { text: parts.filter(Boolean).join("\n"), onlyToolResults: toolResults > 0 && toolResults === content.length };
}

/** Parses a session or subagent transcript (JSONL, already scrubbed). */
export function parseSession(text: string): ParsedSession {
  const stats: ParseStats = { lines: 0, turns: 0, skippedTypes: {}, skippedBlocks: {}, emptyTurns: 0, malformed: 0, duplicates: 0 };
  // Every line's parent link, turns or not, so a turn's parent can be resolved past skipped lines.
  const parentOf = new Map<string, string | null>();
  const candidates: (ParsedTurn & { rawParent: string | null })[] = [];
  let title: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    stats.lines++;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      stats.malformed++;
      continue;
    }
    if (!isObject(d)) {
      stats.malformed++;
      continue;
    }
    const type = str(d.type) ?? "<none>";
    const uuid = str(d.uuid);
    // Compaction cuts parentUuid; logicalParentUuid keeps the thread.
    const parent = str(d.parentUuid) ?? str(d.logicalParentUuid);
    if (uuid) parentOf.set(uuid, parent);
    if (type === "ai-title") title = str(d.aiTitle) ?? title;

    if (type !== "user" && type !== "assistant") {
      bump(stats.skippedTypes, type);
      continue;
    }
    if (!uuid || !isObject(d.message)) {
      stats.malformed++;
      continue;
    }
    cwd ??= str(d.cwd);
    gitBranch ??= str(d.gitBranch);
    const { text: body, onlyToolResults } = messageText(d.message.content, stats);
    if (!body.trim()) {
      stats.emptyTurns++;
      continue;
    }
    candidates.push({
      externalUuid: uuid,
      parentUuid: null,
      rawParent: parent,
      role: type === "assistant" ? "assistant" : onlyToolResults ? "tool" : "user",
      ts: str(d.timestamp),
      text: body,
      isSidechain: d.isSidechain === true,
    });
  }

  // A repeated uuid keeps its last line, like the upsert would.
  const byUuid = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    if (byUuid.has(c.externalUuid)) {
      stats.duplicates++;
      byUuid.delete(c.externalUuid); // re-insert: the kept line takes the later position
    }
    byUuid.set(c.externalUuid, c);
  }
  const stored = new Set(byUuid.keys());
  // Nearest stored ancestor of each line, memoized so long runs of skipped lines are walked once.
  const resolved = new Map<string, string | null>();
  const nearestStored = (start: string | null): string | null => {
    const path: string[] = [];
    const onPath = new Set<string>();
    let p = start;
    let found: string | null = null;
    while (p) {
      if (stored.has(p)) {
        found = p;
        break;
      }
      if (resolved.has(p)) {
        found = resolved.get(p)!;
        break;
      }
      if (onPath.has(p)) break; // a cycle among skipped lines: no stored ancestor
      onPath.add(p);
      path.push(p);
      p = parentOf.get(p) ?? null;
    }
    for (const q of path) resolved.set(q, found);
    return found;
  };
  const turns: ParsedTurn[] = [...byUuid.values()].map(({ rawParent, ...turn }) => {
    const parent = rawParent === turn.externalUuid ? null : nearestStored(rawParent);
    return { ...turn, parentUuid: parent === turn.externalUuid ? null : parent };
  });
  stats.turns = turns.length;
  const times = turns.map((t) => t.ts).filter((t): t is string => !!t).sort();
  return { turns, title, cwd, gitBranch, createdAt: times[0] ?? null, updatedAt: times.at(-1) ?? null, stats };
}

/** An auto memory file becomes one turn holding the whole file. */
export function parseMemory(text: string, name: string): ParsedSession {
  const stats: ParseStats = { lines: 0, turns: 0, skippedTypes: {}, skippedBlocks: {}, emptyTurns: 0, malformed: 0, duplicates: 0 };
  const turns: ParsedTurn[] = text.trim() ? [{ externalUuid: name, parentUuid: null, role: "memory", ts: null, text, isSidechain: false }] : [];
  stats.turns = turns.length;
  const title = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? name;
  return { turns, title, cwd: null, gitBranch: null, createdAt: null, updatedAt: null, stats };
}
