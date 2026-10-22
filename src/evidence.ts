// Evidence store (SPEC.md, "Evidence layer"): every raw file received is scrubbed,
// gzip-compressed and kept under raw/, addressed by the SHA-256 of its original bytes.
// Storing the same content again is a no-op: no new row, no new file.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { scrubFile } from "./scan.js";
import { SCRUBBER_VERSION, scrubText } from "./scrub.js";

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
}

export interface PutResult {
  file: RawFile;
  /** False when this content was already stored. */
  created: boolean;
  /** True when the content was known but its stored copy was missing or damaged, and was rewritten. */
  repaired: boolean;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Where raw files live for a given database: a `raw/` folder next to it. */
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
    if (existing && this.isIntact(existing)) return { file: existing, created: false, repaired: false };

    // A file name can hold a secret too; it is stored and reported scrubbed.
    const origin = scrubText(originPath).value;
    if (data.includes(0)) throw new Error(`${origin}: binary content, not stored`);
    const text = data.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(data)) throw new Error(`${origin}: not valid UTF-8, not stored`);

    const scrubbed = scrubFile(originPath, text);
    const gz = gzipSync(scrubbed.value);
    const storedPath = join(sha.slice(0, 2), `${sha}.gz`);
    writeAtomic(join(this.rawDir, storedPath), gz);

    if (existing) {
      // The row is known but its copy was missing or damaged: rewrite the copy (with
      // today's scrubber) and keep the row's first sighting (origin, received_at).
      this.db
        .prepare("UPDATE raw_files SET stored_sha256 = ?, stored_bytes = ?, redactions = ?, scrubber_version = ? WHERE sha256 = ?")
        .run(sha256(scrubbed.value), gz.length, scrubbed.findings.length, SCRUBBER_VERSION, sha);
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
    return changes ? { file, created: true, repaired: false } : { file: this.get(sha)!, created: false, repaired: false };
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
