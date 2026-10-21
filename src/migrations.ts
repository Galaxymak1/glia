import type { Database } from "better-sqlite3";

export const EMBEDDING_DIMS = 1024;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Append only: never edit a migration that has shipped; add a new one.
// The schema follows SPEC.md, "Index and log (SQLite)". Claim tables arrive in Phase 1.
export const migrations: Migration[] = [
  {
    version: 1,
    name: "evidence layer",
    sql: `
      CREATE TABLE sources (
        id             INTEGER PRIMARY KEY,
        kind           TEXT    NOT NULL CHECK (kind IN ('cc', 'cai', 'cap', 'mem')),
        external_id    TEXT    NOT NULL,
        title          TEXT,
        project_hint   TEXT,
        cwd            TEXT,
        git_remote     TEXT,
        created_at     TEXT,
        updated_at     TEXT,
        raw_path       TEXT    NOT NULL,
        raw_sha256     TEXT    NOT NULL,
        parser_version TEXT    NOT NULL,
        excluded       INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
        UNIQUE (kind, external_id)
      );

      -- AUTOINCREMENT: a deleted turn's id is never reused, so nothing keyed by
      -- turn id (FTS rows, vectors) can attach to a different turn.
      CREATE TABLE turns (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id     INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
        external_uuid TEXT    NOT NULL,
        parent_uuid   TEXT,
        role          TEXT    NOT NULL,
        ts            TEXT,
        text          TEXT    NOT NULL,
        is_sidechain  INTEGER NOT NULL DEFAULT 0 CHECK (is_sidechain IN (0, 1)),
        is_injected   INTEGER NOT NULL DEFAULT 0 CHECK (is_injected IN (0, 1)),
        lang          TEXT    CHECK (lang IN ('fr', 'en', 'mixed')),
        UNIQUE (source_id, external_uuid)
      );
      CREATE INDEX turns_source_ts ON turns (source_id, ts);

      -- External-content FTS index over turns.text, kept in sync by triggers.
      CREATE VIRTUAL TABLE turns_fts USING fts5 (
        text,
        content = 'turns',
        content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER turns_fts_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts (rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER turns_fts_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts (turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER turns_fts_au AFTER UPDATE OF text ON turns BEGIN
        INSERT INTO turns_fts (turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO turns_fts (rowid, text) VALUES (new.id, new.text);
      END;

      -- Each vector row records its model and dimension, so a model change
      -- triggers a re-embed instead of mixing spaces. vec0 rejects JS numbers for
      -- INTEGER columns (better-sqlite3 binds them as REAL): bind turn_id and dims as BigInt.
      CREATE VIRTUAL TABLE turns_vec USING vec0 (
        turn_id   INTEGER PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_DIMS}],
        model     TEXT,
        dims      INTEGER
      );
      -- vec0 cannot hold a foreign key; drop a turn's vector with the turn.
      CREATE TRIGGER turns_vec_ad AFTER DELETE ON turns BEGIN
        DELETE FROM turns_vec WHERE turn_id = old.id;
      END;

      CREATE TABLE jobs (
        id          INTEGER PRIMARY KEY,
        type        TEXT NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled', 'expired')),
        batch_id    TEXT,
        started_at  TEXT,
        finished_at TEXT
      );
    `,
  },
];

export function schemaVersion(db: Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/** Applies pending migrations in order; returns the versions applied (empty when up to date). */
export function migrate(db: Database): number[] {
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= schemaVersion(db)) continue;
    // IMMEDIATE takes the write lock up front; re-checking inside it means a
    // concurrent `brain init` that got there first turns this into a no-op.
    const ran = db.transaction(() => {
      if (m.version <= schemaVersion(db)) return false;
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
      return true;
    }).immediate();
    if (ran) applied.push(m.version);
  }
  return applied;
}
