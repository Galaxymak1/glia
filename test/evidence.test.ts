import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { EvidenceStore } from "../src/evidence.js";
import { migrate } from "../src/migrations.js";
import { SCRUBBER_VERSION } from "../src/scrub.js";

const SECRET = "gh" + "p_" + "R".repeat(36);
const transcript = Buffer.from(
  [
    JSON.stringify({ type: "user", uuid: "u1", message: { content: `deploy with ${SECRET}` } }),
    `{"type":"assistant","uuid":"a1","n":12345678901234567890,"ratio":1.0}`,
    "",
  ].join("\n"),
);

let dir: string;
let db: ReturnType<typeof openDb>;
let store: EvidenceStore;
const rawDir = () => join(dir, "raw");
const filesOnDisk = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name));
  };
  try {
    walk(rawDir());
  } catch {
    // no raw dir yet
  }
  return out;
};
const rowCount = () => (db.prepare("SELECT count(*) AS n FROM raw_files").get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-evidence-"));
  db = openDb(join(dir, "brain.db"));
  migrate(db);
  store = new EvidenceStore(db, rawDir());
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("EvidenceStore.put", () => {
  it("stores a scrubbed, gzip-compressed copy addressed by the original SHA-256", () => {
    const { file, created } = store.put("/home/me/.claude/projects/p/s1.jsonl", transcript, new Date("2026-10-22T08:00:00Z"));
    expect(created).toBe(true);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.stored_path).toBe(join(file.sha256.slice(0, 2), `${file.sha256}.gz`));
    expect(file).toMatchObject({ origin_path: "/home/me/.claude/projects/p/s1.jsonl", bytes: transcript.length, redactions: 1, scrubber_version: SCRUBBER_VERSION, received_at: "2026-10-22T08:00:00.000Z" });

    const onDisk = readFileSync(join(rawDir(), file.stored_path));
    expect(file.stored_bytes).toBe(onDisk.length);
    const stored = gunzipSync(onDisk).toString("utf8");
    expect(stored).not.toContain(SECRET);
    // Only the secret changed: the untouched line keeps its big integer and 1.0 byte for byte.
    expect(stored).toBe(transcript.toString("utf8").replace(SECRET, "[REDACTED:github_token]"));
    expect(store.read(file.sha256)).toBe(stored);
  });

  it("adds 0 rows and 0 files when the same content is stored again", () => {
    store.put("/a/s1.jsonl", transcript);
    const files = filesOnDisk();
    const mtimes = files.map((f) => statSync(f).mtimeMs);
    expect([rowCount(), files.length]).toEqual([1, 1]);

    const again = store.put("/a/s1.jsonl", transcript);
    const elsewhere = store.put("/b/copy-of-s1.jsonl", Buffer.from(transcript));
    expect([again.created, elsewhere.created]).toEqual([false, false]);
    expect(elsewhere.file.origin_path).toBe("/a/s1.jsonl"); // first sighting is kept
    expect([rowCount(), filesOnDisk().length]).toEqual([1, 1]);
    expect(filesOnDisk().map((f) => statSync(f).mtimeMs)).toEqual(mtimes); // not rewritten
  });

  it("stores a changed file as a new version", () => {
    store.put("/a/s1.jsonl", transcript);
    store.put("/a/s1.jsonl", Buffer.concat([transcript, Buffer.from('{"type":"user","uuid":"u2"}\n')]));
    expect([rowCount(), filesOnDisk().length]).toEqual([2, 2]);
  });

  it("refuses binary and non-UTF-8 content, storing nothing", () => {
    expect(() => store.put("/a/image.json", Buffer.from([0x7b, 0x00, 0x7d]))).toThrow(/binary/);
    expect(() => store.put("/a/latin1.md", Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toThrow(/UTF-8/);
    expect([rowCount(), filesOnDisk().length]).toEqual([0, 0]);
  });

  it("leaves no temp files behind", () => {
    store.put("/a/s1.jsonl", transcript);
    expect(filesOnDisk().filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("EvidenceStore repair and safety", () => {
  it("rewrites a stored copy that went missing or was damaged", () => {
    const { file } = store.put("/a/s1.jsonl", transcript);
    const path = join(rawDir(), file.stored_path);
    const good = readFileSync(path);

    rmSync(path);
    const afterDelete = store.put("/a/s1.jsonl", transcript);
    expect([afterDelete.created, afterDelete.repaired]).toEqual([false, true]);
    expect(readFileSync(path).equals(good)).toBe(true);

    writeFileSync(path, gzipSync("tampered\n"));
    expect(store.put("/a/s1.jsonl", transcript).repaired).toBe(true);
    expect(store.read(file.sha256)).toBe(gunzipSync(good).toString("utf8"));
    expect([rowCount(), filesOnDisk().length]).toEqual([1, 1]);
  });

  it("keeps the store owner-only", () => {
    const { file } = store.put("/a/s1.jsonl", transcript);
    expect(statSync(rawDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(rawDir(), file.sha256.slice(0, 2))).mode & 0o777).toBe(0o700);
    expect(statSync(join(rawDir(), file.stored_path)).mode & 0o777).toBe(0o600);
  });

  it("scrubs the origin path too", () => {
    const { file } = store.put(`/tmp/${SECRET}/notes.md`, Buffer.from("notes\n"));
    expect(file.origin_path).toBe("/tmp/[REDACTED:github_token]/notes.md");
  });
});

describe("EvidenceStore.read", () => {
  it("detects a stored file that no longer matches its hash", () => {
    const { file } = store.put("/a/notes.md", Buffer.from("plain notes\n"));
    writeFileSync(join(rawDir(), file.stored_path), gzipSync("tampered\n"));
    expect(() => store.read(file.sha256)).toThrow(/does not match/);
  });

  it("throws for an unknown hash", () => {
    expect(() => store.read("0".repeat(64))).toThrow(/no raw file/);
  });
});

