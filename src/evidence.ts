// Evidence store (SPEC.md, "Evidence layer"): every raw file received is scrubbed,
// gzip-compressed and kept under raw/, addressed by the SHA-256 of its original bytes.
// Storing the same content again is a no-op: no new row, no new file.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { scrubFile } from "./scan.js";
import { SCRUBBER_VERSION, scrubJsonSource, scrubText } from "./scrub.js";

export interface RawFile {
  sha256: string;
  stored_path: string;
  stored_sha256: string;
  origin_path: string;
  bytes: number;
  stored_bytes: number;
  redactions: number;
  scrubber_version: string;
  received_at: string;
  /** Set when the copy was pruned as superseded (#20): the file is gone, the row stays. */
  pruned_at: string | null;
}

export interface PutResult {
  file: RawFile;
  /** False when this content was already stored. */
  created: boolean;
  /** True when the content was known but its stored copy was missing or damaged, and was rewritten. */
  repaired: boolean;
  /** True when this content is a pruned, superseded copy: nothing was stored, and it is not to be parsed. */
  pruned?: boolean;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/**
 * A path with any secret in it redacted, segment by segment, so that rules anchored at
 * the start of a line (`DB_PASSWORD=...`) also apply to a file name.
 */
export const scrubPath = (path: string) =>
  path
    // Either separator, kept as it was: Windows takes both, and a path may mix them.
    .split(/([\\/])/)
    .map((part) => {
      if (part === "/" || part === "\\") return part;
      // Without its extension first: `DB_PASSWORD=x.md` would otherwise read as code (`a.b`).
      const ext = extname(part);
      const base = ext ? part.slice(0, -ext.length) : part;
      return scrubText(scrubText(base).value + ext).value;
    })
    .join("");

export const rawDirFor = (dbPath: string) => join(dirname(dbPath), "raw");

export class EvidenceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly rawDir: string,
  ) {}

  get(sha: string): RawFile | undefined {
    return this.db.prepare("SELECT * FROM raw_files WHERE sha256 = ?").get(sha) as RawFile | undefined;
  }

  /**
   * Stores `data`, read from `originPath`, unless the same bytes were stored before.
   * Throws on binary or non-UTF-8 content: the scrubber works on text, and a stored
   * copy that could not be scrubbed would break the scrub-before-store rule.
   */
  put(originPath: string, data: Buffer, receivedAt = new Date()): PutResult {
    const sha = sha256(data);
    const existing = this.get(sha);
    // A file name can hold a secret too; it is stored and reported scrubbed.
    const origin = scrubPath(originPath);
    if (existing?.pruned_at) {
      this.addOrigin(sha, origin, receivedAt);
      return { file: existing, created: false, repaired: false, pruned: true };
    }
    if (existing && this.isIntact(existing)) {
      this.addOrigin(sha, origin, receivedAt);
      return { file: existing, created: false, repaired: false };
    }

    if (data.includes(0)) throw new Error(`${origin}: binary content, not stored`);
    const text = data.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(data)) throw new Error(`${origin}: not valid UTF-8, not stored`);
    // A .json file that does not parse (a truncated export) cannot be scrubbed safely.
    const json = originPath.endsWith(".json") ? scrubJsonSource(text) : null;
    if (originPath.endsWith(".json") && !json) throw new Error(`${origin}: not valid JSON, not stored`);

    const scrubbed = json ?? scrubFile(originPath, text);
    const gz = gzipSync(scrubbed.value);
    const storedPath = join(sha.slice(0, 2), `${sha}.gz`);
    writeAtomic(join(this.rawDir, storedPath), gz);

    if (existing) {
      // The row is known but its copy was missing or damaged: rewrite the copy (with
      // today's scrubber) and keep the row's first sighting (origin, received_at).
      this.db
        .prepare("UPDATE raw_files SET stored_sha256 = ?, stored_bytes = ?, redactions = ?, scrubber_version = ? WHERE sha256 = ?")
        .run(sha256(scrubbed.value), gz.length, scrubbed.findings.length, SCRUBBER_VERSION, sha);
      this.addOrigin(sha, origin, receivedAt);
      return { file: this.get(sha)!, created: false, repaired: true };
    }

    const file: RawFile = {
      sha256: sha,
      stored_path: storedPath,
      stored_sha256: sha256(scrubbed.value),
      origin_path: origin,
      bytes: data.length,
      stored_bytes: gz.length,
      redactions: scrubbed.findings.length,
      scrubber_version: SCRUBBER_VERSION,
      received_at: receivedAt.toISOString(),
      pruned_at: null,
    };
    // OR IGNORE: a concurrent ingest of the same content may have won the race; its
    // file has the same name and the same content, so either copy is correct.
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO raw_files
           (sha256, stored_path, stored_sha256, origin_path, bytes, stored_bytes, redactions, scrubber_version, received_at)
         VALUES (@sha256, @stored_path, @stored_sha256, @origin_path, @bytes, @stored_bytes, @redactions, @scrubber_version, @received_at)`,
      )
      .run(file);
    this.addOrigin(sha, origin, receivedAt);
    return changes ? { file, created: true, repaired: false } : { file: this.get(sha)!, created: false, repaired: false };
  }

  /** Records one more path the content was read from; the first sighting of each path is kept. */
  private addOrigin(sha: string, origin: string, seen: Date): void {
    this.db.prepare("INSERT OR IGNORE INTO raw_file_origins (sha256, origin_path, first_seen) VALUES (?, ?, ?)").run(sha, origin, seen.toISOString());
  }

  /**
   * Deletes a stored copy and keeps its row, marked pruned. The file goes first: a failed delete
   * leaves the row as it was, and a crash in between leaves a row whose copy the next put repairs.
   */
  prune(sha: string, now = new Date()): void {
    const file = this.get(sha);
    if (!file || file.pruned_at) return;
    rmSync(join(this.rawDir, file.stored_path), { force: true });
    this.db.prepare("UPDATE raw_files SET pruned_at = ? WHERE sha256 = ?").run(now.toISOString(), sha);
  }

  /** Whether the stored copy exists and still matches its recorded hash. */
  private isIntact(file: RawFile): boolean {
    try {
      return sha256(gunzipSync(readFileSync(join(this.rawDir, file.stored_path)))) === file.stored_sha256;
    } catch {
      return false;
    }
  }

  /** The stored (scrubbed) content; throws if the file is missing or does not match its hash. */
  read(sha: string): string {
    const file = this.get(sha);
    if (!file) throw new Error(`no raw file ${sha}`);
    if (file.pruned_at) throw new Error(`raw file ${sha} was pruned as a superseded copy`);
    const path = join(this.rawDir, file.stored_path);
    const text = gunzipSync(readFileSync(path)).toString("utf8");
    if (sha256(text) !== file.stored_sha256) throw new Error(`${relative(process.cwd(), path)}: content does not match its stored hash`);
    return text;
  }
}

/**
 * Writes through a temp file and a rename, so a crash never leaves a partial file under
 * its final name. Owner-only permissions: the store holds a whole conversation history.
 */
function writeAtomic(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
