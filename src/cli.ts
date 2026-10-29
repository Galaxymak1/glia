#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { defaultDbPath, openDb } from "./db.js";
import { anthropicApiKey, type Config, defaultConfigPath, embeddingSettings, isExcludedPath, loadConfig } from "./config.js";
import { search } from "./search.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp.js";
import { evalReport, formatEvalReport, parseArmA, readQuestionsFile, runEval, type ToolArm, verifyVerdict } from "./eval.js";
import { buildIndex, indexStatus } from "./vectors.js";
import { EvidenceStore, rawDirFor, scrubPath } from "./evidence.js";
import { pruneSuperseded, removeStaleTmp } from "./prune.js";
import { isOptedOut, OPT_OUT_MARKER, OptOutCheck, optOut, sessionOf } from "./optOut.js";
import { isSessionFileName, looksLikeProjectFolder, projectsView, type RootShape } from "./parsers/claudeCode.js";
import { applyExclusions, indexClaudeCodeFile } from "./sources.js";
import { gitRemoteOf } from "./projects.js";
import { ingestExportZip, mayBeExportFile } from "./claudeAiExport.js";
import { scrubText } from "./scrub.js";
import { migrate, schemaVersion } from "./migrations.js";
import { syncClaims } from "./claimIndex.js";
import { anthropicBatchClient, planExtraction, pollExtraction, submitExtraction } from "./extractor.js";
import { formatValidation, validateCandidates } from "./validate.js";
import { dedupCandidates } from "./dedup.js";
import { expireProposals, rerouteProposals, routeCandidates } from "./route.js";
import { reviewStats, runReview, type ReviewIo } from "./review.js";
import { auditReport, formatAudit, sampleAudit } from "./audit.js";
import { createInterface, emitKeypressEvents } from "node:readline";
import { Vault, vaultDirFor } from "./vault.js";
import { moveLegacyPaths } from "./legacy.js";
import { sessionStartHook } from "./hooks.js";
import { createEmbedder, LazyEmbedder } from "./embedLlama.js";
import { checks, runInit } from "./init.js";
import { initTerminalIo, realInitEnv } from "./initEnv.js";
import { acquireLock, daemonLogger, localJobs, runOnce } from "./daemon.js";
import { startScheduler } from "./scheduler.js";
import { installService, type Platform, serviceActive, type ServiceDeps, uninstallService } from "./service.js";
import { defaultTranscriptsDir, formatReport, isScannable, scanPaths, walk } from "./scan.js";

const USAGE = `Usage: glia <command> [options]

Commands:
  init [--yes] [--dry-run] [--exclude <pattern>]... [--no-service]
                                Set glia up: database, embeddings, config, MCP clients, daemon, first ingest;
                                safe to run again. --db-only just creates or migrates the database
  doctor                        Check the setup and print the fix for whatever is broken
  scrub --dry-run [path...]     Report the secrets scrubbing would remove (default: ~/.claude/projects)
  ingest <path...>              Scrub and store raw files, then parse Claude Code transcripts and
                                memory, and claude.ai export ZIPs, into sources and turns (idempotent).
                                A session with a line holding only #nobrain, typed by the user, is
                                never stored, nor its folder; earlier copies are purged. Older
                                copies of a transcript that a newer copy holds in full are pruned
  index [--rebuild]             Embed new and changed turns into the meaning index (Ollama); --rebuild
                                deletes the index and embeds everything again
  index --claims                Mirror the claim files of the vault into the claim tables and embed
                                their statements; a file that does not parse is reported and skipped
  extract [--from <date>]       Send every source whose turns changed since the last run to Claude Haiku 5.5
                                (Batch API) for claim extraction; --dry-run reports the size and cost only.
                                The key is read from ~/.config/glia/env (ANTHROPIC_API_KEY)
  extract poll [--wait]         Read finished batches into candidate claims; --wait polls every minute
                                until no batch is running
  review [--audit]              Triage the review inbox one key at a time: a accept, e edit, m merge,
                                r reject, s snooze 7 days, o open the evidence, q quit; --audit shows
                                the claims picked for audit only
  review --stats                Weekly rejection rate and median decision time
  audit sample [--n 50]         Open audit items for auto-accepted claims never audited, for the
                                write-precision audit; triage them with glia review --audit
  audit report                  Write precision of the audit, AI-origin claims auto-accepted, the gate
  search <query...>             Hybrid keyword + meaning search over turns
  daemon [--once]               Run the local jobs (sweep, index, extraction) on their own clock;
                                --once runs every due job once and exits
  daemon install | uninstall | status
                                Start the daemon at login (systemd, launchd or a Windows task)
  hook session-start            For Claude Code's SessionStart hook: reads the hook JSON on stdin,
                                prints the briefing for the project it opens in
  mcp                           Serve search_evidence and open_evidence to an MCP client over stdio
  eval run [--arms B,C]         Answer every evaluation question with claude -p: arm B with the evidence
                                tools (raw search), arm C with the claim tools (recall and brief); judge
                                every arm and arm A against the references, store the run
  eval report [run]             Scores per category, retrieval hit@8 and the gate (latest run by
                                default); --details lists every answer and verdict
  eval verify <run> <q> <A|B|C> <correct|incorrect>
                                Record a verdict checked by hand; it overrides Claude's

Options:
  --db <path>   Database file (default: $GLIA_DB, else ~/.local/share/glia/glia.db)
  --show        With scrub: list each finding with its file, line and a masked preview
  --limit <n>   With search: number of results (default 10)
  --injected    With search: include text the harness injected (reminders, hook context)
  --json        With search: print the results as JSON
  --questions <path>   With eval run: the question set (default: eval/questions.jsonl next to the database)
  --arm-a <path>       With eval run: arm A answers (default: eval/arm-a.jsonl next to the database)
  --model <name>       With eval run: arm B model (default sonnet); --judge-model <name> (default sonnet)
  --only <ids>         With eval run: only these question ids, comma-separated
  --arms <list>        With eval run: the tool arms to run (default B,C)

Config: $GLIA_CONFIG, else ~/.config/glia/config.json
  {"claudeCode": {"exclude": ["-home-me-work-*"]}}   project folders never stored or parsed
  {"embedding": {"url": "http://localhost:11434", "model": "hf.co/gpustack/bge-m3-GGUF:Q8_0"}}
  -h, --help    Show this help
  -v, --version Print the version`;

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
    let created = 0, repaired = 0, unchanged = 0, skipped = 0, symlinks = 0, excluded = 0, failed = 0, bytes = 0, storedBytes = 0, redactions = 0;
    const parsed = { session: 0, subagent: 0, memory: 0 };
    const staleTmp = removeStaleTmp(rawDirFor(dbPath));
    let superseded = 0;
    const optOutCheck = new OptOutCheck(db);
    const optedOut = new Set<string>();
    const purged = { sources: 0, rawFiles: 0 };
    let optedOutFiles = 0;
    let parsedUnchanged = 0, turnsWritten = 0, turnsRemoved = 0, malformed = 0;
    const skippedTypes: Record<string, number> = {};
    const exportTotals = { zips: 0, turnsWritten: 0, turnsRemoved: 0 };
    const exportSources: Record<string, Record<string, number>> = {};
    const notIngested: Record<string, number> = {};
    const fail = (message: string) => {
      failed++;
      console.error(`glia: ${message}`);
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
      for (const path of walk(root, (p, err) => fail(fsError(p, err)), () => symlinks++)) {
        // Nothing from an excluded project reaches the store, whatever the file (an export ZIP
        // included): checked on every folder from the root down, and on the projects/ view,
        // which names the project.
        if (isExcludedPath(relative(root, path), config) || isExcludedPath(view(path), config)) {
          excluded++;
          continue;
        }
        // A session the user opted out of (#nobrain) is not stored, nor its folder; what was
        // stored before the marker was typed is purged once.
        const ses = sessionOf(view(path)) ?? sessionOf(path);
        if (ses && optOutCheck.isOptedOut(ses.sessionId, path)) {
          if (!optedOut.has(ses.sessionId) && !isOptedOut(db, ses.sessionId)) {
            const p = optOut(db, rawDirFor(dbPath), ses.sessionId);
            purged.sources += p.sources;
            purged.rawFiles += p.rawFiles;
          }
          optedOut.add(ses.sessionId);
          optedOutFiles++;
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
          // A copy pruned as superseded: a newer one was parsed already.
          if (r.pruned) {
            superseded++;
            continue;
          }
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
    const prune = pruneSuperseded(db, store);
    // Projects excluded since their sessions were stored: hidden from search, MCP and extraction.
    const exclusions = applyExclusions(db, config);
    const mb = (n: number) => (n / 1e6).toFixed(1);
    console.log(
      `Stored ${created} new files (${mb(bytes)} MB, ${mb(storedBytes)} MB compressed, ${redactions} secrets redacted); ` +
        `${unchanged} unchanged; ` +
        (repaired ? `${repaired} repaired; ` : "") +
        `skipped ${skipped} non-text files` +
        (symlinks ? ` and ${symlinks} symlinks` : "") +
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
    if (exclusions.excluded || exclusions.restored) {
      console.log(`Exclusions changed: ${exclusions.excluded} sources now in excluded projects are hidden; ${exclusions.restored} shown again`);
    }
    if (optedOut.size) {
      console.log(
        `${optedOut.size} sessions opted out (${OPT_OUT_MARKER}): ${optedOutFiles} files not stored` +
          (purged.sources || purged.rawFiles ? `; purged ${purged.sources} sources and ${purged.rawFiles} raw files stored earlier` : ""),
      );
    }
    if (prune.pruned || prune.kept || superseded || staleTmp) {
      console.log(
        `Pruned ${prune.pruned} superseded transcript copies (${mb(prune.bytesFreed)} MB compressed)` +
          (prune.kept ? `; kept ${prune.kept} older copies the current one does not hold in full` : "") +
          (superseded ? `; ${superseded} already-pruned copies met again` : "") +
          (staleTmp ? `; removed ${staleTmp} stale temp files` : ""),
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
    const embedder = await createEmbedder(config, dirname(dbPath));
    const started = Date.now();
    let last = 0;
    const report = await buildIndex(db, embedder, {
      rebuild,
      onProgress: (done, total) => {
        if (Date.now() - last < 10_000 && done < total) return;
        last = Date.now();
        const secs = (Date.now() - started) / 1000;
        const eta = done ? Math.round(((total - done) * secs) / done / 60) : 0;
        console.error(`glia: embedded ${done}/${total} chunks (${Math.round((embedder.tokens ?? 0) / secs)} tokens/s, about ${eta} min left)`);
      },
    });
    const secs = (Date.now() - started) / 1000;
    console.log(
      `Embedded ${report.chunksEmbedded} chunks of ${report.turnsEmbedded} turns with ${embedder.model} ` +
        `(${embedder.tokens ?? 0} tokens, ${secs.toFixed(0)} s); ${report.turnsUnchanged} turns up to date; ` +
        `${report.turnsCleared} cleared; ${report.turns} turns in all`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function indexClaims(dbPath: string, config: Config): Promise<number> {
  const db = openDb(dbPath);
  try {
    migrate(db);
    const r = await syncClaims(db, new Vault(vaultDirFor(dbPath)), await createEmbedder(config, dirname(dbPath)));
    console.log(`Claims: ${r.inserted} new, ${r.updated} updated, ${r.removed} removed, ${r.embedded} embedded`);
    for (const e of r.errors) console.error(`glia: ${scrubText(e).value}`);
    if (r.embedError) console.error(`glia: meaning index of claims not updated (${r.embedError}); keyword search still finds them`);
    return r.errors.length ? 1 : 0;
  } finally {
    db.close();
  }
}

/** Characters per token measured on these sources by #32; Haiku 5.5 input at $0.10 per MTok, halved in a batch. */
const CHARS_PER_TOKEN = 2.25;
const BATCH_INPUT_PER_MTOK = 0.05;
const POLL_MS = 60_000;

async function extract(dbPath: string, args: string[], values: { from?: string; "dry-run"?: boolean; wait?: boolean }, config: Config): Promise<number> {
  const db = openDb(dbPath);
  try {
    migrate(db);
    if (args[0] === "poll") {
      const client = anthropicBatchClient(anthropicApiKey());
      for (;;) {
        const r = await pollExtraction(db, client);
        console.log(
          `Batches: ${r.ended} ended, ${r.running} in progress; ${r.candidates} candidates, ${r.failedRequests} failed requests` +
            (r.ended ? ` (${r.inputTokens} input, ${r.outputTokens} output tokens)` : ""),
        );
        const v = validateCandidates(db);
        if (v.checked) console.log(formatValidation(v));
        const vault = new Vault(vaultDirFor(dbPath));
        const d = await dedupCandidates(db, vault, await createEmbedder(config, dirname(dbPath)));
        for (const e of d.syncErrors) console.error(`glia: ${scrubText(e).value}`);
        if (d.held) console.error(`glia: meaning index unavailable; ${d.held} candidates held until it is back (run: glia extract poll)`);
        if (d.previouslyRejected) console.log(`${d.previouslyRejected} candidates dropped: a rewording of a statement you rejected`);
        const merged = d.merged.intoClaims + d.merged.intoProposals + d.merged.intoCandidates;
        if (merged || d.similar) console.log(`Deduplicated: ${merged} merged (${d.merged.intoClaims} into claims, ${d.merged.intoProposals} into proposals), ${d.similar} similar to a claim${d.exactOnly ? "; meaning index unavailable, exact matches only" : ""}`);
        const routed = routeCandidates(db, vault);
        const rerouted = rerouteProposals(db, vault);
        const expired = expireProposals(db, vault);
        if (routed.accepted || routed.queued || routed.previouslyRejected || routed.invalid || rerouted.accepted || expired) {
          console.log(
            `Routed: ${routed.accepted} auto-accepted, ${routed.queued} queued (${routed.audits + rerouted.audits} picked for audit), ${routed.previouslyRejected} previously rejected` +
              (routed.invalid ? `, ${routed.invalid} invalid` : "") +
              (rerouted.accepted ? `; ${rerouted.accepted} proposals auto-accepted under the current routing` : "") +
              (expired ? `; ${expired} proposals expired` : ""),
          );
        }
        if (!values.wait || !r.running) return 0;
        await new Promise((done) => setTimeout(done, POLL_MS));
      }
    }
    if (args.length) {
      console.error(`glia extract takes no arguments but poll.\n\n${USAGE}`);
      return 1;
    }
    if (values["dry-run"]) {
      const { sources, requests } = planExtraction(db, { from: values.from, config });
      const chars = requests.reduce((n, r) => n + r.turns.reduce((m, t) => m + t.text.length, 0), 0);
      const tokens = Math.round(chars / CHARS_PER_TOKEN);
      console.log(
        `Would send ${sources.length} sources in ${requests.length} requests: ${chars} characters, about ${tokens} tokens, ` +
          `about $${((tokens * BATCH_INPUT_PER_MTOK) / 1e6).toFixed(4)} batched for input`,
      );
      return 0;
    }
    const r = await submitExtraction(db, anthropicBatchClient(anthropicApiKey()), { from: values.from, config });
    if (r.jobId === null) console.log("Nothing new to extract.");
    else console.log(`Submitted job ${r.jobId}: ${r.sources} sources in ${r.requests} requests, ${r.inputTokens} input tokens; run: glia extract poll --wait`);
    return 0;
  } finally {
    db.close();
  }
}

/** Single keys from a raw-mode terminal; `ask` drops to a line editor with the text prefilled. */
function terminalIo(): ReviewIo & { close(): void } {
  const input = process.stdin;
  emitKeypressEvents(input);
  input.setRawMode(true);
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let asking = false;
  const onKey = (str: string | undefined, key: { ctrl?: boolean; name?: string }) => {
    if (asking) return;
    queue.push(key?.ctrl && key.name === "c" ? "q" : (str ?? ""));
    wake?.();
  };
  input.on("keypress", onKey);
  return {
    keys: {
      async next() {
        while (!queue.length) await new Promise<void>((done) => (wake = done));
        return { done: false, value: queue.shift()! };
      },
    },
    async ask(prompt, initial) {
      asking = true;
      input.setRawMode(false);
      const rl = createInterface({ input, output: process.stdout });
      const answer = await new Promise<string>((done) => {
        rl.question(prompt, done);
        rl.write(initial);
      });
      rl.close();
      input.setRawMode(true);
      asking = false;
      return answer;
    },
    write: (s) => void process.stdout.write(s),
    close() {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
    },
  };
}

async function review(dbPath: string, values: { stats?: boolean; audit?: boolean }): Promise<number> {
  const db = openDb(dbPath);
  try {
    migrate(db);
    if (values.stats) {
      const weeks = reviewStats(db);
      if (!weeks.length) console.log("No review decisions yet.");
      for (const w of weeks) console.log(`${w.week}: ${w.decided} decided, rejection rate ${Math.round(w.rejectionRate * 100)}%, median ${w.medianSeconds.toFixed(1)} s`);
      return 0;
    }
    if (!process.stdin.isTTY) {
      console.error("glia review needs a terminal (it reads single keys); --stats works anywhere");
      return 1;
    }
    const vault = new Vault(vaultDirFor(dbPath));
    for (const e of (await syncClaims(db, vault, null)).errors) console.error(`glia: ${scrubText(e).value}`);
    const rerouted = rerouteProposals(db, vault);
    if (rerouted.accepted) console.log(`${rerouted.accepted} proposals auto-accepted under the current routing; they left the inbox.`);
    expireProposals(db, vault);
    const io = terminalIo();
    try {
      const r = await runReview(db, vault, io, () => new Date(), { audit: values.audit });
      console.log(`\n${r.decided} decided.`);
    } finally {
      io.close();
    }
    return 0;
  } finally {
    db.close();
  }
}

function audit(dbPath: string, args: string[], values: { n?: string }): number {
  const db = openDb(dbPath);
  try {
    migrate(db);
    if (args[0] === "sample") {
      const n = Number(values.n ?? 50);
      if (!Number.isInteger(n) || n < 1) throw new Error("--n must be a positive whole number");
      console.log(`Opened ${sampleAudit(db, new Vault(vaultDirFor(dbPath)), n)} audit items; triage them with: glia review --audit`);
      return 0;
    }
    if (args[0] === "report") {
      console.log(formatAudit(auditReport(db)));
      return 0;
    }
    console.error(`glia audit needs: sample | report\n\n${USAGE}`);
    return 1;
  } finally {
    db.close();
  }
}

async function searchCommand(dbPath: string, config: Config, query: string, limit: number, includeInjected: boolean, json: boolean): Promise<number> {
  const db = openDb(dbPath);
  try {
    migrate(db);
    const { model } = embeddingSettings(config);
    const result = await search(db, await createEmbedder(config, dirname(dbPath)), query, { limit, includeInjected });
    if (result.meaningError) console.error(`glia: meaning search unavailable (${result.meaningError}); keyword results only`);
    const status = indexStatus(db, model);
    if (status.missing) console.error(`glia: ${status.missing} turns are not in the meaning index yet; run: glia index`);
    if (status.otherModel) console.error(`glia: ${status.otherModel} chunks were embedded with another model and are ignored; run: glia index`);
    if (json) {
      console.log(JSON.stringify(result.hits, null, 2));
      return 0;
    }
    if (!result.hits.length) {
      const turns = (db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number }).n;
      console.log(turns ? "No results." : "No results: nothing is stored yet. Run glia ingest <folder or claude.ai export .zip>, or glia doctor to see what is set up.");
    }
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

/** Runs until the client closes stdin. stdout carries the protocol only: messages go to stderr. */
function mcp(dbPath: string, config: Config): number {
  const db = openDb(dbPath);
  migrate(db);
  const { model } = embeddingSettings(config);
  // Built when the first query needs it: loading the model costs seconds and memory a session may never use.
  const embedder = new LazyEmbedder(model, () => createEmbedder(config, dirname(dbPath)));
  const handle = serveStdio(() => createMcpServer(db, embedder, new Vault(vaultDirFor(dbPath))), {
    onerror: (err) => console.error(`glia mcp: ${err.message}`),
  });
  // A search can still be waiting on Ollama when the client leaves: nobody will read its answer,
  // so exit once the connection is closed instead of keeping the database open for it.
  process.stdin.once("end", () =>
    void handle.close().finally(() => {
      db.close();
      process.exit(0);
    }),
  );
  return 0;
}

async function evalCommand(
  dbPath: string,
  args: string[],
  values: { questions?: string; "arm-a"?: string; model?: string; "judge-model"?: string; only?: string; details?: boolean; arms?: string },
): Promise<number> {
  const [sub, ...rest] = args;
  const db = openDb(dbPath);
  try {
    migrate(db);
    if (sub === "run") {
      // Arm C (claims) runs by default next to raw search, so every run shows whether claims help.
      const arms = (values.arms ?? "B,C").split(",").map((a) => a.trim().toUpperCase());
      if (!arms.length || !arms.every((a): a is ToolArm => a === "B" || a === "C")) throw new Error("--arms takes B, C or both (B,C)");
      const evalDir = join(dirname(dbPath), "eval");
      const questionsPath = values.questions ?? join(evalDir, "questions.jsonl");
      const { questions: all, sha256 } = readQuestionsFile(questionsPath);
      const only = values.only?.split(",").map((s) => s.trim());
      const questions = only ? all.filter((q) => only.includes(q.id)) : all;
      if (!questions.length) throw new Error(`no questions to run in ${questionsPath}`);
      const armAPath = values["arm-a"] ?? join(evalDir, "arm-a.jsonl");
      const armA = existsSync(armAPath) ? parseArmA(readFileSync(armAPath, "utf8")) : new Map<string, string>();
      if (!armA.size) console.error(`glia: no arm A answers (${armAPath}); the gate's rules 1 and 2 stay undecided`);
      console.error(`glia: running ${questions.length} questions (arm A answers for ${questions.filter((q) => armA.has(q.id)).length})`);
      // The same server this CLI runs as `glia mcp`, started the way this process was (node or tsx).
      const mcpCommand = [process.execPath, ...process.execArgv, process.argv[1]!, "mcp", "--db", resolve(dbPath)];
      const runId = await runEval(db, {
        questions,
        questionsSha256: sha256,
        armA,
        model: values.model ?? "sonnet",
        judgeModel: values["judge-model"] ?? "sonnet",
        mcpCommand,
        arms: [...new Set(arms)] as ToolArm[],
        onProgress: (line) => console.error(`glia: ${line}`),
      });
      console.log(formatEvalReport(evalReport(db, runId), false));
      return 0;
    }
    if (sub === "report") {
      const runId = rest[0] === undefined ? undefined : Number(rest[0]);
      console.log(formatEvalReport(evalReport(db, runId), values.details ?? false));
      return 0;
    }
    if (sub === "verify" && rest.length === 4 && (rest[2] === "A" || rest[2] === "B" || rest[2] === "C") && (rest[3] === "correct" || rest[3] === "incorrect")) {
      verifyVerdict(db, Number(rest[0]), rest[1]!, rest[2], rest[3]);
      console.log(`Run ${rest[0]}, ${rest[1]}, arm ${rest[2]}: ${rest[3]} (checked by hand)`);
      return 0;
    }
    console.error(`glia eval needs: run | report [run] | verify <run> <question> <A|B|C> <correct|incorrect>\n\n${USAGE}`);
    return 1;
  } finally {
    db.close();
  }
}

/** `glia daemon install | uninstall | status`: the login service, on this machine's service manager. */
async function daemonService(action: "install" | "uninstall" | "status"): Promise<number> {
  const platform = process.platform as Platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    console.error(`glia: no service manager known for ${process.platform}; run: glia daemon`);
    return 1;
  }
  const deps: ServiceDeps = {
    platform,
    cli: [process.execPath, ...process.execArgv, resolve(process.argv[1]!)],
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    write: (p, c) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
    },
    remove: (p) => rmSync(p, { force: true }),
    run: (argv) =>
      new Promise((done) => {
        const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
        child.on("error", () => done(127));
        child.on("close", (code) => done(code ?? 1));
      }),
  };
  if (action === "status") {
    const active = await serviceActive(deps);
    console.log(active ? "glia daemon: running" : "glia daemon: not running (start it at login with: glia daemon install)");
    return active ? 0 : 1;
  }
  if (action === "uninstall") {
    await uninstallService(deps);
    console.log("glia daemon: removed");
    return 0;
  }
  const { changed } = await installService(deps);
  console.log(changed ? "glia daemon: installed and started" : "glia daemon: already installed and running");
  return (await serviceActive(deps)) ? 0 : 1;
}

/** `glia hook session-start`: always exits 0 and prints nothing when there is nothing to say. */
async function sessionStartCommand(dbPath: string, config: Config): Promise<number> {
  try {
    let stdin = "";
    for await (const chunk of process.stdin) stdin += chunk;
    const cwd = (JSON.parse(stdin || "{}") as { cwd?: unknown }).cwd;
    if (typeof cwd !== "string" || !existsSync(dbPath)) return 0;
    const db = openDb(dbPath);
    try {
      const out = sessionStartHook({ cwd }, { db, config, gitRemote: gitRemoteOf });
      if (out) process.stdout.write(`${out}\n`);
    } finally {
      db.close();
    }
  } catch {
    // a hook never fails the session
  }
  return 0;
}

/** `glia init`: the setup wizard (src/init.ts) on this machine. */
async function initWizard(dbPath: string, values: { yes?: boolean; "dry-run"?: boolean; exclude?: string[]; "no-service"?: boolean }): Promise<number> {
  if (!values.yes && !values["dry-run"] && !process.stdin.isTTY) {
    console.error("glia init asks questions and needs a terminal; run it in one, or pass --yes (and --exclude <pattern> for the projects to leave out)");
    return 1;
  }
  const io = initTerminalIo();
  const results = await runInit(realInitEnv(dbPath, defaultConfigPath()), io, {
    yes: values.yes ?? false,
    dryRun: values["dry-run"] ?? false,
    exclude: values.exclude ?? [],
    noService: values["no-service"] ?? false,
  });
  process.stdin.pause();
  return values["dry-run"] || results.every((c) => c.ok || (values["no-service"] && c.id === "service")) ? 0 : 1;
}

/** `glia daemon`: the local jobs on their own clock, one daemon per machine. */
async function daemon(dbPath: string, config: Config, once: boolean): Promise<number> {
  const dataDir = dirname(resolve(dbPath));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(join(dataDir, "daemon.pid"));
  const db = openDb(dbPath);
  migrate(db);
  const log = daemonLogger(join(dataDir, "daemon.log"));
  const hasApiKey = () => {
    try {
      anthropicApiKey();
      return true;
    } catch {
      return false;
    }
  };
  const jobs = localJobs({ cli: [process.execPath, ...process.execArgv, process.argv[1]!], db, dbPath: resolve(dbPath), config, hasApiKey });
  try {
    if (once) {
      for (const r of await runOnce(jobs)) {
        console.log(r.error ? `${r.type}: failed: ${r.error}` : `${r.type}: ok`);
        log({ level: r.error ? "error" : "info", job: r.type, state: r.error ? "failed" : "done", ...(r.error ? { error: r.error } : {}) });
      }
      return 0;
    }
    const scheduler = startScheduler(db, jobs, { log });
    log({ level: "info", job: "daemon", state: "started", pid: process.pid });
    await new Promise<void>((resolveStop) => {
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => resolveStop());
    });
    await scheduler.stop();
    log({ level: "info", job: "daemon", state: "stopped" });
    return 0;
  } finally {
    db.close();
    lock.release();
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
      claims: { type: "boolean" },
      from: { type: "string" },
      wait: { type: "boolean" },
      once: { type: "boolean" },
      yes: { type: "boolean" },
      "db-only": { type: "boolean" },
      exclude: { type: "string", multiple: true },
      "no-service": { type: "boolean" },
      stats: { type: "boolean" },
      audit: { type: "boolean" },
      limit: { type: "string" },
      injected: { type: "boolean" },
      json: { type: "boolean" },
      questions: { type: "string" },
      "arm-a": { type: "string" },
      model: { type: "string" },
      "judge-model": { type: "string" },
      only: { type: "string" },
      details: { type: "boolean" },
      arms: { type: "string" },
      n: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  // An explicit --db is the user's own path: the folders from before the rename are left alone then.
  if (values.db === undefined) moveLegacyPaths();
  const [command, ...args] = positionals;
  if (values.version) {
    console.log((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);
    return 0;
  }
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
      if (values["db-only"]) {
        init(values.db ?? defaultDbPath());
        return 0;
      }
      return initWizard(values.db ?? defaultDbPath(), values);
    case "doctor": {
      const checksOut = await checks(realInitEnv(values.db ?? defaultDbPath(), defaultConfigPath()));
      for (const c of checksOut) {
        console.log(`${c.ok ? "ok " : "FAIL"}  ${c.id}: ${c.detail}`);
        if (c.fix) console.log(`      ${c.fix}`);
      }
      return checksOut.every((c) => c.ok) ? 0 : 1;
    }
    case "scrub":
      if (!values["dry-run"]) {
        console.error("glia scrub needs --dry-run: scrubbed copies are written by ingest once the evidence store (#2) lands.");
        return 1;
      }
      console.log(formatReport(scanPaths(args.length ? args : [defaultTranscriptsDir()]), values.show ?? false));
      return 0;
    case "ingest":
      if (!args.length) {
        console.error(`glia ingest needs at least one path.\n\n${USAGE}`);
        return 1;
      }
      return ingest(values.db ?? defaultDbPath(), args, loadConfig());
    case "index":
      if (values.claims) return indexClaims(values.db ?? defaultDbPath(), loadConfig());
      return index(values.db ?? defaultDbPath(), loadConfig(), values.rebuild ?? false);
    case "audit":
      return audit(values.db ?? defaultDbPath(), args, values);
    case "review":
      return review(values.db ?? defaultDbPath(), values);
    case "extract":
      return extract(values.db ?? defaultDbPath(), args, values, loadConfig());
    case "search": {
      const limit = Number(values.limit ?? 10);
      if (!args.length || !Number.isInteger(limit) || limit < 1) {
        console.error(`glia search needs a query, and --limit a positive whole number.\n\n${USAGE}`);
        return 1;
      }
      return searchCommand(values.db ?? defaultDbPath(), loadConfig(), args.join(" "), limit, values.injected ?? false, values.json ?? false);
    }
    case "daemon":
      if (args[0] === "install" || args[0] === "uninstall" || args[0] === "status") return daemonService(args[0]);
      if (args.length) {
        console.error(`glia daemon takes install | uninstall | status, or nothing.\n\n${USAGE}`);
        return 1;
      }
      return daemon(values.db ?? defaultDbPath(), loadConfig(), values.once ?? false);
    case "hook":
      if (args[0] !== "session-start") {
        console.error(`glia hook needs: session-start\n\n${USAGE}`);
        return 1;
      }
      return sessionStartCommand(values.db ?? defaultDbPath(), loadConfig());
    case "mcp":
      return mcp(values.db ?? defaultDbPath(), loadConfig());
    case "eval":
      return evalCommand(values.db ?? defaultDbPath(), args, values);
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
    console.error(`glia: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
