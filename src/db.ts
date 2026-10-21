import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/** `$BRAIN_DB`, else `$XDG_DATA_HOME/ai_second_brain/brain.db` (XDG default `~/.local/share`). */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BRAIN_DB) return env.BRAIN_DB;
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "ai_second_brain", "brain.db");
}

export function openDb(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma("busy_timeout = 5000");
  enableWal(db);
  db.pragma("foreign_keys = ON");
  return db;
}

// Switching a fresh file to WAL can fail with SQLITE_BUSY without consulting
// busy_timeout when another connection is opening it too, so retry it here.
function enableWal(db: Database.Database, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      const busy = err instanceof Database.SqliteError && err.code.startsWith("SQLITE_BUSY");
      if (!busy || Date.now() > deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
