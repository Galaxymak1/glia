// The claim index (#34): the claim tables mirror the vault's files and are rebuilt from them.
// `brain index --claims` and every stage that reads claims run syncClaims first, so an edit made
// in Obsidian counts on the next run. A file that does not parse keeps its last good row.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { type Claim, ClaimSchema } from "./claims.js";
import type { Embedder } from "./embed.js";
import { EMBEDDING_DIMS } from "./migrations.js";
import type { Vault } from "./vault.js";

const JSON_COLUMNS = ["evidence", "extractor", "supersedes", "options", "expected_outcome"] as const;
const COLUMNS = [
  "id", "kind", "scope", "statement", "statement_lang", "origin", "evidence", "extractor", "confidence", "valid_from",
  "valid_from_precision", "valid_to", "recorded_at", "supersedes", "superseded_by", "status", "review", "reviewed_at",
  "sensitivity", "options", "rationale", "expected_outcome", "revisit_on",
] as const;
/** Fields that are left out of a claim, not set to null, when they are empty. */
const OPTIONAL = new Set(["options", "rationale", "expected_outcome", "revisit_on"]);
const EMBED_BATCH = 32;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function toRow(c: Claim, path: string, sha: string): Record<string, unknown> {
  const row: Record<string, unknown> = { file_path: path, file_sha: sha };
  const known = new Set<string>(COLUMNS);
  for (const col of COLUMNS) {
    const v = (c as Record<string, unknown>)[col];
    row[col] = v === undefined ? null : (JSON_COLUMNS as readonly string[]).includes(col) && v !== null ? JSON.stringify(v) : v;
  }
  const extra = Object.fromEntries(Object.entries(c).filter(([k]) => !known.has(k)));
  row.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
  return row;
}

/** The claim a row mirrors, as its file holds it. */
export function claimFromRow(row: Record<string, unknown>): Claim {
  const c: Record<string, unknown> = {};
  for (const col of COLUMNS) {
    let v = row[col];
    if ((JSON_COLUMNS as readonly string[]).includes(col) && typeof v === "string") v = JSON.parse(v);
    if (v === null && OPTIONAL.has(col)) continue;
    c[col] = v;
  }
  if (typeof row.extra === "string") Object.assign(c, JSON.parse(row.extra));
  return ClaimSchema.parse(c);
}

export function claimRow(db: Database.Database, id: string): Claim | null {
  const row = db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? claimFromRow(row) : null;
}

export interface SyncReport {
  inserted: number;
  updated: number;
  removed: number;
  embedded: number;
  errors: string[];
  /** Set when the embedder failed: rows are up to date, some vectors are not. */
  embedError?: string;
}

/** Brings the claim tables in line with the vault, then embeds statements whose vector is missing or stale. */
export async function syncClaims(db: Database.Database, vault: Vault, embedder: Embedder | null): Promise<SyncReport> {
  const { entries, errors } = vault.readAll();
  const report: SyncReport = { inserted: 0, updated: 0, removed: 0, embedded: 0, errors };
  // A broken file keeps its claim's last good row: the claim is not lost while it is being fixed.
  const brokenPaths = new Set(errors.map((e) => e.slice(0, e.indexOf(": "))));
  const existing = new Map(
    (db.prepare("SELECT id, file_path, file_sha FROM claims").all() as { id: string; file_path: string; file_sha: string }[]).map((r) => [r.id, r]),
  );
  const cols = [...COLUMNS, "extra", "file_path", "file_sha"];
  const insert = db.prepare(`INSERT INTO claims (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`);
  const update = db.prepare(`UPDATE claims SET ${cols.filter((c) => c !== "id").map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`);
  const seen = new Set<string>();

  db.transaction(() => {
    for (const e of [...entries].sort((a, b) => a.claim.id.localeCompare(b.claim.id))) {
      if (seen.has(e.claim.id)) {
        report.errors.push(`${e.path}: id ${e.claim.id} is already used by another file`);
        continue;
      }
      seen.add(e.claim.id);
      const old = existing.get(e.claim.id);
      if (old && old.file_sha === e.sha && old.file_path === e.path) continue;
      if (old) {
        update.run(toRow(e.claim, e.path, e.sha));
        report.updated++;
      } else {
        insert.run(toRow(e.claim, e.path, e.sha));
        report.inserted++;
      }
    }
    for (const [id, row] of existing) {
      if (seen.has(id) || brokenPaths.has(row.file_path)) continue;
      db.prepare("DELETE FROM claims WHERE id = ?").run(id);
      report.removed++;
    }
    // Supersession edges are derived from the files; other edge types come from review (Phase 3).
    db.exec("DELETE FROM edges WHERE type = 'supersedes'");
    const edge = db.prepare("INSERT OR IGNORE INTO edges (src, dst, type, valid_from, valid_to) VALUES (?, ?, 'supersedes', ?, NULL)");
    for (const r of db.prepare("SELECT id, supersedes, valid_from FROM claims ORDER BY id").all() as { id: string; supersedes: string; valid_from: string | null }[]) {
      for (const dst of JSON.parse(r.supersedes) as string[]) edge.run(r.id, dst, r.valid_from);
    }
  })();

  if (!embedder) return report;
  // input_sha256 is the hash of the statement embedded; SQLite has no sha256, so compare here.
  const vecSha = new Map(
    (db.prepare("SELECT claim_n, input_sha256, model FROM claims_vec").all() as { claim_n: number; input_sha256: string; model: string }[]).map((r) => [r.claim_n, r]),
  );
  const todo = (db.prepare("SELECT n, statement FROM claims ORDER BY n").all() as { n: number; statement: string }[]).filter((r) => {
    const v = vecSha.get(r.n);
    return !v || v.model !== embedder.model || v.input_sha256 !== sha256(r.statement);
  });
  const del = db.prepare("DELETE FROM claims_vec WHERE claim_n = ?");
  const put = db.prepare("INSERT INTO claims_vec (claim_n, embedding, model, dims, input_sha256) VALUES (?, ?, ?, ?, ?)");
  try {
    for (let i = 0; i < todo.length; i += EMBED_BATCH) {
      const batch = todo.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(batch.map((r) => r.statement));
      db.transaction(() => {
        batch.forEach((r, j) => {
          del.run(BigInt(r.n));
          put.run(BigInt(r.n), vectors[j]!, embedder.model, BigInt(EMBEDDING_DIMS), sha256(r.statement));
        });
      })();
      report.embedded += batch.length;
    }
  } catch (err) {
    report.embedError = err instanceof Error ? err.message : String(err);
  }
  return report;
}
