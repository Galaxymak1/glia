#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { defaultDbPath, openDb } from "./db.js";
import { type Config, isExcludedProject, loadConfig } from "./config.js";
import { EvidenceStore, rawDirFor, scrubPath } from "./evidence.js";
import { classifyClaudeCodePath } from "./parsers/claudeCode.js";
import { indexClaudeCodeFile } from "./sources.js";
import { migrate, schemaVersion } from "./migrations.js";
import { defaultTranscriptsDir, formatReport, isScannable, scanPaths, walk } from "./scan.js";

const USAGE = `Usage: brain <command> [options]

Commands:
  init                          Create the database, or apply pending migrations
  scrub --dry-run [path...]     Report the secrets scrubbing would remove (default: ~/.claude/projects)
  ingest <path...>              Scrub and store raw files, then parse Claude Code transcripts and
                                memory into sources and turns (idempotent)

Options:
  --db <path>   Database file (default: $BRAIN_DB, else ~/.local/share/ai_second_brain/brain.db)
  --show        With scrub: list each finding with its file, line and a masked preview

Config: $BRAIN_CONFIG, else ~/.config/ai_second_brain/config.json
  {"claudeCode": {"exclude": ["-home-me-work-*"]}}   project folders never stored or parsed
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

function ingest(dbPath: string, paths: string[], config: Config): number {
  const db = openDb(dbPath);
  try {
    migrate(db);
    const store = new EvidenceStore(db, rawDirFor(dbPath));
    let created = 0, repaired = 0, unchanged = 0, skipped = 0, excluded = 0, failed = 0, bytes = 0, storedBytes = 0, redactions = 0;
    const parsed = { session: 0, subagent: 0, memory: 0 };
    let parsedUnchanged = 0, turnsWritten = 0, turnsRemoved = 0, malformed = 0;
    const skippedTypes: Record<string, number> = {};
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
        // Excluded projects never reach the store.
        const cc = classifyClaudeCodePath(path);
        if (cc && isExcludedProject(cc.projectDir, config)) {
          excluded++;
          continue;
        }
        let data: Buffer;
        try {
          data = readFileSync(path);
        } catch (err) {
          fail(fsError(path, err));
          continue;
        }
        try {
          const r = store.put(path, data);
          if (r.created) {
            created++;
            bytes += r.file.bytes;
            storedBytes += r.file.stored_bytes;
            redactions += r.file.redactions;
          } else if (r.repaired) repaired++;
          else unchanged++;

          const ix = indexClaudeCodeFile(db, store, r.file, config);
          if (!ix) continue;
          if (ix.status === "new" || ix.status === "updated") {
            parsed[ix.kind]++;
            turnsWritten += ix.turnsWritten;
            turnsRemoved += ix.turnsRemoved;
            malformed += ix.stats?.malformed ?? 0;
            for (const [type, n] of Object.entries(ix.stats?.skippedTypes ?? {})) skippedTypes[type] = (skippedTypes[type] ?? 0) + n;
          } else parsedUnchanged++;
        } catch (err) {
          fail(`${scrubPath(path)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const mb = (n: number) => (n / 1e6).toFixed(1);
    console.log(
      `Stored ${created} new files (${mb(bytes)} MB, ${mb(storedBytes)} MB compressed, ${redactions} secrets redacted); ` +
        `${unchanged} unchanged; ` +
        (repaired ? `${repaired} repaired; ` : "") +
        `skipped ${skipped} non-text files` +
        (excluded ? `; ${excluded} in excluded projects` : "") +
        (failed ? `; ${failed} failed` : ""),
    );
    console.log(
      `Parsed ${parsed.session} sessions, ${parsed.subagent} subagent transcripts, ${parsed.memory} memory files ` +
        `(${turnsWritten} turns written, ${turnsRemoved} removed); ${parsedUnchanged} already up to date; ${malformed} malformed lines`,
    );
    const types = Object.entries(skippedTypes).sort((a, b) => b[1] - a[1]);
    if (types.length) console.log(`Skipped non-turn lines: ${types.map(([t, n]) => `${t} ${n}`).join(", ")}`);
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
      return ingest(values.db ?? defaultDbPath(), args, loadConfig());
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
