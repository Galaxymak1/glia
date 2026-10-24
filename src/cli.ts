#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { defaultDbPath, openDb } from "./db.js";
import { type Config, embeddingSettings, isExcludedPath, loadConfig } from "./config.js";
import { OllamaEmbedder } from "./embed.js";
import { search } from "./search.js";
import { buildIndex, indexStatus } from "./vectors.js";
import { EvidenceStore, rawDirFor, scrubPath } from "./evidence.js";
import { isSessionFileName, looksLikeProjectFolder, projectsView, type RootShape } from "./parsers/claudeCode.js";
import { indexClaudeCodeFile } from "./sources.js";
import { ingestExportZip, mayBeExportFile } from "./claudeAiExport.js";
import { scrubText } from "./scrub.js";
import { migrate, schemaVersion } from "./migrations.js";
import { defaultTranscriptsDir, formatReport, isScannable, scanPaths, walk } from "./scan.js";

const USAGE = `Usage: brain <command> [options]

Commands:
  init                          Create the database, or apply pending migrations
  scrub --dry-run [path...]     Report the secrets scrubbing would remove (default: ~/.claude/projects)
  ingest <path...>              Scrub and store raw files, then parse Claude Code transcripts and
                                memory, and claude.ai export ZIPs, into sources and turns (idempotent)
  index [--rebuild]             Embed new and changed turns into the meaning index (Ollama); --rebuild
                                deletes the index and embeds everything again
  search <query...>             Hybrid keyword + meaning search over turns

Options:
  --db <path>   Database file (default: $BRAIN_DB, else ~/.local/share/ai_second_brain/brain.db)
  --show        With scrub: list each finding with its file, line and a masked preview
  --limit <n>   With search: number of results (default 10)
  --injected    With search: include text the harness injected (reminders, hook context)
  --json        With search: print the results as JSON

Config: $BRAIN_CONFIG, else ~/.config/ai_second_brain/config.json
  {"claudeCode": {"exclude": ["-home-me-work-*"]}}   project folders never stored or parsed
  {"embedding": {"url": "http://localhost:11434", "model": "hf.co/gpustack/bge-m3-GGUF:Q8_0"}}
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
    const exportTotals = { zips: 0, turnsWritten: 0, turnsRemoved: 0 };
    const exportSources: Record<string, Record<string, number>> = {};
    const notIngested: Record<string, number> = {};
    const fail = (message: string) => {
      failed++;
      console.error(`brain: ${message}`);
    };
    // fs messages quote the raw path; report the scrubbed path and the error code instead.
    const fsError = (p: string, err: unknown) => `${scrubPath(p)}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`;
    for (const root of paths.map((p) => resolve(p))) {
      // Exclusion and parsing read each file's place under projects/, whatever the root is called.
      let view: (path: string) => string;
      try {
        const real = realpathSync(root);
        const shape: RootShape = statSync(real).isDirectory()
          ? looksLikeProjectFolder(readdirSync(real)) ? "project-folder" : "projects-folder"
          : isSessionFileName(basename(real)) ? "session-file" : "projects-folder";
        view = projectsView(root, real, shape);
      } catch (err) {
        fail(fsError(root, err));
        continue;
      }
      for (const path of walk(root, (p, err) => fail(fsError(p, err)))) {
        // Nothing from an excluded project reaches the store, whatever the file (an export ZIP
        // included): checked on every folder from the root down, and on the projects/ view,
        // which names the project.
        if (isExcludedPath(relative(root, path), config) || isExcludedPath(view(path), config)) {
          excluded++;
          continue;
        }
        if (path.endsWith(".zip")) {
          let data: Buffer;
          try {
            // An archive that cannot be an export is never loaded (it may be huge, or damaged).
            if (mayBeExportFile(path) === false) {
              skipped++;
              continue;
            }
            data = readFileSync(path);
          } catch (err) {
            fail(fsError(path, err));
            continue;
          }
          try {
            const x = ingestExportZip(db, store, path, data, new Date(), statSync(path).mtime);
            for (const message of x.errors) fail(scrubText(message).value); // each names its ZIP entry
            if (!x.isExport) {
              skipped++;
              continue;
            }
            exportTotals.zips++;
            created += x.entries.created;
            repaired += x.entries.repaired;
            unchanged += x.entries.unchanged;
            bytes += x.entries.bytes;
            storedBytes += x.entries.storedBytes;
            redactions += x.entries.redactions;
            exportTotals.turnsWritten += x.turnsWritten;
            exportTotals.turnsRemoved += x.turnsRemoved;
            for (const [kind, byStatus] of Object.entries(x.sources)) {
              const into = (exportSources[kind] ??= {});
              for (const [status, n] of Object.entries(byStatus)) into[status] = (into[status] ?? 0) + (n ?? 0);
            }
            for (const [category, n] of Object.entries(x.notIngested)) notIngested[category] = (notIngested[category] ?? 0) + n;
          } catch (err) {
            fail(`${scrubPath(path)}: ${scrubText(err instanceof Error ? err.message : String(err)).value}`);
          }
          continue;
        }
        if (!isScannable(path)) {
          skipped++;
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

          const ix = indexClaudeCodeFile(db, store, r.file, config, view(path));
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
    if (exportTotals.zips) {
      const kinds: Record<string, string> = { cai: "conversations", cap: "projects", mem: "memory sets", cad: "design chats", caa: "artifacts" };
      const parts = Object.entries(exportSources).map(
        ([kind, byStatus]) => `${kinds[kind] ?? kind} ${Object.entries(byStatus).map(([status, n]) => `${n} ${status}`).join("/")}`,
      );
      const left = Object.entries(notIngested).map(([category, n]) => `${category} ${n}`);
      console.log(
        `claude.ai export (${exportTotals.zips} ZIPs): ${parts.join(", ") || "nothing parsed"} ` +
          `(${exportTotals.turnsWritten} turns written, ${exportTotals.turnsRemoved} removed)` +
          (left.length ? `; entries not ingested: ${left.join(", ")}` : ""),
      );
    }
    const types = Object.entries(skippedTypes).sort((a, b) => b[1] - a[1]);
    if (types.length) console.log(`Skipped non-turn lines: ${types.map(([t, n]) => `${t} ${n}`).join(", ")}`);
    return failed ? 1 : 0;
  } finally {
    db.close();
  }
}

async function index(dbPath: string, config: Config, rebuild: boolean): Promise<number> {
  const db = openDb(dbPath);
  try {
    migrate(db);
    const { url, model } = embeddingSettings(config);
    const embedder = new OllamaEmbedder(model, url);
    const started = Date.now();
    let last = 0;
    const report = await buildIndex(db, embedder, {
      rebuild,
      onProgress: (done, total) => {
        if (Date.now() - last < 10_000 && done < total) return;
        last = Date.now();
        const secs = (Date.now() - started) / 1000;
        const eta = done ? Math.round(((total - done) * secs) / done / 60) : 0;
        console.error(`brain: embedded ${done}/${total} chunks (${Math.round(embedder.tokens / secs)} tokens/s, about ${eta} min left)`);
      },
    });
    const secs = (Date.now() - started) / 1000;
    console.log(
      `Embedded ${report.chunksEmbedded} chunks of ${report.turnsEmbedded} turns with ${model} ` +
        `(${embedder.tokens} tokens, ${secs.toFixed(0)} s); ${report.turnsUnchanged} turns up to date; ` +
        `${report.turnsCleared} cleared; ${report.turns} turns in all`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function searchCommand(dbPath: string, config: Config, query: string, limit: number, includeInjected: boolean, json: boolean): Promise<number> {
  const db = openDb(dbPath);
  try {
    migrate(db);
    const { url, model } = embeddingSettings(config);
    const result = await search(db, new OllamaEmbedder(model, url, 120_000), query, { limit, includeInjected });
    if (result.meaningError) console.error(`brain: meaning search unavailable (${result.meaningError}); keyword results only`);
    const status = indexStatus(db, model);
    if (status.missing) console.error(`brain: ${status.missing} turns are not in the meaning index yet; run: brain index`);
    if (status.otherModel) console.error(`brain: ${status.otherModel} chunks were embedded with another model and are ignored; run: brain index`);
    if (json) {
      console.log(JSON.stringify(result.hits, null, 2));
      return 0;
    }
    if (!result.hits.length) console.log("No results.");
    result.hits.forEach((h, i) => {
      const ranks = [h.keywordRank && `keyword #${h.keywordRank}`, h.meaningRank && `meaning #${h.meaningRank}`].filter(Boolean).join(", ");
      const when = h.ts ? ` · ${h.ts.slice(0, 16).replace("T", " ")}` : "";
      console.log(`${i + 1}. [${h.kind}] ${h.sourceTitle ?? "(untitled)"}${when} · ${h.role}${h.isInjected ? " (injected)" : ""} · turn ${h.turnId} · ${ranks}`);
      console.log(`   ${h.snippet}`);
    });
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      "dry-run": { type: "boolean" },
      show: { type: "boolean" },
      rebuild: { type: "boolean" },
      limit: { type: "string" },
      injected: { type: "boolean" },
      json: { type: "boolean" },
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
    case "index":
      return index(values.db ?? defaultDbPath(), loadConfig(), values.rebuild ?? false);
    case "search": {
      const limit = Number(values.limit ?? 10);
      if (!args.length || !Number.isInteger(limit) || limit < 1) {
        console.error(`brain search needs a query, and --limit a positive whole number.\n\n${USAGE}`);
        return 1;
      }
      return searchCommand(values.db ?? defaultDbPath(), loadConfig(), args.join(" "), limit, values.injected ?? false, values.json ?? false);
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`brain: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
