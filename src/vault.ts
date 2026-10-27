// The vault (#34, SPEC.md "Data model"): a git repository of claim files and log.md, next to
// the database. Every claim write is one commit holding that file and log.md only, so the
// user's own edits in the same folder (Obsidian notes) are never swept into it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { type Claim, parseClaimFile, serializeClaim } from "./claims.js";

export const vaultDirFor = (dbPath: string) => join(dirname(dbPath), "vault");

export interface VaultEntry {
  claim: Claim;
  /** Relative to the vault: `claims/<year>/<id>.md`. */
  path: string;
  /** SHA-256 of the file's bytes. */
  sha: string;
}

export class Vault {
  private ready = false;

  constructor(readonly dir: string) {}

  private git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  /**
   * glia's own commits: an identity given per command, so they work with no global git
   * config and the user's own commits in the vault (obsidian-git) keep their author; and no
   * signing or hooks from the user's config, which could prompt or fail.
   */
  private commit(message: string, paths: string[]): void {
    this.git("-c", "user.name=glia", "-c", "user.email=glia@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message, "--", ...paths);
  }

  /** Creates the folder and its repository on first use. */
  private ensure(): void {
    if (this.ready) return;
    mkdirSync(join(this.dir, "claims"), { recursive: true, mode: 0o700 });
    if (!existsSync(join(this.dir, ".git"))) this.git("init", "-q", "-b", "main");
    this.ready = true;
  }

  /** Where a claim's file is: where it already is, else under the year of its recorded_at. */
  claimPath(c: Claim): string {
    const claims = join(this.dir, "claims");
    if (existsSync(claims)) {
      for (const year of readdirSync(claims).sort()) {
        const p = `claims/${year}/${c.id}.md`;
        if (existsSync(join(this.dir, p))) return p;
      }
    }
    return `claims/${c.recorded_at.slice(0, 4)}/${c.id}.md`;
  }

  /**
   * Writes the claim and commits it with log.md; returns the commit. An unchanged file makes no
   * commit. With `expectSha`, the file must still hold the bytes it was read from: a file the user
   * edited since (or left broken) is never overwritten.
   */
  writeClaim(c: Claim, message: string, opts: { expectSha?: string } = {}): string {
    this.ensure();
    const rel = this.claimPath(c);
    if (opts.expectSha !== undefined && !this.isUnchanged(c, opts.expectSha)) {
      throw new Error(`${rel} changed on disk since it was indexed; fix it or run: glia index --claims`);
    }
    mkdirSync(dirname(join(this.dir, rel)), { recursive: true });
    writeFileSync(join(this.dir, rel), serializeClaim(c));
    const paths = [rel, ...(existsSync(join(this.dir, "log.md")) ? ["log.md"] : [])];
    this.git("add", "--", ...paths);
    let staged = true;
    try {
      this.git("diff", "--cached", "--quiet", "--", ...paths);
      staged = false;
    } catch {
      // exit 1: there is something to commit
    }
    if (staged) this.commit(message, paths);
    return this.git("rev-parse", "HEAD");
  }

  /** Whether the claim's file still holds the bytes with this hash (or does not exist yet). */
  isUnchanged(c: Claim, sha: string | undefined): boolean {
    const path = join(this.dir, this.claimPath(c));
    return !existsSync(path) || createHash("sha256").update(readFileSync(path)).digest("hex") === sha;
  }

  /** Deletes a claim file without a commit (tests, hand cleanup); the next sync drops its row. */
  removeFile(rel: string): void {
    rmSync(join(this.dir, rel), { force: true });
  }

  /** Every claim file in path order; a file that does not parse is an error naming it. */
  readAll(): { entries: VaultEntry[]; errors: string[] } {
    const entries: VaultEntry[] = [];
    const errors: string[] = [];
    const claims = join(this.dir, "claims");
    if (!existsSync(claims)) return { entries, errors };
    for (const year of readdirSync(claims, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      for (const name of readdirSync(join(claims, year)).filter((n) => n.endsWith(".md")).sort()) {
        const path = `claims/${year}/${name}`;
        const bytes = readFileSync(join(this.dir, path));
        try {
          entries.push({ claim: parseClaimFile(bytes.toString("utf8"), path), path, sha: createHash("sha256").update(bytes).digest("hex") });
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    return { entries, errors };
  }

  appendLogLine(line: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(this.dir, "log.md"), `${line}\n`);
  }
}

export interface LogEntry {
  /** user, extractor, consolidator or mcp:<client> */
  actor: string;
  action: string;
  claim_id?: string;
  payload?: unknown;
}

/** Appends to the log table and to log.md; log.md is committed with the next claim write. */
export function appendLog(db: Database.Database, vault: Vault, e: LogEntry, now = new Date()): void {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const payload = e.payload === undefined ? null : JSON.stringify(e.payload);
  db.prepare("INSERT INTO log (ts, actor, action, claim_id, payload) VALUES (?, ?, ?, ?, ?)").run(ts, e.actor, e.action, e.claim_id ?? null, payload);
  vault.appendLogLine(`- ${[ts, e.actor, e.action, e.claim_id, payload].filter((p) => p != null).join(" · ")}`);
}
