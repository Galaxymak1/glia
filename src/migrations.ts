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
  {
    version: 5,
    name: "session opt-outs",
    sql: `
      -- Claude Code sessions the user opted out of by typing #nobrain (#22). Nothing of them is
      -- stored; this row is the audit trail of the purge and names the session, never its content.
      CREATE TABLE opt_outs (
        session_id       TEXT    PRIMARY KEY,
        opted_out_at     TEXT    NOT NULL,
        sources_purged   INTEGER NOT NULL,
        raw_files_purged INTEGER NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "pruned copies and every origin",
    sql: `
      -- A transcript copy superseded by a newer one that holds all its lines is pruned (#20): its
      -- file is deleted and its row kept with pruned_at set, so the same bytes met again are known
      -- and neither stored nor parsed.
      ALTER TABLE raw_files ADD COLUMN pruned_at TEXT;
      -- Every path a raw file was read from, not only the first (raw_files.origin_path).
      CREATE TABLE raw_file_origins (
        sha256      TEXT NOT NULL REFERENCES raw_files (sha256) ON DELETE CASCADE,
        origin_path TEXT NOT NULL,
        first_seen  TEXT NOT NULL,
        PRIMARY KEY (sha256, origin_path)
      );
      INSERT INTO raw_file_origins (sha256, origin_path, first_seen) SELECT sha256, origin_path, received_at FROM raw_files;
      -- Pruning and purging ask which sources still point to a raw file.
      CREATE INDEX sources_raw_sha256 ON sources (raw_sha256);
    `,
  },
  {
    version: 7,
    name: "evaluation runs",
    sql: `
      -- One row per brain eval run (#10, SPEC.md "Evaluation"), and one result per question and
      -- arm (A: claude.ai chat search, asked by hand; B: claude -p with the local MCP tools).
      -- Each result keeps the question as it was asked, so later edits to the set leave old runs readable.
      CREATE TABLE eval_runs (
        id               INTEGER PRIMARY KEY,
        started_at       TEXT    NOT NULL,
        finished_at      TEXT,
        questions_sha256 TEXT    NOT NULL,
        questions        INTEGER NOT NULL,
        model            TEXT    NOT NULL,
        judge_model      TEXT    NOT NULL,
        base_url         TEXT
      );
      CREATE TABLE eval_results (
        run_id       INTEGER NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
        question_id  TEXT    NOT NULL,
        arm          TEXT    NOT NULL CHECK (arm IN ('A', 'B')),
        category     TEXT    NOT NULL,
        location     TEXT    NOT NULL CHECK (location IN ('cai', 'cc', 'both')),
        question     TEXT    NOT NULL,
        reference    TEXT    NOT NULL,
        answer       TEXT,
        verdict      TEXT    NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'error')),
        reason       TEXT,
        hit_at_8     INTEGER CHECK (hit_at_8 IN (0, 1)),
        searches     TEXT,
        hand_verdict TEXT    CHECK (hand_verdict IN ('correct', 'incorrect')),
        seconds      REAL,
        PRIMARY KEY (run_id, question_id, arm)
      );
    `,
  },
  {
    version: 8,
    name: "claim layer",
    sql: `
      -- A mirror of the claim files in the vault (#34, SPEC.md "Claim layer"): the files are the
      -- truth, and these rows are rebuilt from them (src/claimIndex.ts). JSON columns hold the
      -- frontmatter's lists and objects; extra holds properties added by hand (Obsidian tags).
      CREATE TABLE claims (
        n                    INTEGER PRIMARY KEY AUTOINCREMENT,
        id                   TEXT    NOT NULL UNIQUE,
        kind                 TEXT    NOT NULL CHECK (kind IN ('profile', 'preference', 'project_fact', 'decision', 'lesson', 'procedure')),
        scope                TEXT    NOT NULL,
        statement            TEXT    NOT NULL,
        statement_lang       TEXT    NOT NULL CHECK (statement_lang IN ('fr', 'en', 'mixed')),
        origin               TEXT    NOT NULL CHECK (origin IN ('user_stated', 'user_confirmed', 'ai_suggested', 'ai_inferred', 'external_doc', 'imported_memory')),
        evidence             TEXT    NOT NULL,
        extractor            TEXT,
        confidence           REAL    NOT NULL,
        valid_from           TEXT,
        valid_from_precision TEXT    NOT NULL CHECK (valid_from_precision IN ('day', 'month', 'year', 'approx', 'unknown')),
        valid_to             TEXT,
        recorded_at          TEXT    NOT NULL,
        supersedes           TEXT    NOT NULL,
        superseded_by        TEXT,
        status               TEXT    NOT NULL CHECK (status IN ('proposed', 'active', 'superseded', 'retracted', 'rejected', 'expired')),
        review               TEXT    NOT NULL CHECK (review IN ('auto_accepted', 'pending', 'approved', 'edited', 'rejected')),
        reviewed_at          TEXT,
        sensitivity          TEXT    NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
        options              TEXT,
        rationale            TEXT,
        expected_outcome     TEXT,
        revisit_on           TEXT,
        extra                TEXT,
        file_path            TEXT    NOT NULL,
        file_sha             TEXT    NOT NULL
      );
      CREATE INDEX claims_scope_status ON claims (scope, status);

      CREATE VIRTUAL TABLE claims_fts USING fts5 (
        statement,
        content = 'claims',
        content_rowid = 'n',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER claims_fts_ai AFTER INSERT ON claims BEGIN
        INSERT INTO claims_fts (rowid, statement) VALUES (new.n, new.statement);
      END;
      CREATE TRIGGER claims_fts_ad AFTER DELETE ON claims BEGIN
        INSERT INTO claims_fts (claims_fts, rowid, statement) VALUES ('delete', old.n, old.statement);
      END;
      CREATE TRIGGER claims_fts_au AFTER UPDATE OF statement ON claims BEGIN
        INSERT INTO claims_fts (claims_fts, rowid, statement) VALUES ('delete', old.n, old.statement);
        INSERT INTO claims_fts (rowid, statement) VALUES (new.n, new.statement);
      END;

      -- Bind claim_n and dims as BigInt (see turns_vec in v1). input_sha256 is the hash of the
      -- statement embedded: an edited statement is embedded again.
      CREATE VIRTUAL TABLE claims_vec USING vec0 (
        claim_n      INTEGER PRIMARY KEY,
        embedding    FLOAT[${EMBEDDING_DIMS}] distance_metric=cosine,
        model        TEXT,
        dims         INTEGER,
        input_sha256 TEXT
      );
      CREATE TRIGGER claims_vec_ad AFTER DELETE ON claims BEGIN
        DELETE FROM claims_vec WHERE claim_n = old.n;
      END;

      CREATE TABLE edges (
        src        TEXT NOT NULL,
        dst        TEXT NOT NULL,
        type       TEXT NOT NULL CHECK (type IN ('supersedes', 'contradicts', 'refines', 'about', 'derived_from')),
        valid_from TEXT,
        valid_to   TEXT,
        PRIMARY KEY (src, dst, type)
      );

      -- Which claim was served to which session (#41), so recalled text is known when it comes back.
      CREATE TABLE retrievals (
        claim_id    TEXT NOT NULL,
        client      TEXT NOT NULL,
        session_ref TEXT,
        ts          TEXT NOT NULL
      );
      CREATE INDEX retrievals_claim ON retrievals (claim_id);

      -- The review inbox (SPEC.md "Review inbox"). A proposed claim lives here, not in the vault,
      -- until it is accepted; statement_key keeps a rejected statement from coming back.
      CREATE TABLE proposals (
        id            TEXT    PRIMARY KEY,
        kind          TEXT    NOT NULL CHECK (kind IN ('claim', 'decision', 'audit')),
        claim_id      TEXT    NOT NULL,
        claim_json    TEXT,
        statement_key TEXT,
        reason        TEXT    NOT NULL,
        similar_to    TEXT,
        created_at    TEXT    NOT NULL,
        expires_at    TEXT    NOT NULL,
        snoozed_until TEXT,
        shown_at      TEXT,
        decided_at    TEXT,
        decision_ms   INTEGER,
        state         TEXT    NOT NULL CHECK (state IN ('open', 'accepted', 'edited', 'merged', 'rejected', 'expired'))
      );
      CREATE INDEX proposals_state ON proposals (state, created_at);
      CREATE INDEX proposals_statement_key ON proposals (statement_key);

      -- Append-only audit trail, mirrored to log.md in the vault.
      CREATE TABLE log (
        ts       TEXT NOT NULL,
        actor    TEXT NOT NULL,
        action   TEXT NOT NULL,
        claim_id TEXT,
        payload  TEXT
      );
    `,
  },
  {
    version: 9,
    name: "extraction state",
    sql: `
      -- What each source looked like when it was last sent to extraction (#35): a source is
      -- selected again only when the hash of its extraction input changes.
      CREATE TABLE extraction_state (
        source_id    INTEGER PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
        input_sha256 TEXT    NOT NULL,
        job_id       INTEGER NOT NULL,
        submitted_at TEXT    NOT NULL
      );
    `,
  },
  {
    version: 10,
    name: "extraction jobs and candidates",
    sql: `
      -- An extract job's payload (#36) maps each request's custom_id to its source and its turn
      -- refs (T1 → turn id), and once the batch ends, holds its token usage.
      ALTER TABLE jobs ADD COLUMN payload TEXT;

      -- One row per claim the model returned, carried through validation, deduplication and
      -- routing (#37-#39) by state. claim_json starts as the model's output with each evidence
      -- turn resolved to a turn id.
      CREATE TABLE candidates (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id     INTEGER NOT NULL REFERENCES jobs (id),
        custom_id  TEXT    NOT NULL,
        ord        INTEGER NOT NULL,
        source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
        claim_json TEXT    NOT NULL,
        model      TEXT    NOT NULL,
        prompt     TEXT    NOT NULL,
        batch_id   TEXT    NOT NULL,
        state      TEXT    NOT NULL CHECK (state IN ('new', 'valid', 'dropped', 'merged', 'accepted', 'queued')),
        reason     TEXT,
        similar_to TEXT,
        claim_id   TEXT,
        UNIQUE (job_id, custom_id, ord)
      );
      CREATE INDEX candidates_state ON candidates (state, id);
    `,
  },
  {
    version: 11,
    name: "evaluation arm C",
    rebuildsTables: true,
    sql: `
      -- Arm C (#42): claude -p with recall and brief, the claims layer. Same columns as v7; only
      -- the CHECK on arm changes.
      CREATE TABLE eval_results_v11 (
        run_id       INTEGER NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
        question_id  TEXT    NOT NULL,
        arm          TEXT    NOT NULL CHECK (arm IN ('A', 'B', 'C')),
        category     TEXT    NOT NULL,
        location     TEXT    NOT NULL CHECK (location IN ('cai', 'cc', 'both')),
        question     TEXT    NOT NULL,
        reference    TEXT    NOT NULL,
        answer       TEXT,
        verdict      TEXT    NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'error')),
        reason       TEXT,
        hit_at_8     INTEGER CHECK (hit_at_8 IN (0, 1)),
        searches     TEXT,
        hand_verdict TEXT    CHECK (hand_verdict IN ('correct', 'incorrect')),
        seconds      REAL,
        PRIMARY KEY (run_id, question_id, arm)
      );
      INSERT INTO eval_results_v11 SELECT * FROM eval_results;
      DROP TABLE eval_results;
      ALTER TABLE eval_results_v11 RENAME TO eval_results;
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
