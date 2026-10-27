# Packaging · glia, Installed in One Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The project becomes **glia**. A stranger installs it on a fresh Linux or macOS machine, without reading the source, and searches their own history within minutes. There are two ways in: `npm i -g @galaxymak1/glia && glia init`, or the Claude Code plugin, whose `/glia:setup` does those two steps from inside Claude. `glia daemon` keeps it fed on every OS.

**Architecture:**
- **Scheduler and daemon.** One scheduler module (jobs on Europe/Paris time, recorded in `jobs`) drives `glia daemon`. The daemon runs each local job as a child `glia` process, so one failing job never takes the daemon down. Phase 2's server reuses the same scheduler.
- **Install wizard.** `glia init` is a re-runnable wizard made of pure planning functions: database, embeddings, config, MCP clients, service. The terminal side is a thin layer over them. `glia doctor` runs the same checks, and `glia init --dry-run` prints the plan without applying it.
- **Fast start.** `glia init` returns as soon as the first ingest is stored, and keyword search works at that point. The meaning index and claims are built afterwards by the daemon, and `glia doctor` reports their progress.
- **Plugin.** The Claude Code plugin is a thin layer over a globally installed `glia`. It ships no native code.

**Tech Stack:**
- Existing: Node 22, TypeScript, better-sqlite3, sqlite-vec.
- New: `node-llama-cpp` 3.22 (MIT), used only if the Task 6 spike passes. Nothing else.
- Platform: GitHub Actions; systemd user units, launchd agents, Windows scheduled tasks.

**Spec:** `SPEC.md`, section "Packaging and license" (Install paths; `brain init` and `brain doctor`, which become `glia init` and `glia doctor`; Scheduled jobs on every OS; Embeddings without Ollama; Platforms) and Roadmap ("its gate is a fresh Linux or macOS machine reaching a searchable brain through `brain init` in under 15 minutes, without reading the source"). SPEC still uses the old name; Task 0 renames it there. This also answers SPEC's open question on whether a plugin can ship native dependencies: it cannot, so the plugin calls a globally installed `glia`.

## Global Constraints

**Name** (owner's decision, 2026-10-27)
- The product is **glia**: the brain's support cells, which work quietly around the neurons. Claude does the thinking; glia keeps what it needs within reach.
- npm `@galaxymak1/glia` (unscoped `glia` is taken; the scoped name was free on 2026-10-27). The bin is `glia`, the plugin `glia` (`/glia:…`), and the MCP server name `glia` (tools `mcp__glia__recall` etc.).
- Data `~/.local/share/glia/`, config `~/.config/glia/`; env `GLIA_DB`, `GLIA_CONFIG`; injected tag `<glia-claims>`.
- Existing data under the old name is moved, never lost or duplicated (Task 0).
- Publishing (`npm publish`, plugin marketplace) and renaming the GitHub repo are outward-facing and **(owner)** only.

**Install paths** (SPEC "Install paths")
- npm package, then `glia init`, for anyone with Node 22.
- A Claude Code plugin bundling the MCP server, the SessionStart briefing hook and `/glia:` commands. `/glia:setup` installs the npm package and runs `glia init` through Claude, so a plugin user never needs a terminal.
- Docker Compose is Phase 2 and out of scope here.

**Fast start**
- Claude Code is the main client. Claude Desktop is registered too when present. Zed and other MCP clients get a copy-paste snippet in `docs/install.md`; nothing edits their settings.
- `glia init` asks at most two questions on the default path: which projects to leave out (Enter for none), then one confirmation of the whole plan. `--yes` asks none.
- It does not wait for the meaning index or extraction: it ends at the first ingest, keyword-searchable, with `Try: glia search "…"`.
- Missing Ollama or a missing API key never blocks: keyword-only search and no extraction, each named in one line with how to turn it on.

**License and data**
- License stays `Elastic-2.0`. New dependencies must be MIT or Apache-2.0.
- Nothing personal in the package: the data stays under `~/.local/share/glia/` and `~/.config/glia/` (XDG on Linux).
- macOS uses the same XDG-style paths (`defaultDbPath`/`defaultConfigPath`), so one doc covers both.

**`glia init`** runs once and can be re-run safely. A second run on a complete install changes nothing and says so. Its steps, in order:
1. Node check and DB create or migrate.
2. Find Ollama and pull the model, or report keyword-only search.
3. Write the config, asking which Claude Code projects to exclude.
4. Detect MCP clients (Claude Code, Claude Desktop) and register the server in each, within the one confirmation.
5. Run the first ingest (keyword-searchable at once), then install the scheduled jobs, which build the meaning index in the background.

**`glia doctor`** checks each of these and prints the fix for whatever is broken. It exits 1 when any check fails.

**`glia daemon`**
- Runs the local jobs on its own clock: transcript sweep (ingest), index, extraction submit and poll.
- `glia init` starts it at login: a systemd user unit, a launchd agent, or a Windows scheduled task.
- It replaces the hand-written systemd user timer of phases 0 and 1.
- Schedule: the sweep and the batch poll every 15 min; extraction submit nightly at 02:00 Europe/Paris (only when an API key is configured); index every 15 min while anything is left unindexed, so the index started after `glia init` keeps going until it is complete.

**Embeddings without Ollama**
- The spike tests the same BGE-M3 Q8_0 GGUF in-process with `node-llama-cpp`.
- In-process becomes the default only if vectors match Ollama's at cosine 0.999 or more, at an acceptable speed: 200 tokens/s or more, half of the measured Ollama rate (435 tokens/s, #15).
- Otherwise Ollama stays, and `glia init` pulls the model.

**Platforms**
- Linux and macOS are supported and tested in CI.
- Windows is best-effort: in the CI matrix with `continue-on-error`.
- The CI matrix runs the full test suite on each.

**Process**
- Migrations are append-only. The next is v12, which the Phase 2 plan renumbers after this one; see Task 9.
- No command in this plan edits a file outside glia's own folders without a confirmation, or an explicit `--yes`. This covers MCP client configs and service units.

## Review Focus

1. **The owner's existing install under the old name** (`~/.local/share/ai_second_brain/` with the DB, vault and raw files; `~/.config/ai_second_brain/env`; a Claude Code MCP entry named `brain`). Expected: the first `glia` command moves both folders to the new paths, and the vault's git history comes along. A user with no old folders sees nothing. When both old and new exist, nothing is moved and `glia doctor` names both. `glia init` swaps the `brain` MCP entry for `glia`, so tools are never listed twice. → Task 0 "old folders are moved once", "both present: nothing moved"; Task 4 "a legacy brain entry is replaced".
2. **`glia init` re-run on a working install, or after a partial failure (Ollama down at step 2).** Expected: done steps report "ok" and change nothing; the failed step is retried, and nothing is duplicated (no second MCP entry, no second unit). → Task 5 "second run changes nothing", "resumes after a failed step".
3. **Two daemons at once** (login service plus one started by hand). Expected: the second refuses with a message naming the running pid; a stale pid file from a crash is taken over. → Task 2 "second daemon refuses", "stale pid file is taken over".
4. **A child job that hangs or crashes** (Ollama stuck mid-index). Expected: the job is killed after its timeout, recorded `failed` in `jobs`, the daemon keeps running, and the next tick retries. → Task 2 "hung job is killed and retried".
5. **The plugin installed but `glia` not on PATH** (no npm install, or a PATH that GUI apps don't see on macOS). Expected: the SessionStart hook prints one line pointing to `/glia:setup`, and the MCP server entry fails with that same hint. Never a silent empty memory. → Task 8 "missing glia points to setup".

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/legacy.ts` | Move the old `ai_second_brain` folders to the glia paths, once | 0 |
| `src/scheduler.ts` | `parisParts`, `Job`, `startScheduler`: due checks on Paris time, runs recorded in `jobs` | 1 |
| `src/daemon.ts` | `glia daemon`: the local jobs as child processes, pid lock, JSON log file | 2 |
| `src/service.ts` | systemd, launchd and schtasks: unit text, install, uninstall, status | 3 |
| `src/projects.ts` | `projectSlug`, `scopeForSource`: one scope per project | 4 |
| `src/hooks.ts` | `glia hook session-start` (local briefing) | 4 |
| `src/clients.ts` | Detect and register MCP clients: Claude Code, Claude Desktop | 4 |
| `src/init.ts` | `glia init` steps and `glia doctor` checks: pure plans plus an injected IO | 5 |
| `scripts/spike-llamacpp.ts`, `src/embedLlama.ts` | Embeddings spike; in-process embedder if it passes | 6, 7 |
| `package.json`, `README.md`, `docs/install.md` | Publishable package, install docs | 8 |
| `plugin/` | Claude Code plugin: manifest, `.mcp.json`, hooks, skills | 8 |
| `.claude-plugin/marketplace.json` | Marketplace entry pointing at `plugin/` | 8 |
| `.github/workflows/ci.yml` | Test matrix and fresh-install gate job | 9 |

---

### Task 0: Rename to glia

**Files:**
- Create `src/legacy.ts`, `test/legacy.test.ts`.
- Modify:
  - `package.json`: name `@galaxymak1/glia`; bin `{ "glia": "dist/cli.js" }`; script `glia` in place of `brain`; description.
  - `src/db.ts`, `src/config.ts`: the `glia` folders, `GLIA_DB`, `GLIA_CONFIG`.
  - `src/cli.ts`: help text, the `glia:` error prefix, and a call to `moveLegacyPaths` before dispatch.
  - `src/recall.ts`: `CLAIMS_TAG = "glia-claims"`.
  - `src/enrich.ts`: recognises `glia-claims` and still `brain-claims` as injected. Transcripts already on disk carry the old tag.
  - `src/mcp.ts`: server name `glia`.
  - `src/eval.ts`: tool names `mcp__glia__*`.
  - `src/vault.ts`: commit identity `glia` / `glia@localhost`.
  - Tests that pin these strings; `README.md`, `SPEC.md`, `docs/*.md` (the name, commands and paths; the history of past decisions stays as written).

**Interfaces:**
- Produces: `moveLegacyPaths(env: { home: string; XDG_DATA_HOME?: string; XDG_CONFIG_HOME?: string; GLIA_DB?: string }, fs?: { exists; rename; log(s: string): void }): { moved: string[]; conflict: string[] }`.
  - For the data folder and the config folder: when the old exists and the new does not, `rename` it and log `glia: moved <old> to <new>`.
  - When both exist, move nothing and return the pair in `conflict`. `glia doctor` reports it in Task 5 as a failed check `legacy`, fix `Both <old> and <new> exist: keep one, then run glia doctor`.
  - It is skipped when `GLIA_DB` is set (an explicit path is the user's).
  - `defaultDbPath` becomes `<data>/glia/glia.db`. When the folder is moved, `brain.db` and its `-wal`/`-shm` files are renamed with it.

- [ ] **Step 1: Write the failing tests**

```ts
it("old folders are moved once", () => {
  mkdirSync(join(home, ".local/share/ai_second_brain/vault/.git"), { recursive: true });
  writeFileSync(join(home, ".local/share/ai_second_brain/brain.db"), "x");
  mkdirSync(join(home, ".config/ai_second_brain"), { recursive: true });
  expect(moveLegacyPaths({ home }).moved).toHaveLength(2);
  expect(existsSync(join(home, ".local/share/glia/glia.db"))).toBe(true);
  expect(existsSync(join(home, ".local/share/glia/vault/.git"))).toBe(true);
  expect(moveLegacyPaths({ home })).toEqual({ moved: [], conflict: [] });
});
it("both present: nothing moved", () => {
  mkdirSync(join(home, ".local/share/ai_second_brain"), { recursive: true });
  mkdirSync(join(home, ".local/share/glia"), { recursive: true });
  expect(moveLegacyPaths({ home }).conflict).toHaveLength(1);
  expect(existsSync(join(home, ".local/share/ai_second_brain"))).toBe(true);
});
it("old transcripts with <brain-claims> are still flagged injected", () => { /* a turn holding <brain-claims>…</brain-claims> → injected */ });
```

- [ ] **Step 2: Run them and check they fail:** `npx vitest run test/legacy.test.ts`
- [ ] **Step 3: Implement**, then rename the strings listed in Files.
- [ ] **Step 4: Run them and check they pass:** `npx vitest run --testTimeout 30000 && npm run typecheck`, then `grep -rn "ai_second_brain\|ai-second-brain\|brain-claims\|mcp__brain" src` lists only `src/legacy.ts` and the legacy tag in `src/enrich.ts`.
- [ ] **Step 5: On this machine:** `npm run build && node dist/cli.js stats`. Expected: the `moved` lines once, then the same counts as before the rename. Then re-point the owner's command: `ln -sf "$PWD/dist/cli.js" ~/.local/bin/glia && rm ~/.local/bin/brain` (owner confirms first).
- [ ] **Step 6: Commit:** `git commit -m "Rename to glia: package, command, paths, MCP server, claims tag"`
- [ ] **Step 7 (owner):** rename the GitHub repo to `Galaxymak1/glia` (GitHub redirects the old URL). The local checkout folder can keep its name.

---

### Task 1: Scheduler on Paris time

**Files:** Create `src/scheduler.ts`, `test/scheduler.test.ts`. Modify `src/migrations.ts` (v12: `ALTER TABLE jobs ADD COLUMN run_key TEXT`, index `(type, run_key)`).

**Interfaces:**
- Produces:
  - `parisParts(d: Date): { date: string; hour: number; minute: number }`, via `Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", hourCycle: "h23", ... })`.
  - `every15(d: Date): string`: the Paris `YYYY-MM-DDTHH:mm`, floored to 15 minutes.
  - `dailyAt(hour: number, minute: number): (d: Date) => string | null`: the Paris date once the Paris time is at or past `hour:minute`, else `null`.
  - `interface Job { type: string; key(now: Date): string | null; run(): Promise<void>; timeoutMs: number }`
  - `startScheduler(db, jobs: Job[], opts?: { tickMs?: number /* 60_000 */; now?: () => Date; log?: (line: object) => void }): { stop(): Promise<void> }`
    - On each tick, every job whose `key(now)` is non-null and has no `done` or `running` row with that key runs once.
    - A run is recorded in `jobs` (`type`, `state`, `run_key`, `started_at`, `finished_at`).
    - After `timeoutMs` the job is marked `failed` and its key may run again on a later tick.
    - A job already running is never started twice.

- [ ] **Step 1: Write the failing tests**

```ts
it("02:00 Paris across DST: once per Paris night, never twice, never skipped", () => {
  const key = dailyAt(2, 0);
  const keys = [...minutesUtc("2026-03-27T22:00Z", "2026-03-30T06:00Z"), ...minutesUtc("2026-10-23T22:00Z", "2026-10-26T06:00Z")].map(key).filter(Boolean);
  expect([...new Set(keys)]).toEqual(["2026-03-28", "2026-03-29", "2026-03-30", "2026-10-24", "2026-10-25", "2026-10-26"]);
});
it("every15 floors to the quarter hour in Paris time", () => {
  expect(every15(new Date("2026-10-27T11:44:59Z"))).toBe("2026-10-27T12:30");
});
it("runs a due job once per key and records it", async () => {
  const runs: string[] = [];
  const s = startScheduler(db, [{ type: "t", key: () => "k1", run: async () => void runs.push("r"), timeoutMs: 1000 }], { tickMs: 5 });
  await sleep(40); await s.stop();
  expect(runs).toEqual(["r"]);
  expect(db.prepare("SELECT type, state, run_key FROM jobs").all()).toEqual([{ type: "t", state: "done", run_key: "k1" }]);
});
it("never starts a job still running; a job past its timeout is failed and runs again", async () => {
  let runs = 0;
  const s = startScheduler(db, [{ type: "hang", key: () => "k1", run: () => (runs++, new Promise(() => {})), timeoutMs: 20 }], { tickMs: 5 });
  await sleep(15);
  expect(runs).toBe(1);
  await sleep(40); await s.stop();
  expect(runs).toBeGreaterThanOrEqual(2);
  expect(db.prepare("SELECT state FROM jobs ORDER BY id LIMIT 1").get()).toEqual({ state: "failed" });
});
```

- [ ] **Step 2: Run them and check they fail:** `npx vitest run test/scheduler.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement as in Interfaces.**
- [ ] **Step 4: Run them and check they pass:** `npx vitest run && npm run typecheck`
- [ ] **Step 5: Commit:** `git commit -m "Packaging: scheduler on Europe/Paris time, runs recorded in jobs"`

---

### Task 2: `glia daemon`

**Files:** Create `src/daemon.ts`, `test/daemon.test.ts`. Modify `src/cli.ts`, `src/config.ts`.

**Interfaces:**
- Consumes: `startScheduler`, `every15`, `dailyAt` (Task 1).
- Produces:
  - `Config.daemon?: { paths?: string[] /* default [~/.claude/projects] */ }`
  - `localJobs(ctx: { cli: string[] /* [process.execPath, ...execArgv, cliPath] */; dbPath: string; config: Config; hasApiKey: () => boolean; spawnJob?: SpawnJob }): Job[]`. The jobs:

    | type | key | runs | timeoutMs |
    | --- | --- | --- | --- |
    | `sweep` | `every15` | `glia ingest <paths…> --db <db>` | 30 min |
    | `index` | `every15`, only when `pendingIndex(db) > 0` | `glia index`, then `glia index --claims` | 60 min |
    | `extract_submit` | `dailyAt(2, 0)`, only when `hasApiKey()` | `glia extract` | 10 min |
    | `extract_poll` | `every15`, only when a `jobs` row of type `extract` is `running` | `glia extract poll` | 30 min |

    The jobs run in table order within a tick, so a sweep that stores something is indexed in the same tick.

  - `pendingIndex(db): number`: the turns or chunks the meaning index has not embedded yet, plus claim files not mirrored. It is one cheap query, the same notion of pending that `glia index` uses. `glia doctor` shows it as progress (Task 5).
  - `type SpawnJob = (argv: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>`. A non-zero code throws, so the run is recorded `failed`. On timeout the child gets SIGTERM, then SIGKILL after 5 s.
  - `acquireLock(pidPath: string): { release(): void }`: writes the pid. It throws `glia daemon is already running (pid <n>)` when that pid is alive (`process.kill(pid, 0)`), and takes over a stale file.
  - Log: JSON lines `{ts, level, job, state, ms, error?}` to `<data dir>/daemon.log`. When it passes 5 MB it is renamed to `daemon.log.1`, replacing the old one.
  - `glia daemon [--once]`: `--once` runs every due job once and exits (CI and doctor). It handles SIGTERM and SIGINT by stopping the scheduler and releasing the lock.

- [ ] **Step 1: Write the failing tests**

```ts
it("indexes while anything is pending, and not once nothing is", async () => {
  const calls: string[] = [];
  const spawnJob: SpawnJob = async (argv) => (calls.push(argv.join(" ")), { code: 0, stdout: "", stderr: "" });
  insertUnembeddedTurn(db);
  await runOnce(localJobs({ ...ctx, spawnJob }));
  expect(calls).toEqual([expect.stringMatching(/ingest/), expect.stringMatching(/index --db/), expect.stringMatching(/index --claims/)]);
  embedAll(db); calls.length = 0;
  await runOnce(localJobs({ ...ctx, spawnJob }));
  expect(calls).toEqual([expect.stringMatching(/ingest/)]);
});
it("no API key: no extraction job", () => { expect(localJobs({ ...ctx, hasApiKey: () => false }).find((j) => j.type === "extract_submit")!.key(at0215)).toBeNull(); });
it("second daemon refuses", () => { acquireLock(pid); expect(() => acquireLock(pid)).toThrow(/already running \(pid \d+\)/); });
it("stale pid file is taken over", () => { writeFileSync(pid, "999999"); expect(() => acquireLock(pid)).not.toThrow(); });
it("hung job is killed and retried", async () => { /* real spawn of `node -e "setInterval(()=>{},1e3)"` with timeoutMs 200 → failed row, process gone, next tick runs it again */ });
```

- [ ] **Step 2: Run them and check they fail:** `npx vitest run test/daemon.test.ts`
- [ ] **Step 3: Implement.** `runOnce(jobs)` is an exported helper that runs every due job sequentially; `--once` uses it.
- [ ] **Step 4: Run them and check they pass:** `npx vitest run --testTimeout 30000 && npm run typecheck`
- [ ] **Step 5: Commit:** `git commit -m "Packaging: glia daemon runs the local jobs as child processes"`

---

### Task 3: Start the daemon at login on every OS

**Files:** Create `src/service.ts`, `test/service.test.ts`. Modify `src/cli.ts`.

**Interfaces:**
- Produces:
  - `type Platform = "linux" | "darwin" | "win32"`
  - `serviceFiles(p: Platform, cli: string[], home: string): { path: string; content: string }[]`:
    - linux: `~/.config/systemd/user/glia.service`, with `ExecStart=<cli…> daemon`, `Restart=on-failure`, `RestartSec=30` and `WantedBy=default.target`.
    - darwin: `~/Library/LaunchAgents/dev.galaxymak1.glia.plist`, with `ProgramArguments` = cli + `daemon`, `RunAtLoad true`, `KeepAlive {SuccessfulExit: false}`, and `StandardErrorPath ~/Library/Logs/glia.log`.
    - win32: none (it uses a command).
  - `serviceCommands(p: Platform, action: "install" | "uninstall" | "status", uid: number): string[][]`:
    - linux: `systemctl --user daemon-reload`; `systemctl --user enable --now glia.service`; for uninstall, `disable --now`; for status, `is-active`.
    - darwin: `launchctl bootstrap gui/<uid> <plist>`; `launchctl bootout gui/<uid>/dev.galaxymak1.glia`; `launchctl print gui/<uid>/dev.galaxymak1.glia`.
    - win32: `schtasks /Create /F /SC ONLOGON /TN glia /TR "<cli…> daemon"`; `/Delete /F`; `/Query /TN`.
  - `installService(p, deps: { write(path, content): void; run(argv): Promise<number>; ... }): Promise<{ changed: boolean }>`. It is idempotent: it writes the files only when their content differs, and runs the enable command only when status is not active.
  - `glia daemon install | uninstall | status`.

- [ ] **Step 1: Write the failing tests:** a snapshot of each unit text; `installService` twice → the second call has `changed: false` and writes nothing; `uninstall` removes the files it wrote.
- [ ] **Step 2: Run them and check they fail.** — [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and check they pass, then on this machine (Linux):** `npm run build && node dist/cli.js daemon install && systemctl --user is-active glia && node dist/cli.js daemon uninstall`. Expected: `active`, then gone.
- [ ] **Step 5: Commit:** `git commit -m "Packaging: glia daemon install for systemd, launchd and Windows"`

---

### Task 4: Project scopes, the local SessionStart hook, and MCP client registration

**Files:** Create `src/projects.ts`, `src/hooks.ts`, `src/clients.ts`, `test/projects.test.ts`, `test/hooks.test.ts`, `test/clients.test.ts`. Modify `src/extractPrompt.ts`, `src/extractInput.ts`, `src/config.ts`, `src/cli.ts`.

**Interfaces:**
- Consumes: `Platform` (Task 3); `brief`, `logRetrievals` (src/recall.ts).
- Produces, scopes:
  - `projectSlug(name: string): string`
  - `scopeForSource(s: {cwd: string | null; git_remote: string | null; project_hint: string | null}, config: Config): string | null`. Resolution order: `config.projects[slug]` (cwd prefixes or remotes), then the git remote's repo name, then the cwd's last folder, then `null`.
  - `Config.projects?: Record<string, string[]>`
  - `RenderableSource.scope` is rendered as `scope="…"` on `<source>`.
  - `EXTRACT_PROMPT_VERSION = "extract@v3"`, with the rule: `When <source> carries a scope, use the scope given on <source> for facts about that project, never another slug for it.`
- Produces, the hook:
  - `sessionStartHook(input: { cwd: string }, deps: { db: Database; config: Config; gitRemote(cwd: string): string | null; deadlineMs?: number /* 1500 */ }): string`. It returns `JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief(db, { scope, budget_tokens: 1500 }).text } })`, and logs retrievals as client `hook:session-start`. It returns `""` when there are no claims or on any error.
  - `glia hook session-start` reads the hook JSON from stdin.
- Produces, clients:
  - `type Client = "claude-code" | "claude-desktop"`. Other MCP clients (Zed and the rest) are a snippet in `docs/install.md`, not code.
  - `detectClients(env: { platform: Platform; home: string; which(cmd: string): string | null; exists(p: string): boolean }): Client[]`. Claude Code means `claude` is on PATH. Claude Desktop means its config folder exists: darwin `~/Library/Application Support/Claude/`, win32 `%APPDATA%/Claude/`, linux `~/.config/Claude/`.
  - `registrationPlan(client: Client, gliaArgv: string[], current: string | null): { kind: "commands"; argv: string[][] } | { kind: "edit"; path: string; next: string } | { kind: "ok" } | { kind: "manual"; snippet: string; why: string }`. Per client:
    - Claude Code: `ok` when `claude mcp get glia` succeeds, or the `glia` plugin is enabled. Otherwise `claude mcp add --scope user glia -- <gliaArgv…> mcp`, preceded by `claude mcp remove --scope user brain` when a legacy `brain` entry exists (`current` holds `claude mcp list` output).
    - Claude Desktop: set `mcpServers.glia = {command, args}` in `claude_desktop_config.json`, delete a legacy `mcpServers.brain`, and create the file if absent. A file that is not valid JSON gives `manual`, and the file is left untouched.

- [ ] **Step 1: Write the failing tests**

```ts
it("an existing registration is ok", () => {
  const cur = JSON.stringify({ mcpServers: { glia: { command: "/usr/bin/glia", args: ["mcp"] } } });
  expect(registrationPlan("claude-desktop", ["/usr/bin/glia"], cur).kind).toBe("ok");
});
it("a legacy brain entry is replaced", () => {
  const cur = JSON.stringify({ mcpServers: { brain: { command: "/x/cli.js", args: ["mcp"] }, other: { command: "o" } } });
  const plan = registrationPlan("claude-desktop", ["/usr/bin/glia"], cur);
  expect(Object.keys(JSON.parse((plan as { next: string }).next).mcpServers).sort()).toEqual(["glia", "other"]);
  const cc = registrationPlan("claude-code", ["/usr/bin/glia"], "brain: /x/cli.js mcp - ✓ Connected") as { kind: "commands"; argv: string[][] };
  expect(cc.argv).toEqual([["claude", "mcp", "remove", "--scope", "user", "brain"], ["claude", "mcp", "add", "--scope", "user", "glia", "--", "/usr/bin/glia", "mcp"]]);
});
it("a broken Claude Desktop config is left alone", () => { expect(registrationPlan("claude-desktop", argv, "{ oops").kind).toBe("manual"); });
it.each([["ai_second_brain", "ai-second-brain"], ["My App (v2)", "my-app-v2"], ["--x--", "x"]])("projectSlug(%s) is %s", (a, b) => expect(projectSlug(a)).toBe(b));
it("scopeForSource prefers the config mapping, then the git remote, then the cwd", () => {
  const config = { claudeCode: { exclude: [] }, projects: { "ai-brain": ["/home/me/dev/ai_second_brain", "github.com/me/brain-old"] } };
  expect(scopeForSource({ cwd: "/home/me/dev/ai_second_brain/src", git_remote: null, project_hint: null }, config)).toBe("project:ai-brain");
  expect(scopeForSource({ cwd: "/x", git_remote: "git@github.com:me/brain-old.git", project_hint: null }, config)).toBe("project:ai-brain");
  expect(scopeForSource({ cwd: "/x/y", git_remote: "https://github.com/me/Other_Repo.git", project_hint: null }, config)).toBe("project:other-repo");
  expect(scopeForSource({ cwd: null, git_remote: null, project_hint: null }, config)).toBeNull();
});
it("briefs the session's project from the local store, tagged, within budget", () => {
  // db holds an active project_fact in project:ai-brain
  const out = JSON.parse(sessionStartHook({ cwd: "/home/me/dev/ai_second_brain" }, { db, config, gitRemote: () => null }));
  expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart", additionalContext: expect.stringMatching(/^<glia-claims>[\s\S]*project:ai-brain|SQLite/) });
  expect(out.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(1500 * 2.25 + 40);
  expect(db.prepare("SELECT client FROM retrievals").all()).toContainEqual({ client: "hook:session-start" });
});
it("an empty store or an error gives no output", () => { expect(sessionStartHook({ cwd: "/x" }, { db: emptyDb, config, gitRemote: () => null })).toBe(""); });
```

- [ ] **Step 2: Run them and check they fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run them and check they pass:** `npx vitest run && npm run typecheck`
- [ ] **Step 5: Commit:** `git commit -m "Packaging: project scopes (extract@v3), local SessionStart briefing, MCP client registration"`

---

### Task 5: `glia init` wizard and `glia doctor`

**Files:** Create `src/init.ts`, `test/init.test.ts`. Modify `src/cli.ts` (`init` becomes the wizard; the old behaviour is `init --db-only`), `test/cli.test.ts`, `docs/install.md` (created here: the two install paths, what `init` asks, and the MCP snippet for Zed and other clients).

**Interfaces:**
- Consumes: `migrate`, `OllamaEmbedder`, `moveLegacyPaths` (Task 0), `detectClients`, `registrationPlan`, `installService`, `pendingIndex`.
- Produces:
  - `interface Check { id: "node" | "legacy" | "database" | "embeddings" | "config" | "clients" | "service" | "first-run" | "index"; ok: boolean; detail: string; fix?: string }`
  - `checks(env: InitEnv): Promise<Check[]>`, read-only: `glia doctor` prints them and exits 1 if any fails. `index` is never a failure: it reads `meaning index: <done>/<total> (the daemon is building it)` or `meaning index: complete`. Example `fix` strings:
    - `Run: ollama pull hf.co/gpustack/bge-m3-GGUF:Q8_0`
    - `Install Ollama from https://ollama.com/download, then run: glia init`
    - `Run: glia daemon install`
  - `runInit(env: InitEnv, io: { confirm(q: string, def: boolean): Promise<boolean>; choose(q: string, items: string[]): Promise<number[]>; say(s: string): void }, opts: { yes: boolean; dryRun: boolean; exclude: string[]; noService: boolean }): Promise<Check[]>`.
    - It first runs every check, then asks at most two questions: `choose` for exclusions (Enter for none), then one `confirm` that lists every step it will apply, every file outside glia's folders it will write, and every command it will run.
    - `--yes` skips both questions. `--dry-run` prints that list and applies nothing.
    - Each step runs only if its check fails, and checks again after:
    1. `node`: `process.versions.node` major 22 or later. Otherwise stop: `Node 22 or later is needed; you have <v>`. A `legacy` conflict also stops here, with its fix.
    2. `database`: `migrate`.
    3. `embeddings`: Ollama reachable at the config URL (`GET /api/version`, 2 s timeout). With the model missing, it pulls it via `POST /api/pull` with progress shown in MB. Unreachable means `ok: true, detail: "keyword-only search (no Ollama)"`, with the `fix` above.
    4. `config`: the exclusion question lists the folders of `~/.claude/projects` with session counts and last activity. `--exclude <pattern>` repeats; `--yes` takes only those. It writes `config.json` with mode 600, merging with any file already there.
    5. `clients`: applies each detected client's plan that is not `ok`. `manual` prints the snippet.
    6. `first-run`: runs `glia ingest` once in-process, keyword index included (FTS triggers), and does not embed. Then it prints `Ready: <n> sources, <m> turns searchable now. Try: glia search "<a word from your history>"`, and, when Ollama is there, `Meaning search builds in the background; glia doctor shows progress.`
    7. `service`: `installService` unless `--no-service`. The daemon's `index` job then embeds what is pending. It comes after `first-run`, so the first daemon sweep never races the first ingest.
    8. A closing line for each feature left off: no Ollama → keyword-only plus its fix; no API key → `Claims are off until you add ANTHROPIC_API_KEY to ~/.config/glia/env`.
  - `InitEnv` bundles platform, home, paths, `which`, `fetch`, `spawn`, fs functions and the clock, all injectable for tests.
  - `glia init [--yes] [--dry-run] [--exclude <pattern>]... [--no-service]` and `glia doctor`.

- [ ] **Step 1: Write the failing tests** (fake env: temp home, fake Ollama `fetch`, recorded spawn)

```ts
it("a fresh install runs every step in order and ends ready", async () => {
  const r = await runInit(env, io, { yes: true, dryRun: false, exclude: ["-home-me-work-*"], noService: false });
  expect(r.every((c) => c.ok)).toBe(true);
  expect(spawned.map((a) => a.join(" "))).toEqual(expect.arrayContaining([expect.stringMatching(/systemctl --user enable --now/)]));
  expect(JSON.parse(readFileSync(configPath, "utf8")).claudeCode.exclude).toEqual(["-home-me-work-*"]);
});
it("asks at most two questions and is searchable before anything is embedded", async () => {
  const asked: string[] = [];
  await runInit(env, countingIo(asked), { yes: false, dryRun: false, exclude: [], noService: true });
  expect(asked.length).toBeLessThanOrEqual(2);
  expect(embedCalls).toBe(0);
  expect(search(db, "fixture phrase").length).toBeGreaterThan(0);
  expect(said.join("\n")).toMatch(/searchable now\. Try: glia search/);
});
it("--dry-run writes nothing and runs nothing", async () => { await runInit(env, io, { ...yesOpts, dryRun: true }); expect(writtenOutsideGliaDirs()).toEqual([]); expect(spawned).toEqual([]); });
it("second run changes nothing", async () => { await runInit(env, io, yesOpts); const before = snapshot(); await runInit(env, io, yesOpts); expect(snapshot()).toEqual(before); expect(spawnedSecond).toEqual([]); });
it("resumes after a failed step", async () => { ollamaDown(); expect((await runInit(env, io, yesOpts)).find((c) => c.id === "embeddings")).toMatchObject({ ok: true, detail: /keyword-only/ }); ollamaUp(); await runInit(env, io, yesOpts); expect(pulled).toEqual(["hf.co/gpustack/bge-m3-GGUF:Q8_0"]); expect(mcpAdds).toHaveLength(1); });
it("without --yes, nothing outside glia's folders is written unless confirmed", async () => { await runInit(env, noIo, { yes: false, dryRun: false, exclude: [], noService: false }); expect(writtenOutsideGliaDirs()).toEqual([]); });
it("doctor prints the fix for each broken check and exits 1", async () => {
  ollamaDown(); removeService();
  const cs = await checks(env);
  expect(cs.filter((c) => !c.ok).map((c) => [c.id, c.fix])).toEqual([["service", "Run: glia daemon install"]]);
  expect(cs.find((c) => c.id === "embeddings")).toMatchObject({ ok: true, fix: "Install Ollama from https://ollama.com/download, then run: glia init" });
});
```

- [ ] **Step 2: Run them and check they fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run them and check they pass:** `npx vitest run --testTimeout 30000 && npm run typecheck`
- [ ] **Step 5: Commit:** `git commit -m "Packaging: glia init wizard and glia doctor"`

---

### Task 6: Spike: BGE-M3 in-process with node-llama-cpp

**Files:** Create `scripts/spike-llamacpp.ts` (run, not shipped).

- [ ] **Step 1: Write the spike**, with `node-llama-cpp` as a temporary dev dependency:
  - It loads `hf:gpustack/bge-m3-GGUF/bge-m3-Q8_0.gguf` via `resolveModelFile` into `~/.cache/glia-spike/`, then `createEmbeddingContext()`.
  - It embeds 200 chunk texts from the local DB (`chunkInputs`, the index's own inputs) both in-process and through `OllamaEmbedder`.
  - It prints the min, median and p1 cosine; tokens per second for each; and the added `node_modules` size and install time for `node-llama-cpp`.
  - It prints no text from the history.
- [ ] **Step 2: Run it:** `npx tsx scripts/spike-llamacpp.ts`. Expected: a table and a last line `decision: in-process` or `decision: ollama`. In-process wins only if the min cosine is 0.999 or more and the speed is 200 tokens/s or more on this machine.
- [ ] **Step 3: Record it.** Post the table to a new issue "Spike: BGE-M3 in-process" after the owner reads the draft, and update SPEC "Embeddings without Ollama" with the decision. If `ollama`, remove the dev dependency and skip Task 7.
- [ ] **Step 4: Commit:** `git commit -m "Packaging: spike BGE-M3 in-process with node-llama-cpp"` (the script and the SPEC line).

---

### Task 7: In-process embedder (only if Task 6 decided `in-process`)

**Files:** Create `src/embedLlama.ts`, `test/embedLlama.test.ts`. Modify `src/config.ts`, `src/cli.ts` (embedder factory), `src/init.ts` (the embeddings step downloads the model instead of calling Ollama), `package.json` (`node-llama-cpp` in `optionalDependencies`).

**Interfaces:**
- Produces:
  - `Config.embedding.provider?: "llama.cpp" | "ollama"`. The default is `"llama.cpp"` when `node-llama-cpp` loads, else `"ollama"`.
  - `class LlamaCppEmbedder implements Embedder`, with `model = DEFAULT_EMBED_MODEL`. It shares the model name with Ollama on purpose, since the vectors share one space (cosine 0.999 or more).
  - `createEmbedder(config: Config, dataDir: string): Promise<Embedder>`. Every `new OllamaEmbedder(...)` in `cli.ts` and the daemon goes through this.
  - Model file: `<data dir>/models/bge-m3-Q8_0.gguf`.
- [ ] **Step 1: Test** (skipped when the model file is absent): `LlamaCppEmbedder` returns 1024-dim normalised vectors; same text gives the same vector; `createEmbedder` falls back to Ollama when the import fails (module mocked to throw).
- [ ] **Step 2: RED.** — [ ] **Step 3: Implement.** — [ ] **Step 4: GREEN:** `npx vitest run && npm run typecheck`, then `glia index` on this machine reports `0 turns re-embedded` (same model name, same space).
- [ ] **Step 5: Commit:** `git commit -m "Packaging: in-process BGE-M3 embeddings, Ollama as the fallback"`

---

### Task 8: npm package and Claude Code plugin

**Files:**
- Modify `package.json`:
  - version `0.1.0` (the name is set in Task 0); drop `private`.
  - `"files": ["dist/", "README.md", "LICENSE"]`; `"prepack": "npm run build"`.
  - `"publishConfig": { "access": "public" }`; `repository`, `homepage`, `keywords`.
- Modify `README.md`: the Install section comes first and fits on one screen (the two paths, then `Try: glia search`), linking `docs/install.md` (Task 5) for everything else.
- Create:
  - `plugin/.claude-plugin/plugin.json`
  - `plugin/.mcp.json`
  - `plugin/hooks/hooks.json`
  - `plugin/skills/setup/SKILL.md`, `plugin/skills/recall/SKILL.md`, `plugin/skills/search/SKILL.md`, `plugin/skills/status/SKILL.md`
  - `plugin/bin-check.mjs`
  - `.claude-plugin/marketplace.json`
  - `test/package.test.ts`

**Decisions:**
- `plugin.json`: `name` `glia` (so skills are `/glia:setup`, `/glia:recall`, `/glia:search`, `/glia:status`), `displayName` `glia`, `description` `Memory for Claude: remembers your conversations and brings back what matters`, `version` equal to `package.json`'s, `license` `Elastic-2.0`, `author.name` `Kylian`, `repository` the GitHub URL.
- `.mcp.json`: `{ "mcpServers": { "glia": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/bin-check.mjs", "mcp"] } } }`.
- `bin-check.mjs` finds `glia` on PATH, or under the npm global prefix, and execs it with its arguments. When absent, it writes `glia is not installed yet: run /glia:setup (or npm i -g @galaxymak1/glia && glia init)` to stderr and exits 1. The plugin ships no native code.
- `hooks/hooks.json`: `SessionStart` → `node "${CLAUDE_PLUGIN_ROOT}/bin-check.mjs" hook session-start`. When `glia` is missing, it prints that same hint as `additionalContext` and exits 0, so the session still starts.
- Skills:
  - `setup` tells Claude to: check `glia --version`; if it is missing, run `npm i -g @galaxymak1/glia`; run `glia init --dry-run` and show the user the plan and the project list; ask which projects to leave out; then run `glia init --yes [--exclude …]` and end with `glia doctor`'s summary. Claude's own permission prompt covers each command.
  - `recall` runs `recall` with `$ARGUMENTS` and answers with claims and their `as of` dates; `search` runs `search_evidence`; `status` runs `glia doctor` and summarises it.
- `.claude-plugin/marketplace.json`: one plugin entry, `source: "./plugin"`.
- `glia init`'s Claude Code step: when the `glia` plugin is enabled (`claude plugin list` lists it), it registers nothing, so tools are not duplicated.

- [ ] **Step 1: Write the failing tests**

```ts
it("the package holds dist and docs only, and runs from a tarball", () => {
  const files = JSON.parse(execSync("npm pack --dry-run --json")) [0].files.map((f) => f.path);
  expect(files.every((f) => /^(dist\/|README\.md|LICENSE|package\.json)/.test(f))).toBe(true);
  expect(files).not.toContain("eval/");
});
it("plugin and package versions match", () => { expect(readJson("plugin/.claude-plugin/plugin.json").version).toBe(readJson("package.json").version); });
it("missing glia points to setup", () => {
  const r = spawnSync("node", ["plugin/bin-check.mjs", "hook", "session-start"], { env: { PATH: "/nonexistent" }, input: "{}" });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout.toString()).hookSpecificOutput.additionalContext).toMatch(/\/glia:setup/);
});
```

- [ ] **Step 2: RED.** — [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN, then validate:** `npx vitest run && claude plugin validate --strict ./plugin`. Expected: `Validation passed`. Then `npm pack` and `npm i -g ./galaxymak1-glia-0.1.0.tgz` in a temp prefix, and `glia --help` from it. Then, in a Claude Code session with `claude --plugin-dir ./plugin` and `glia` absent from PATH, run `/glia:setup` against the tarball and check it ends with doctor all ok.
- [ ] **Step 5: Commit:** `git commit -m "Packaging: npm package and Claude Code plugin"`
- [ ] **Step 6 (owner): publish.** Run `npm publish`, push the repo with the marketplace file, then `claude plugin marketplace add Galaxymak1/glia` and `claude plugin install glia@<marketplace>`.

---

### Task 9: CI matrix, fresh-install gate, and the Phase 2 plan update

**Files:** Create `.github/workflows/ci.yml`, `scripts/fresh-install.sh`. Modify `docs/superpowers/plans/2026-10-27-phase-2-serve-everywhere.md`.

**Decisions:**
- **Job `test`:** matrix `os: [ubuntu-latest, macos-latest, windows-latest]`, Node 22, `npm ci && npm run typecheck && npx vitest run --testTimeout 30000`. Windows has `continue-on-error: true`.
- **Job `fresh-install`:** `ubuntu-latest` and `macos-latest`, with `HOME` set to an empty temp folder.
  1. Run `scripts/fresh-install.sh`, which:
     - packs the repo and installs the tarball with `npm i -g` into a temp prefix on PATH;
     - copies `test/fixtures/claude-projects/` (synthetic sessions, no personal data; extend the existing fixtures) to `$HOME/.claude/projects`;
     - runs `glia init --yes --no-service`, then `glia search "<a phrase from the fixture>" --json`.
  2. Fail unless the search returns at least one hit, the whole job takes under 15 min, and `glia doctor` fails no check but `service` (CI runs `--no-service`).
  3. On Linux, install Ollama first (`curl -fsSL https://ollama.com/install.sh | sh`) so the meaning index runs too. On macOS the job runs keyword-only, or with in-process embeddings if Task 7 shipped.
- **Phase 2 plan update.** Packaging now owns three things the Phase 2 plan had: the project scopes (its Task 1), the scheduler (its Task 7 core), and the local SessionStart hook (its Task 6 base). Edit the Phase 2 plan:
  - Task 1 → removed (done here).
  - Task 6 → "switch the existing hook to `GET /agent/brief` when `remote.url` is set".
  - Task 7 → "add the server jobs to the existing `startScheduler`".
  - Task 5's systemd timer → a `sync` job in `localJobs`, run when `remote.url` is set.
  - Migrations renumbered after v12.
  - The rename throughout: `brain` → `glia` in commands, the MCP server and tool names, paths, the `<glia-claims>` tag, the Docker image and service names, and `/agent/*` docs.

- [ ] **Step 1: Run the script locally first:** `bash scripts/fresh-install.sh`. Expected: last line `fresh install: searchable in <n> s`.
- [ ] **Step 2: Commit, and ask the owner before pushing a branch to run CI:** `git commit -m "Packaging: CI matrix and fresh-install gate; Phase 2 plan follows packaging"`
- [ ] **Step 3 (owner): the gate.** On a real fresh Linux or macOS machine (a new VM or user account), follow only `README.md`'s Install section, timed: once by the npm path, once by the plugin and `/glia:setup`. Pass (SPEC): a searchable history in under 15 minutes, without reading the source. Also record the time from typing `glia init` to the first search result; the aim is under 5 minutes. Log both times and any step that needed more than the README on a new "Packaging gate" issue.
