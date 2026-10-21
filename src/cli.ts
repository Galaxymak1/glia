#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultDbPath, openDb } from "./db.js";
import { migrate, schemaVersion } from "./migrations.js";

const USAGE = `Usage: brain <command> [options]

Commands:
  init      Create the database, or apply pending migrations

Options:
  --db <path>   Database file (default: $BRAIN_DB, else ~/.local/share/ai_second_brain/brain.db)
  -h, --help    Show this help`;

function init(dbPath: string): void {
  const existed = existsSync(dbPath);
  const db = openDb(dbPath);
  try {
    const applied = migrate(db);
    const version = schemaVersion(db);
    if (!existed) console.log(`Created ${dbPath} (schema v${version})`);
    else if (applied.length) console.log(`Migrated ${dbPath} to schema v${version} (applied ${applied.join(", ")})`);
    else console.log(`${dbPath} is up to date (schema v${version})`);
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
      help: { type: "boolean", short: "h" },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  switch (command) {
    case "init":
      init(values.db ?? defaultDbPath());
      return 0;
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
