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

  /** Creates the folder and its repository on first use, with an identity of its own. */
  private ensure(): void {
    if (this.ready) return;
    mkdirSync(join(this.dir, "claims"), { recursive: true, mode: 0o700 });
    if (!existsSync(join(this.dir, ".git"))) this.git("init", "-q", "-b", "main");
    // Local identity: commits work on a machine with no global git config.
    this.git("config", "user.name", "brain");
    this.git("config", "user.email", "brain@localhost");
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

  /** Writes the claim and commits it with log.md; returns the commit. An unchanged file makes no commit. */
  writeClaim(c: Claim, message: string): string {
    this.ensure();
    const rel = this.claimPath(c);
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
    if (staged) this.git("commit", "-q", "-m", message, "--", ...paths);
    return this.git("rev-parse", "HEAD");
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
