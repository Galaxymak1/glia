#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { defaultDbPath, openDb } from "./db.js";
import { EvidenceStore, rawDirFor, scrubPath } from "./evidence.js";
import { migrate, schemaVersion } from "./migrations.js";
import { defaultTranscriptsDir, formatReport, isScannable, scanPaths, walk } from "./scan.js";

const USAGE = `Usage: brain <command> [options]

Commands:
  init                          Create the database, or apply pending migrations
  scrub --dry-run [path...]     Report the secrets scrubbing would remove (default: ~/.claude/projects)
  ingest <path...>              Scrub and store raw files in the evidence store (idempotent)

Options:
  --db <path>   Database file (default: $BRAIN_DB, else ~/.local/share/ai_second_brain/brain.db)
  --show        With scrub: list each finding with its file, line and a masked preview
  -h, --help    Show this help`;

function init(dbPath: string): void {
  const db = openDb(dbPath);
  try {
    const applied = migrate(db);
    const version = schemaVersion(db);
    // Decided from what this run applied, so two racing inits never both say "Created".
    if (applied[0] === 1) console.log(`Created ${dbPath} (schema v${version})`);
    else if (applied.length) console.log(`Migrated ${dbPath} to schema v${version} (applied ${applied.join(", ")})`);
    else console.log(`${dbPath} is up to date (schema v${version})`);
  } finally {
    db.close();
  }
}

function ingest(dbPath: string, paths: string[]): number {
  const db = openDb(dbPath);
  try {
    migrate(db);
    const store = new EvidenceStore(db, rawDirFor(dbPath));
    let created = 0, repaired = 0, unchanged = 0, skipped = 0, failed = 0, bytes = 0, storedBytes = 0, redactions = 0;
    const fail = (message: string) => {
      failed++;
      console.error(`brain: ${message}`);
    };
    for (const root of paths) {
      // fs messages quote the raw path; report the scrubbed path and the error code instead.
      const fsError = (p: string, err: unknown) => `${scrubPath(p)}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`;
      for (const path of walk(root, (p, err) => fail(fsError(p, err)))) {
        if (!isScannable(path)) {
          skipped++;
          continue;
        }
        try {
          let data: Buffer;
          try {
            data = readFileSync(path);
          } catch (err) {
            fail(fsError(path, err));
            continue;
          }
          const r = store.put(path, data);
          if (r.repaired) repaired++;
          if (!r.created) {
            if (!r.repaired) unchanged++;
            continue;
          }
          created++;
          bytes += r.file.bytes;
          storedBytes += r.file.stored_bytes;
          redactions += r.file.redactions;
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      }
    }
    const mb = (n: number) => (n / 1e6).toFixed(1);
    console.log(
      `Stored ${created} new files (${mb(bytes)} MB, ${mb(storedBytes)} MB compressed, ${redactions} secrets redacted); ` +
        `${unchanged} unchanged; ` +
        (repaired ? `${repaired} repaired; ` : "") +
        `skipped ${skipped} non-text files` +
        (failed ? `; ${failed} failed` : ""),
    );
    return failed ? 1 : 0;
  } finally {
    db.close();
  }
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      "dry-run": { type: "boolean" },
      show: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!command) {
    console.error(USAGE);
    return 1;
  }
  switch (command) {
    case "init":
      init(values.db ?? defaultDbPath());
      return 0;
    case "scrub":
      if (!values["dry-run"]) {
        console.error("brain scrub needs --dry-run: scrubbed copies are written by ingest once the evidence store (#2) lands.");
        return 1;
      }
      console.log(formatReport(scanPaths(args.length ? args : [defaultTranscriptsDir()]), values.show ?? false));
      return 0;
    case "ingest":
      if (!args.length) {
        console.error(`brain ingest needs at least one path.\n\n${USAGE}`);
        return 1;
      }
      return ingest(values.db ?? defaultDbPath(), args);
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`brain: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
