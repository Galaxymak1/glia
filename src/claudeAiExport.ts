// Ingests a claude.ai export ZIP: kept entries are stored one by one in the evidence store
// (scrubbed there, #3), then parsed from their stored copies into sources and turns.

import type Database from "better-sqlite3";
import { unzipSync } from "fflate";
import type { EvidenceStore, RawFile } from "./evidence.js";
import {
  CAI_PARSER_VERSION,
  type CaiStats,
  EXPORT_CATEGORIES,
  type ExportCategory,
  exportCategory,
  htmlText,
  isIngestedEntry,
  looksLikeExportJson,
  newestVersion,
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

/**
 * When the export wrote each entry, from the ZIP's central directory: the extended timestamp
 * (UTC) when present, else the DOS date and time (no time zone, read as UTC). Entries dated
 * 1980 (the DOS zero date, which claude.ai's exporter writes) and unreadable directories give
 * no time.
 */
export function entryTimes(zip: Uint8Array): Map<string, string> {
  const times = new Map<string, string>();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return times;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length && view.getUint32(p, true) === 0x02014b50; n++) {
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLength));
    const t = view.getUint16(p + 12, true);
    const d = view.getUint16(p + 14, true);
    let ms = Date.UTC(1980 + (d >> 9), ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2);
    for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength; ) {
      const id = view.getUint16(e, true);
      const size = view.getUint16(e + 2, true);
      if (id === 0x5455 && size >= 5 && view.getUint8(e + 4) & 1) ms = view.getUint32(e + 5, true) * 1000;
      e += 4 + size;
    }
    if (Number.isFinite(ms) && ms >= Date.UTC(1981, 0, 1)) times.set(name, new Date(ms).toISOString());
    p += 46 + nameLength + extraLength + commentLength;
  }
  return times;
}

/**
 * `zipTime` is the ZIP file's modification time: the export's date when its entries carry none
 * (it dates claude.ai memory, which has no date of its own).
 */
export function ingestExportZip(
  db: Database.Database,
  store: EvidenceStore,
  zipPath: string,
  data: Buffer,
  receivedAt = new Date(),
  zipTime: Date | null = null,
): ExportResult {
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

  // File names alone do not make an export: a JSON entry is kept only with the shape claude.ai
  // gives it, and an artifact folder's files only with a recognised artifact.json. A ZIP with
  // no recognised entry is left alone. Unreadable JSON in an export stays, so store.put reports it.
  const shapes = new Map<string, "ok" | "unreadable" | "unrecognised">();
  const shape = (name: string) => {
    let r = shapes.get(name);
    if (!r) {
      try {
        r = looksLikeExportJson(name, JSON.parse(Buffer.from(files[name]!).toString("utf8"))) ? "ok" : "unrecognised";
      } catch {
        r = "unreadable";
      }
      shapes.set(name, r);
    }
    return r;
  };
  const verdict = (name: string) => {
    const folder = /^artifacts\/[^/]+\//.exec(name)?.[0];
    if (folder && (!files[`${folder}artifact.json`] || shape(`${folder}artifact.json`) !== "ok")) return "unrecognised";
    return name.endsWith(".json") ? shape(name) : "ok";
  };
  const verdicts = Object.keys(files).map((name) => [name, verdict(name)] as const);
  if (!verdicts.some(([, v]) => v === "ok")) {
    // Still an export when it holds a category that is never ingested (account metadata):
    // nothing of it is stored either way, and it is reported as left out.
    const known = Object.keys(result.notIngested).some((c) => c in EXPORT_CATEGORIES && !EXPORT_CATEGORIES[c as ExportCategory]);
    if (!known) return { ...result, notIngested: {} };
    if (verdicts.length) result.notIngested.unrecognised = verdicts.length;
    result.isExport = true;
    return result;
  }
  for (const [name, v] of verdicts) {
    if (v !== "unrecognised") continue;
    delete files[name];
    result.notIngested.unrecognised = (result.notIngested.unrecognised ?? 0) + 1;
  }
  const exportedAt = entryTimes(zip);

  result.isExport = true;
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

  const index = (parsed: ParsedSource | null, raw: RawFile, rawIsWhole = true) => {
    if (!parsed) return;
    const status = indexSource(db, parsed, raw, rawIsWhole, result);
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
      else if (category === "memories") index(parseMemories(readJson(name), exportedAt.get(name) ?? zipTime?.toISOString() ?? null), stored.get(name)!);
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
      const newestHtml = newestVersion(html.keys());
      const main = page !== null ? `${dir}page.md` : newestHtml ? `${dir}versions/${newestHtml}` : `${dir}artifact.json`;
      // Its other entries (artifact.json, comments.json) feed it too: no shortcut on the main one.
      index(parseArtifact(readJson(`${dir}artifact.json`), page, html, comments), stored.get(main)!, false);
    } catch (err) {
      result.errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/**
 * Writes one parsed source unless the stored one is as new: a source from another export
 * replaces it only when its `updated_at` is not earlier (conversations are upserted by uuid
 * and updated_at, SPEC.md), so re-importing an older export changes nothing. When `raw` is
 * the source's only input (`rawIsWhole`), the same raw copy means nothing changed.
 */
function indexSource(db: Database.Database, parsed: ParsedSource, raw: RawFile, rawIsWhole: boolean, result: ExportResult): SourceStatus {
  const { source } = parsed;
  const existing = findSource(db, source.kind, source.external_id);
  const sameParser = existing?.parser_version === CAI_PARSER_VERSION;
  if (existing && sameParser && rawIsWhole && existing.raw_sha256 === raw.sha256) return "unchanged";
  if (existing && sameParser && (source.updated_at ?? "") < (existing.updated_at ?? "")) return "older";
  const written = writeSource(db, { ...source, raw_path: raw.stored_path, raw_sha256: raw.sha256, parser_version: CAI_PARSER_VERSION }, parsed.turns);
  result.turnsWritten += written.turnsWritten;
  result.turnsRemoved += written.turnsRemoved;
  if (!existing) return "new";
  return sameParser && !written.turnsWritten && !written.turnsRemoved ? "unchanged" : "updated";
}
