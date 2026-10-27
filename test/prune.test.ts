import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { isSuperseded, removeStaleTmp } from "../src/prune.js";
import { unparseableLine } from "../src/scrub.js";

describe("isSuperseded", () => {
  it("holds when every complete line of the older copy opens the newer one", () => {
    expect(isSuperseded("a\nb\n", "a\nb\nc\n")).toBe(true);
    expect(isSuperseded("a\nb\n", "a\nb\n")).toBe(true);
    expect(isSuperseded("a\nb", "a\nb")).toBe(true);
    // A last line cut off mid-write was stored as a marker; the newer copy has it whole.
    expect(isSuperseded(`a\n${unparseableLine('{"half')}\n`, 'a\n{"half":1}\n')).toBe(true);
  });

  it("does not hold for a rewritten copy, a partial line, or an empty one", () => {
    expect(isSuperseded("a\nB\n", "a\nb\nc\n")).toBe(false);
    expect(isSuperseded("a\nb", "a\nbc\n")).toBe(false);
    expect(isSuperseded("", "a\n")).toBe(false);
  });
});

describe("removeStaleTmp", () => {
  it("removes old temp files only", () => {
    const raw = mkdtempSync(join(tmpdir(), "brain-tmp-"));
    mkdirSync(join(raw, "ab"));
    writeFileSync(join(raw, "ab", "x.gz.1a2b.tmp"), "old");
    writeFileSync(join(raw, "ab", "y.gz.3c4d.tmp"), "new");
    writeFileSync(join(raw, "ab", "z.gz"), "kept");
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(join(raw, "ab", "x.gz.1a2b.tmp"), old, old);
    expect(removeStaleTmp(raw)).toBe(1);
    expect(readdirSync(join(raw, "ab")).sort()).toEqual(["y.gz.3c4d.tmp", "z.gz"]);
    rmSync(raw, { recursive: true, force: true });
  });
});

describe("brain ingest prunes superseded transcript copies", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-prune-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GLIA_CONFIG: join(dir, "no-config.json"), XDG_DATA_HOME: join(dir, "xdg-data"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
  const ingest = (db: string, ...paths: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ingest", "--db", db, ...paths], { encoding: "utf8", env });
  const S = "11111111-2222-3333-4444-555555555555";
  const turn = (n: number) =>
    JSON.stringify({ type: "user", uuid: `u${n}`, parentUuid: n > 1 ? `u${n - 1}` : null, sessionId: S, timestamp: `2026-10-24T10:00:${String(n).padStart(2, "0")}Z`, message: { role: "user", content: `message ${n}` } }) + "\n";
  const gzFiles = (raw: string) => readdirSync(raw, { recursive: true }).filter((f) => String(f).endsWith(".gz"));

  it("keeps one full copy of a session that grew several times, and knows the pruned ones", () => {
    const project = join(dir, "projects", "-home-me-dev");
    mkdirSync(project, { recursive: true });
    const file = join(project, `${S}.jsonl`);
    const db = join(dir, "db", "brain.db");
    writeFileSync(file, turn(1));
    ingest(db, join(dir, "projects"));
    const firstCopy = turn(1);
    appendFileSync(file, turn(2));
    ingest(db, join(dir, "projects"));
    appendFileSync(file, turn(3));
    const out = ingest(db, join(dir, "projects"));
    expect(out).toContain("Pruned 1 superseded transcript copies");

    const d = new Database(db, { readonly: true });
    expect(d.prepare("SELECT count(*) AS n FROM raw_files").get()).toEqual({ n: 3 });
    expect(d.prepare("SELECT count(*) AS n FROM raw_files WHERE pruned_at IS NULL").get()).toEqual({ n: 1 });
    // The copy the source points to is never pruned.
    const current = d.prepare("SELECT f.pruned_at, f.stored_path FROM sources s JOIN raw_files f ON f.sha256 = s.raw_sha256").get() as { pruned_at: string | null; stored_path: string };
    expect(current.pruned_at).toBeNull();
    expect(existsSync(join(dir, "db", "raw", current.stored_path))).toBe(true);
    expect(d.prepare("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 3 });
    d.close();
    expect(gzFiles(join(dir, "db", "raw"))).toHaveLength(1);

    // The first copy met again (a backup) is known: not stored, not parsed, and the source stays current.
    const backup = join(dir, "backup", "-home-me-dev");
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, `${S}.jsonl`), firstCopy);
    expect(ingest(db, join(dir, "backup"))).toMatch(/Stored 0 new files[^]*1 already-pruned copies met again/);
    const d2 = new Database(db, { readonly: true });
    expect(d2.prepare("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 3 });
    // Both paths it was read from are recorded.
    expect(d2.prepare("SELECT count(*) AS n FROM raw_file_origins o JOIN raw_files f USING (sha256) WHERE f.pruned_at IS NOT NULL").get()).toEqual({ n: 3 });
    d2.close();
    expect(gzFiles(join(dir, "db", "raw"))).toHaveLength(1);
  });

  it("keeps an older copy the current one does not hold in full", () => {
    const project = join(dir, "projects2", "-home-me-dev");
    mkdirSync(project, { recursive: true });
    const file = join(project, `${S}.jsonl`);
    const db = join(dir, "db2", "brain.db");
    writeFileSync(file, turn(1) + turn(2));
    ingest(db, join(dir, "projects2"));
    // Rewritten, not appended: the first line differs, and there are more turns.
    writeFileSync(file, turn(1).replace("message 1", "message one") + turn(2) + turn(3));
    expect(ingest(db, join(dir, "projects2"))).toContain("Pruned 0 superseded transcript copies (0.0 MB compressed); kept 1 older copies the current one does not hold in full");
    const d = new Database(db, { readonly: true });
    expect(d.prepare("SELECT count(*) AS n FROM raw_files WHERE pruned_at IS NULL").get()).toEqual({ n: 2 });
    d.close();
  });
});
