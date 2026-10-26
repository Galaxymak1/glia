import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { EMBEDDING_DIMS, migrate, migrations, schemaVersion } from "../src/migrations.js";

const schemaDump = (db: ReturnType<typeof openDb>) =>
  db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

describe("migrate", () => {
  it("creates the Phase 0 evidence tables", () => {
    const db = openDb(":memory:");
    expect(migrate(db)).toEqual(migrations.map((m) => m.version));
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["sources", "turns", "turns_fts", "chunks", "chunks_vec", "jobs"]) expect(names).toContain(t);
    expect(names).not.toContain("turns_vec");
    expect(schemaVersion(db)).toBe(migrations.at(-1)!.version);
  });

  it("changes nothing when run twice", () => {
    const db = openDb(":memory:");
    migrate(db);
    const before = schemaDump(db);
    expect(migrate(db)).toEqual([]);
    expect(schemaDump(db)).toEqual(before);
  });

  it("keeps turns_fts in sync and folds diacritics", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO sources (id, kind, external_id, raw_path, raw_sha256, parser_version) VALUES (1, 'cc', 's1', 'raw/s1.jsonl.gz', 'abc', 'cc@1')").run();
    db.prepare("INSERT INTO turns (id, source_id, external_uuid, role, text) VALUES (1, 1, 'u1', 'user', 'On part sur SQLite, pas Postgres : décision prise')").run();
    const match = (q: string) => (db.prepare("SELECT rowid FROM turns_fts WHERE turns_fts MATCH ?").all(q) as { rowid: number }[]).map((r) => r.rowid);
    expect(match("decision")).toEqual([1]);
    db.prepare("UPDATE turns SET text = 'nouveau texte' WHERE id = 1").run();
    expect(match("decision")).toEqual([]);
    expect(match("nouveau")).toEqual([1]);
    db.prepare("DELETE FROM turns WHERE id = 1").run();
    expect(match("nouveau")).toEqual([]);
  });

  it("stores vectors with their model and dimension", () => {
    const db = openDb(":memory:");
    migrate(db);
    const v = new Float32Array(EMBEDDING_DIMS).fill(0.5);
    db.prepare("INSERT INTO chunks_vec (chunk_id, embedding, model, dims) VALUES (?, ?, ?, ?)").run(1n, v, "bge-m3", BigInt(EMBEDDING_DIMS));
    expect(db.prepare("SELECT chunk_id, model, dims FROM chunks_vec").get()).toEqual({ chunk_id: 1, model: "bge-m3", dims: EMBEDDING_DIMS });
    expect(() => db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(2n, new Float32Array(8))).toThrow();
  });

  it("drops a turn's chunks and vectors with the turn and never reuses its id", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO sources (id, kind, external_id, raw_path, raw_sha256, parser_version) VALUES (1, 'cc', 's1', 'raw', 'abc', 'cc@1')").run();
    const turn = db.prepare("INSERT INTO turns (source_id, external_uuid, role, text) VALUES (1, ?, 'user', ?)");
    turn.run("u1", "alpha");
    const { lastInsertRowid: oldId } = turn.run("u2", "beta");
    const { lastInsertRowid: chunkId } = db.prepare("INSERT INTO chunks (turn_id, ord, input_sha256) VALUES (?, 0, 'h')").run(oldId);
    db.prepare("INSERT INTO chunks_vec (chunk_id, embedding, model, dims) VALUES (?, ?, 'bge-m3', ?)").run(BigInt(chunkId), new Float32Array(EMBEDDING_DIMS), BigInt(EMBEDDING_DIMS));
    db.prepare("DELETE FROM sources WHERE id = 1").run(); // cascades to turns, as a re-parse would
    expect(db.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM chunks_vec").get()).toEqual({ n: 0 });
    db.prepare("INSERT INTO sources (id, kind, external_id, raw_path, raw_sha256, parser_version) VALUES (1, 'cc', 's1', 'raw', 'abc', 'cc@2')").run();
    const { lastInsertRowid: newId } = turn.run("u3", "delta");
    expect(Number(newId)).toBeGreaterThan(Number(oldId));
  });

  it("upgrades a v2 database with data to the latest schema without losing turns or search rows", () => {
    const db = openDb(":memory:");
    for (const m of migrations.filter((m) => m.version <= 2)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare("INSERT INTO sources (id, kind, external_id, raw_path, raw_sha256, parser_version) VALUES (1, 'cc', 's1', 'raw', 'abc', 'cc@1')").run();
    db.prepare("INSERT INTO turns (id, source_id, external_uuid, role, text) VALUES (1, 1, 'u1', 'user', 'décision SQLite')").run();
    db.prepare("INSERT INTO turns_vec (turn_id, embedding, model, dims) VALUES (?, ?, 'bge-m3', ?)").run(1n, new Float32Array(EMBEDDING_DIMS), BigInt(EMBEDDING_DIMS));
    expect(migrate(db)).toEqual(migrations.filter((m) => m.version > 2).map((m) => m.version));
    expect(db.prepare("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'decision'").all()).toEqual([{ rowid: 1 }]);
    // v3 kept the per-turn vector table; v4 replaced it with chunk vectors.
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'turns_vec'").get()).toEqual({ n: 0 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.prepare("INSERT INTO sources (kind, external_id, raw_path, raw_sha256, parser_version) VALUES ('caa', 'a1', 'raw', 'abc', 'cai@1')").run();
    // The foreign key still holds: deleting the source cascades to its turns.
    db.prepare("DELETE FROM sources WHERE id = 1").run();
    expect(db.prepare("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 0 });
  });
});

