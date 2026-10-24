// What the meaning index embeds for each turn (#7): the turn cut into chunks of about 512
// tokens, each behind a short context header. Pure and deterministic: the same turns always
// give the same inputs, so a rebuilt index matches the one it replaces.

/** About 512 BGE-M3 tokens: the stored turns average 2.75 characters per token. */
export const CHUNK_CHARS = 1400;
/** About 64 tokens from the end of one chunk start the next, so no sentence is only ever seen cut. */
export const OVERLAP_CHARS = 180;
/** A tool call (`[tool_use <name>] <json>`, one line) is embedded by its start: the name and first arguments. */
const TOOL_CALL_CHARS = 300;
/** Each header line (the title, the turn before) is cut to this. */
const HEADER_LINE_CHARS = 150;

const TOOL_CALL = /^\[tool_use [^\]\n]*\].*$/gm;

/**
 * The text of a turn as the meaning index sees it. A tool call's arguments can be a whole file
 * or diff: past its first characters they say what was written, not what was meant, and
 * keyword search still has them in full.
 */
export function embedView(text: string): string {
  return text.replace(TOOL_CALL, (line) => (line.length > TOOL_CALL_CHARS ? `${line.slice(0, TOOL_CALL_CHARS)}…` : line));
}

/**
 * Cuts `text` into pieces of at most `size` characters, each starting `overlap` characters
 * before the previous one ended. A cut falls at the last paragraph break in the second half
 * of the window, else the last line break, sentence end or space, else at `size`.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  const t = text.trim();
  if (!t) return [];
  const chunks: string[] = [];
  let start = 0;
  for (;;) {
    if (t.length - start <= size) {
      chunks.push(t.slice(start).trim());
      return chunks;
    }
    const end = cutBefore(t, start + Math.floor(size / 2), start + size);
    chunks.push(t.slice(start, end).trim());
    start = nextStart(t, Math.max(end - overlap, start + 1), end);
  }
}

/** Where to cut a window that may end anywhere in `[min, limit]`. */
function cutBefore(t: string, min: number, limit: number): number {
  // Searched in the window only: lastIndexOf on the whole text would scan back to its start
  // whenever the window has no break, which makes a long text quadratic.
  const w = t.slice(min, limit);
  const paragraph = w.lastIndexOf("\n\n");
  if (paragraph >= 0) return min + paragraph + 2;
  const line = w.lastIndexOf("\n");
  if (line >= 0) return min + line + 1;
  const sentence = /[.!?]\s/g;
  let last = -1;
  for (let m = sentence.exec(w); m; m = sentence.exec(w)) last = m.index;
  if (last >= 0) return min + last + 2;
  const space = w.search(/\s\S*$/);
  if (space >= 0) return min + space + 1;
  // No break at all (a long hash or base64 run): cut at the limit, never inside a surrogate pair.
  const code = t.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

/** The overlap starts at a word: the first one after `from`, if one starts before `end`. */
function nextStart(t: string, from: number, end: number): number {
  for (let i = from; i < end; i++) {
    if (/\s/.test(t[i]!)) {
      while (i < end && /\s/.test(t[i]!)) i++;
      return i < end ? i : from;
    }
  }
  return from;
}

/** The first non-blank line of `text`, cut to a header line. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const trimmed = line.trim().replace(/\s+/g, " ");
  return trimmed.length > HEADER_LINE_CHARS ? `${trimmed.slice(0, HEADER_LINE_CHARS)}…` : trimmed;
}

/**
 * Put before every chunk of a turn: the conversation title and the first line of the turn it
 * answers. A short turn ("yes, do that") means little alone; with the question before it, it
 * can be found.
 */
export function contextHeader(title: string | null, previous: string | null): string {
  const lines: string[] = [];
  if (title && firstLine(title)) lines.push(firstLine(title));
  if (previous && firstLine(previous)) lines.push(`> ${firstLine(previous)}`);
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

export interface ChunkableTurn {
  role: string;
  text: string;
  is_injected: number | boolean;
}

/**
 * The chunks of a turn that the meaning index embeds, without their header. Injected turns
 * get none: they stay searchable by keyword, but do not take places among results by meaning.
 * Tool output is about a quarter of all text and mostly file contents and logs: only its
 * first chunk is embedded.
 */
export function turnChunks(turn: ChunkableTurn): string[] {
  if (turn.is_injected) return [];
  const chunks = chunkText(embedView(turn.text));
  return turn.role === "tool" ? chunks.slice(0, 1) : chunks;
}
