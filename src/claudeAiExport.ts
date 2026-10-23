// Ingests a claude.ai export ZIP: kept entries are stored one by one in the evidence store
// (scrubbed there, #3), then parsed from their stored copies into sources and turns.

import type Database from "better-sqlite3";
import { unzipSync } from "fflate";
import type { EvidenceStore, RawFile } from "./evidence.js";
import {
  CAI_PARSER_VERSION,
  type CaiStats,
  type ExportCategory,
  exportCategory,
  htmlText,
  isIngestedEntry,
  type ParsedSource,
  parseArtifact,
  parseConversations,
  parseDesignChat,
  parseMemories,
  parseProject,
} from "./parsers/claudeAi.js";
import { findSource, writeSource } from "./sources.js";

/** Limits against a ZIP bomb: entries are inflated in memory. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export type SourceStatus = "new" | "updated" | "unchanged" | "older";

export interface ExportResult {
  /** False when the ZIP holds nothing from a claude.ai export; it was then left alone. */
  isExport: boolean;
  entries: { created: number; repaired: number; unchanged: number; bytes: number; storedBytes: number; redactions: number };
  /** Entries left out, by category (or "other" inside a kept category, e.g. bundled app code). */
  notIngested: Record<string, number>;
  /** Sources by kind, then by status. */
  sources: Record<string, Partial<Record<SourceStatus, number>>>;
  turnsWritten: number;
  turnsRemoved: number;
  stats: CaiStats;
  /** Entries that could not be stored or parsed, with a reason; the rest of the ZIP is still ingested. */
  errors: string[];
}

/** Entry names of a ZIP, without inflating anything. */
function entryNames(data: Uint8Array): { name: string; originalSize: number }[] {
  const names: { name: string; originalSize: number }[] = [];
  unzipSync(data, {
    filter: (f) => {
      names.push({ name: f.name, originalSize: f.originalSize });
      return false;
    },
  });
  return names;
}

export function ingestExportZip(db: Database.Database, store: EvidenceStore, zipPath: string, data: Buffer, receivedAt = new Date()): ExportResult {
  const result: ExportResult = {
    isExport: false,
    entries: { created: 0, repaired: 0, unchanged: 0, bytes: 0, storedBytes: 0, redactions: 0 },
    notIngested: {},
    sources: {},
    turnsWritten: 0,
    turnsRemoved: 0,
    stats: { skippedBlocks: {} },
    errors: [],
  };
  const zip = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const listing = entryNames(zip).filter((e) => !e.name.endsWith("/"));
  if (!listing.some((e) => exportCategory(e.name))) return result;
  result.isExport = true;

  let total = 0;
  for (const e of listing) {
    if (!isIngestedEntry(e.name)) {
      const category: ExportCategory | "other" = exportCategory(e.name) ?? "other";
      result.notIngested[category] = (result.notIngested[category] ?? 0) + 1;
      continue;
    }
    if (e.originalSize > MAX_ENTRY_BYTES) throw new Error(`${e.name}: ${e.originalSize} bytes inflated, over the ${MAX_ENTRY_BYTES} limit`);
    total += e.originalSize;
    if (total > MAX_TOTAL_BYTES) throw new Error(`more than ${MAX_TOTAL_BYTES} bytes inflated, over the limit`);
  }
  const files = unzipSync(zip, { filter: (f) => isIngestedEntry(f.name) && f.originalSize <= MAX_ENTRY_BYTES });

  // Store every kept entry first: the evidence store scrubs it, and parsing reads it back.
  const stored = new Map<string, RawFile>();
  for (const name of Object.keys(files).sort()) {
    try {
      let bytes = Buffer.from(files[name]!);
      if (name.endsWith(".html")) {
        // Stored as its visible text: markup and entities can hide a secret from the scrubber.
        const html = bytes.toString("utf8");
        if (!Buffer.from(html, "utf8").equals(bytes)) throw new Error(`${zipPath}!/${name}: not valid UTF-8, not stored`);
        bytes = Buffer.from(htmlText(html), "utf8");
      }
      const r = store.put(`${zipPath}!/${name}`, bytes, receivedAt);
      if (r.created) {
        result.entries.created++;
        result.entries.bytes += r.file.bytes;
        result.entries.storedBytes += r.file.stored_bytes;
        result.entries.redactions += r.file.redactions;
      } else if (r.repaired) result.entries.repaired++;
      else result.entries.unchanged++;
      stored.set(name, r.file);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const index = (parsed: ParsedSource | null, raw: RawFile) => {
    if (!parsed) return;
    const status = indexSource(db, parsed, raw, result);
    const byKind = (result.sources[parsed.source.kind] ??= {});
    byKind[status] = (byKind[status] ?? 0) + 1;
  };
  const readJson = (name: string): unknown => JSON.parse(store.read(stored.get(name)!.sha256));
  const artifacts = new Map<string, string[]>();
  for (const name of stored.keys()) {
    try {
      const category = exportCategory(name);
      if (category === "conversations") for (const p of parseConversations(readJson(name), result.stats)) index(p, stored.get(name)!);
      else if (category === "projects") index(parseProject(readJson(name)), stored.get(name)!);
      else if (category === "memories") index(parseMemories(readJson(name)), stored.get(name)!);
      else if (category === "design_chats") index(parseDesignChat(readJson(name)), stored.get(name)!);
      else if (category === "frames") {
        const id = name.split("/")[1]!;
        artifacts.set(id, [...(artifacts.get(id) ?? []), name]);
      }
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const [id, names] of artifacts) {
    const dir = `artifacts/${id}/`;
    try {
      if (!stored.has(`${dir}artifact.json`)) continue;
      const page = stored.has(`${dir}page.md`) ? store.read(stored.get(`${dir}page.md`)!.sha256) : null;
      const html = new Map<string, string>();
      for (const n of names.filter((n) => n.startsWith(`${dir}versions/`))) html.set(n.slice(`${dir}versions/`.length), store.read(stored.get(n)!.sha256));
      const comments = stored.has(`${dir}comments.json`) ? readJson(`${dir}comments.json`) : [];
      // The source points at its main content entry: the doc page, else the newest HTML version.
      const newestHtml = [...html.keys()].sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0];
      const main = page !== null ? `${dir}page.md` : newestHtml ? `${dir}versions/${newestHtml}` : `${dir}artifact.json`;
      index(parseArtifact(readJson(`${dir}artifact.json`), page, html, comments), stored.get(main)!);
    } catch (err) {
      result.errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/**
 * Writes one parsed source unless the stored one is as new: a source from another export
 * replaces it only when its `updated_at` is not earlier (conversations are upserted by uuid
 * and updated_at, SPEC.md), so re-importing an older export changes nothing.
 */
function indexSource(db: Database.Database, parsed: ParsedSource, raw: RawFile, result: ExportResult): SourceStatus {
  const { source } = parsed;
  const existing = findSource(db, source.kind, source.external_id);
  const sameParser = existing?.parser_version === CAI_PARSER_VERSION;
  if (existing && sameParser && existing.raw_sha256 === raw.sha256) return "unchanged";
  if (existing && sameParser && (source.updated_at ?? "") < (existing.updated_at ?? "")) return "older";
  const written = writeSource(db, { ...source, raw_path: raw.stored_path, raw_sha256: raw.sha256, parser_version: CAI_PARSER_VERSION }, parsed.turns);
  result.turnsWritten += written.turnsWritten;
  result.turnsRemoved += written.turnsRemoved;
  if (!existing) return "new";
  return sameParser && !written.turnsWritten && !written.turnsRemoved ? "unchanged" : "updated";
}
