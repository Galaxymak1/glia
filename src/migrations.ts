import type { Database } from "better-sqlite3";

export const EMBEDDING_DIMS = 1024;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Rebuilds a table that others reference (SQLite cannot alter a CHECK in place): foreign
   * keys are switched off around the migration, as SQLite's table-rebuild procedure requires,
   * and checked before it commits.
   */
  rebuildsTables?: boolean;
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
  {
    version: 2,
    name: "raw file registry",
    sql: `
      -- One row per distinct raw file received, keyed by the SHA-256 of its original
      -- bytes. The stored copy is scrubbed, then gzip-compressed under raw/ (SPEC.md,
      -- "Evidence layer"); stored_sha256 is the hash of that scrubbed content.
      -- A claude.ai export holds many conversations, so a raw file can back many sources:
      -- sources.raw_sha256 points here.
      CREATE TABLE raw_files (
        sha256           TEXT    PRIMARY KEY,
        stored_path      TEXT    NOT NULL,
        stored_sha256    TEXT    NOT NULL,
        origin_path      TEXT    NOT NULL,
        bytes            INTEGER NOT NULL,
        stored_bytes     INTEGER NOT NULL,
        redactions       INTEGER NOT NULL,
        scrubber_version TEXT    NOT NULL,
        received_at      TEXT    NOT NULL
      );
      CREATE INDEX raw_files_origin ON raw_files (origin_path, received_at);
    `,
  },
  {
    version: 3,
    name: "claude.ai source kinds",
    rebuildsTables: true,
    sql: `
      -- New source kinds for the claude.ai export (#5): cad = Claude Design chat,
      -- caa = claude.ai artifact or doc. Same columns as v1; only the CHECK changes.
      CREATE TABLE sources_v3 (
        id             INTEGER PRIMARY KEY,
        kind           TEXT    NOT NULL CHECK (kind IN ('cc', 'cai', 'cap', 'cad', 'caa', 'mem')),
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
      INSERT INTO sources_v3 SELECT * FROM sources;
      DROP TABLE sources;
      ALTER TABLE sources_v3 RENAME TO sources;
    `,
  },
  {
    version: 4,
    name: "chunk vectors",
    sql: `
      -- The meaning index embeds chunks of about 512 tokens, not whole turns (#7): a turn
      -- scores as its best chunk. A chunk's text is not stored; it is cut again from its turn
      -- (src/chunk.ts, deterministic). input_sha256 is the hash of the exact text embedded,
      -- header included, so a changed turn, title or chunking rule means a re-embed.
      CREATE TABLE chunks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id      INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
        ord          INTEGER NOT NULL,
        input_sha256 TEXT    NOT NULL,
        UNIQUE (turn_id, ord)
      );

      -- Bind chunk_id and dims as BigInt (see turns_vec in v1). BGE-M3 vectors are
      -- normalised; cosine distance ranks them as the model was trained to be compared.
      CREATE VIRTUAL TABLE chunks_vec USING vec0 (
        chunk_id  INTEGER PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_DIMS}] distance_metric=cosine,
        model     TEXT,
        dims      INTEGER
      );
      CREATE TRIGGER chunks_vec_ad AFTER DELETE ON chunks BEGIN
        DELETE FROM chunks_vec WHERE chunk_id = old.id;
      END;

      -- Never written: vectors per turn were replaced by vectors per chunk before any shipped.
      DROP TRIGGER turns_vec_ad;
      DROP TABLE turns_vec;
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
    // Must be set outside the transaction: inside one, SQLite ignores it. With foreign keys
    // on, dropping the old table would cascade-delete every turn.
    if (m.rebuildsTables) db.pragma("foreign_keys = OFF");
    try {
      const ran = db.transaction(() => {
        if (m.version <= schemaVersion(db)) return false;
        db.exec(m.sql);
        if (m.rebuildsTables) {
          const broken = db.pragma("foreign_key_check") as unknown[];
          if (broken.length) throw new Error(`migration ${m.version}: ${broken.length} foreign key violations`);
        }
        db.pragma(`user_version = ${m.version}`);
        return true;
      }).immediate();
      if (ran) applied.push(m.version);
    } finally {
      if (m.rebuildsTables) db.pragma("foreign_keys = ON");
    }
  }
  return applied;
}
