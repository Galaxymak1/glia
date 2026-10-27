# Phase 2 · Serve Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run glia on the VPS behind Nginx as one OAuth-protected remote MCP endpoint that claude.ai (web, Desktop, mobile), Claude Code and Zed all use. The dev machine uploads its transcripts there, and a SessionStart hook briefs every Claude Code session.

**Architecture:** `glia serve` is a Hono app on Node 22. It serves:
- `/mcp`: stateless Streamable HTTP, one `McpServer` per request, behind a bearer check.
- `/api/auth/*`: the Better Auth OAuth 2.1 server, with GitHub login allow-listed to one account.
- `/agent/*`: upload and briefing for the dev machine's agent, with a per-machine token.
- `/health`.

A scheduler inside the same process runs index, extraction and summary jobs from the `jobs` table. Docker Compose runs glia next to Ollama; Nginx and restic run on the host.

**Tech Stack:**
- Existing: Node 22, TypeScript, better-sqlite3, `@modelcontextprotocol/server` 2.3.x.
- New: `hono` 4.13, `@hono/node-server` 2.1, `@modelcontextprotocol/hono` 2.0, `better-auth` 1.7.14, `@better-auth/oauth-provider` 1.7.13, `@better-auth/cimd` 1.7.14.
- Deployment: Docker Compose, Nginx, certbot, restic.

**Spec:** `SPEC.md`, sections "Serving", "Security, privacy and terms", "Deployment and operations", "Evaluation" (baseline 5), and Roadmap Phase 2. The gate: *brief and recall work on claude.ai mobile, Claude Code and Zed; scores hold with injection*. Check #15 (VPS RAM) is open.

## Global Constraints

**Auth**
- `@better-auth/oauth-provider` 1.6.11 or later (pin `^1.7.13`). Never the legacy `mcp()` plugin (CVE-2026-53512). Protected-resource metadata is served by our own route.
- OAuth 2.1: Dynamic Client Registration and Client ID Metadata Documents (`@better-auth/cimd`), PKCE S256 only, form-urlencoded token requests.
- `/mcp` without a valid token returns 401 with `WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource"` (RFC 9728).
- Redirect URIs: `https://claude.ai/api/mcp/auth_callback`, plus loopback redirects on any port for Claude Code.
- Every bearer token is checked for audience `<publicUrl>/mcp` (`verifyAccessTokenRequest` from `better-auth/oauth2`).
- GitHub login is allow-listed to one account by numeric user id (`server.githubUserId`). The login name is not used, because it can change.

**MCP serving**
- Serves 2025-11-25 and 2026-07-28 clients from one endpoint: a stateless transport (`sessionIdGenerator: undefined`), one server per request.
- Tool results stay under 25k tokens (`RESULT_CHARS` in `src/mcp.ts`). Read-only tools keep `readOnlyHint`.
- `brief` is also an MCP prompt (Zed uses tools and prompts only).

**Network**
- Public IPv4 A record, TLS via Let's Encrypt, no cross-host redirects.
- Nginx: `proxy_buffering off`, `proxy_read_timeout 300s`, `Authorization` and every `Mcp-*` header passed unchanged.
- Optional allowlist: `160.79.104.0/21` plus the owner's IPs.

**Data**
- Secrets are scrubbed on the dev machine before upload. The server scrubs again on store, as it does today.
- Excluded projects never leave the dev machine (`isExcludedPath`, `#nobrain` opt-out).
- Nightly restic backup at 04:00 of the data volume (glia.db, raw/, vault/, auth.db) to off-VPS storage.

**Schedule (Europe/Paris)**
- Extraction submit 02:00. Batch poll every 15 min. Index every 15 min. Daily summary line in `log.md`. Weekly claude.ai export reminder, shown in the briefing. These are the server's jobs, added to the Packaging scheduler. On the dev machine, `glia daemon` gains a `sync` job (upload every 15 min) that runs only when `remote.url` is set.

**Sizes and limits**
- SessionStart hook: at most 1,500 tokens of `additionalContext`, tagged `<glia-claims>` so ingestion flags it injected. Hard 1.5 s budget: when the server is unreachable, it prints nothing and exits 0.

**Secrets and data location**
- Nothing personal in the repo. Server data in the volume `/data` (`GLIA_DB=/data/glia.db`).
- Secrets only in env files with mode 600: `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, and the agent's `GLIA_AGENT_TOKEN`.

**Process**
- One branch per task; migrations are append-only. v12 is Packaging's (`jobs.run_key`), so this phase starts at v13.
- Packaging runs first and provides: the scheduler (`src/scheduler.ts`: `startScheduler`, `Job`, `every15`, `dailyAt`), `glia daemon` and `localJobs`, `scopeForSource` and `extract@v3`, `sessionStartHook` against the local database, and `createEmbedder`. This phase extends them; it does not rebuild them.
- Owner steps (VPS, DNS, GitHub OAuth app, certificates, connecting clients, the gate) are marked **(owner)**. They are never run without the owner.
- If #15 shows under 4 GB of free RAM on the VPS, stop before Task 8. A Mistral Embed fallback needs the owner's decision, because it sends scrubbed text to Mistral.

**Decision taken here (confirm in review):** the dev machine's agent authenticates with a long-lived per-machine token, stored hashed on the server and limited to `/agent/*`. OAuth covers `/mcp` and every client a person drives. The agent is a CLI with no browser, and SessionEnd/SessionStart hooks cannot run an OAuth flow.

## Review Focus

1. **Server unreachable at session start.** Expected: the SessionStart hook prints nothing within 1.5 s and exits 0; the session is never blocked or slowed. → Task 6 "server down: silent within budget".
2. **A valid token for another audience, or a GitHub account other than the owner's.** Expected: `/mcp` returns 401, and the sign-in is refused before any user row is created. → Task 3 "wrong audience is 401", "another GitHub account is refused".
3. **Server down or a 5xx during a sweep.** Expected: nothing is marked sent, and the next sweep sends the same files again. → Task 5 "a failed upload is retried next sweep".
4. **claude.ai and Claude Code calling at the same moment.** Expected: both get answers; SQLite's busy timeout absorbs the overlap. → Task 2 "concurrent requests both answer".
5. **The 02:00 Paris job across a DST change, on a UTC container.** Expected: it runs once per Paris night, never twice and never skipped. → Task 7 "02:00 Paris across DST".

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/projects.ts` | Already built by Packaging Task 4: `projectSlug`, `scopeForSource` | 1 |
| `src/server/app.ts` | `createApp(deps)`: the Hono app with all routes; no listening | 2, 3, 4 |
| `src/server/mcpRoute.ts` | `/mcp`: stateless Streamable HTTP over `createMcpServer` | 2 |
| `src/mcp.ts` (modify) | `brief` registered as an MCP prompt | 2 |
| `src/server/auth.ts` | Better Auth instance, GitHub allowlist, sign-in and consent pages, metadata routes, bearer check | 3 |
| `src/ingestFile.ts` | `ingestBytes`: store, parse and index one file or ZIP (extracted from `cli.ts` ingest) | 4 |
| `src/server/agentRoutes.ts` | `/agent/upload`, `/agent/brief`; agent tokens | 4 |
| `src/agent/sync.ts` | `glia sync`: sweep, filter, scrub, upload changed files, local state | 5 |
| `src/agent/hooks.ts` | `glia hook session-end` | 5 |
| `src/hooks.ts` (modify) | `sessionStartHook` from Packaging Task 4 reads the server's briefing when `remote.url` is set | 6 |
| `src/server/jobs.ts` | The server's jobs for the Packaging scheduler (`src/scheduler.ts`): index, extract, poll, summary | 7 |
| `src/eval.ts` (modify) | Arm D: claim tools plus the briefing injected | 9 |
| `src/cli.ts` (modify) | `serve`, `token`, `sync`, `push`, `hook` | 2–6 |
| `deploy/` | `Dockerfile`, `compose.yml`, `nginx/glia.conf`, `systemd/` (restic backup), `env.example` | 8 |
| `docs/deploy.md`, `docs/mcp.md` (modify) | Runbook; connecting claude.ai, Claude Code, Zed, Claude Code in Zed | 8, 9 |

---

### Task 1: One scope per project

**Done in the Packaging plan (Task 4)**, which runs before this phase: `src/projects.ts` (`projectSlug`, `scopeForSource`), `Config.projects`, the project scope on `<source>`, and prompt `extract@v3`. Nothing to build here. Later tasks consume `scopeForSource(s, config)` from `src/projects.ts`.

---

### Task 2: `glia serve`, `/mcp` over Streamable HTTP, `/health`, `brief` as a prompt

**Files:** Create `src/server/app.ts`, `src/server/mcpRoute.ts`, `test/server.test.ts`. Modify `src/mcp.ts`, `src/cli.ts`, `package.json` (add `hono`, `@hono/node-server`, `@modelcontextprotocol/hono`).

**Interfaces:**
- Produces:
  - `interface AppDeps { db: Database; embedder: Embedder | null; vault: Vault; config: Config; publicUrl: string; auth?: GliaAuth /* Task 3 */; now?: () => Date }`
  - `createApp(deps: AppDeps): Hono`
  - `GET /health` → `200 {"status":"ok","schema":<n>,"claims":<n>,"inbox":<n>,"lastIngest":<iso|null>,"exportDue":<bool>}`. `exportDue` is true when the newest `cai` source is older than 7 days, or there is none.
  - `ALL /mcp`: a new `createMcpServer(db, embedder, vault)` and a `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request. No auth in this task: the app refuses to start without `auth` unless `deps.publicUrl` is loopback.
  - `brief` prompt: `server.registerPrompt("brief", {argsSchema: {scope?: string}})` returns one user message holding `brief(db, {scope}).text`, and logs retrievals.
  - `glia serve [--port 8787] [--host 127.0.0.1]` in `src/cli.ts`.
  - Structured logs (SPEC "Observability"): `AppDeps.log?: (line: string) => void`, defaulting to stdout. Each request is one JSON line, `{ts, level, method, path, status, ms}`. The path has no query string, and no header is ever logged. Job runs (Task 7) log the same way, as `{ts, level, job, state, ms}`.

- [ ] **Step 1: Write the failing tests.** Use `@hono/node-server`'s `serve` on port 0 and `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`.

```ts
it("serves the four tools and the brief prompt over Streamable HTTP", async () => {
  const c = await connect(url);
  expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["search_evidence", "open_evidence", "recall", "brief"]);
  expect((await c.getPrompt({ name: "brief", arguments: { scope: "project:ai-brain" } })).messages[0].content.text).toContain("<glia-claims>");
});
it("answers clients on both protocol versions", async () => {
  for (const v of ["2025-11-25", "2026-07-28"]) expect((await rawInitialize(url, v)).result.protocolVersion).toBe(v);
});
it("concurrent requests both answer", async () => {
  const [a, b] = await Promise.all([connect(url), connect(url)]);
  const r = await Promise.all([a.callTool({ name: "recall", arguments: { query: "SQLite" } }), b.callTool({ name: "brief", arguments: {} })]);
  expect(r.every((x) => !x.isError)).toBe(true);
});
it("/health reports glia's state and whether an export is due", async () => {
  expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ status: "ok", schema: migrations.at(-1)!.version, exportDue: true });
});
it("logs each request as one JSON line, without query strings or tokens", async () => {
  await fetch(`${url}/health?x=secret`, { headers: { authorization: "Bearer brn_secret" } });
  expect(JSON.parse(logged.at(-1)!)).toMatchObject({ level: "info", method: "GET", path: "/health", status: 200, ms: expect.any(Number) });
  expect(logged.join("")).not.toMatch(/secret/);
});
it("refuses to start without auth on a public URL", () => {
  expect(() => createApp({ ...deps, publicUrl: "https://glia.example.com" })).toThrow(/auth/);
});
```

- [ ] **Step 2: Run them and check they fail:** `npx vitest run test/server.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement as in Interfaces.** Use `createMcpHonoApp()` for the body parsing. The app opens one `db` shared by all requests; `busy_timeout` is already 5000.
- [ ] **Step 4: Run them and check they pass:** `npx vitest run && npm run typecheck`.
- [ ] **Step 5: Commit:** `git commit -m "Phase 2: glia serve with stateless Streamable HTTP MCP and /health"`

---

### Task 3: Single-user OAuth 2.1

**Files:** Create `src/server/auth.ts`, `test/auth.test.ts`. Modify `src/server/app.ts`, `src/config.ts`, `package.json` (add `better-auth`, `@better-auth/oauth-provider`, `@better-auth/cimd`).

**Interfaces:**
- Consumes: `createApp`, `AppDeps` (Task 2).
- Produces:
  - `Config.server?: { publicUrl: string; githubUserId: number }`
  - `createGliaAuth(opts: { authDbPath: string; publicUrl: string; githubUserId: number; secret: string; github: { clientId: string; clientSecret: string } }): GliaAuth`. It holds:
    - `betterAuth` with the SQLite database at `authDbPath`, kept apart from glia.db.
    - `socialProviders.github`.
    - Plugins `jwt()`, `oauthProvider(...)` and `cimd()`.
    - `oauthProvider` options: `loginPage: "/sign-in"`, `consentPage: "/consent"`, `allowDynamicClientRegistration: true`, `allowUnauthenticatedClientRegistration: true`, `clientRegistrationDefaultApplicationType: "infer"`, `scopes: ["openid", "offline_access", "mcp"]`, and `resources: [{ identifier: \`${publicUrl}/mcp\`, allowedScopes: ["mcp", "offline_access"] }]`.
    - `databaseHooks.user.create.before`, which rejects any GitHub account whose id is not `githubUserId`.
  - `isAllowedAccount(providerId: string, accountId: string, githubUserId: number): boolean`
  - `requireMcpToken(auth: GliaAuth, publicUrl: string): MiddlewareHandler`. It calls `verifyAccessTokenRequest(requestToResourceInput(req), { verifyOptions: { issuer: publicUrl, audience: \`${publicUrl}/mcp\` }, requiredScopes: ["mcp"] })`. On failure it returns 401 with the RFC 9728 `WWW-Authenticate` header (Global Constraints).
  - Routes:
    - `/api/auth/*` → `auth.handler`.
    - `/.well-known/oauth-authorization-server` → `oauthProviderAuthServerMetadata(auth)`.
    - `/.well-known/oauth-protected-resource`, our own JSON: `{resource: "<publicUrl>/mcp", authorization_servers: ["<publicUrl>"], scopes_supported: ["mcp"], bearer_methods_supported: ["header"]}`.
    - `/sign-in`: an HTML page with one "Sign in with GitHub" button.
    - `/consent`: an HTML page naming the client and its redirect host, with Approve and Deny buttons that post to the provider's consent endpoint.
- Startup creates the auth tables with Better Auth's programmatic migrations (`getMigrations(...).runMigrations()`). There is no separate migrate command.

- [ ] **Step 1: Write the failing tests**

```ts
it("/mcp without a token is 401 pointing at the protected-resource metadata", async () => {
  const r = await fetch(`${url}/mcp`, { method: "POST", body: initialize() });
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${url}/.well-known/oauth-protected-resource"`);
});
it("protected-resource and authorization-server metadata say what claude.ai needs", async () => {
  expect(await json(`${url}/.well-known/oauth-protected-resource`)).toEqual({ resource: `${url}/mcp`, authorization_servers: [url], scopes_supported: ["mcp"], bearer_methods_supported: ["header"] });
  const as = await json(`${url}/.well-known/oauth-authorization-server`);
  expect(as).toMatchObject({ code_challenge_methods_supported: ["S256"], registration_endpoint: expect.any(String), client_id_metadata_document_supported: true });
  expect(as.token_endpoint_auth_methods_supported).toContain("none");
});
it("dynamic registration accepts claude.ai's callback and a loopback redirect on any port", async () => {
  const c = await register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1/callback"], token_endpoint_auth_method: "none" });
  expect((await authorize(c.client_id, "http://127.0.0.1:53211/callback")).status).not.toBe(400);
});
it("a token for this resource opens /mcp; a wrong audience is 401", async () => {
  expect((await mcpWith(await signAccessToken({ aud: `${url}/mcp`, scope: "mcp" }))).status).toBe(200);
  expect((await mcpWith(await signAccessToken({ aud: "https://other.example/mcp", scope: "mcp" }))).status).toBe(401);
});
it("another GitHub account is refused", () => {
  expect(isAllowedAccount("github", "4242", 4242)).toBe(true);
  expect(isAllowedAccount("github", "1", 4242)).toBe(false);
  expect(isAllowedAccount("google", "4242", 4242)).toBe(false);
});
```

`signAccessToken` mints a JWT through the `jwt` plugin's signing API, so the test needs no GitHub round trip.

- [ ] **Step 2: Run them and check they fail:** `npx vitest run test/auth.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement as in Interfaces.** Check each option name against the installed packages' `.d.mts` before relying on it. If loopback port-agnostic matching is missing in the library, add it in `/api/auth/oauth2/authorize` pre-processing. Match loopback hosts (`127.0.0.1`, `[::1]`) on scheme, host and path, ignoring the port (RFC 8252 §7.3).
- [ ] **Step 4: Run them and check they pass:** `npx vitest run && npm run typecheck`.
- [ ] **Step 5: Commit:** `git commit -m "Phase 2: single-user OAuth 2.1 with GitHub allowlist and audience-checked tokens"`

---

### Task 4: Agent endpoints: upload and briefing

**Files:** Create `src/ingestFile.ts`, `src/server/agentRoutes.ts`, `test/agent-routes.test.ts`. Modify `src/cli.ts` (ingest loop uses `ingestBytes`; `glia token create|list|revoke`), `src/migrations.ts` (v13, after Packaging's v12), `src/server/app.ts`.

**Interfaces:**
- Produces:
  - `ingestBytes(db, store: EvidenceStore, view: string, originPath: string, data: Buffer, config: Config, now?: Date): IngestFileResult`, the body of today's per-file loop in `cli.ts`. `view` is the path as `projectsView` gives it (`<project>/<session>.jsonl`, `<project>/memory/x.md`), or `exports/<name>.zip` for an export. `IngestFileResult` is a tagged union: `{kind: "excluded" | "opted_out" | "skipped" | "pruned" | "stored" | "export", ...counts}`. `glia ingest` keeps its exact output; its CLI tests are the guard.
  - Migration 12: `agent_tokens (id INTEGER PK, name TEXT UNIQUE NOT NULL, token_sha256 TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT)`.
  - `createAgentToken(db, name): string`: `brn_` + 32 random bytes in base64url, shown once and stored hashed.
  - `checkAgentToken(db, header: string | undefined): {id: number; name: string} | null`
  - `POST /agent/upload?path=<view>&sha256=<hex>`, body `application/octet-stream`:
    - 401 without a valid agent token.
    - 400 when the path has `..`, is absolute, or is not a session, subagent, memory or `exports/*.zip` path.
    - 422 when the body hash is not `sha256`.
    - 200 with `{status: IngestFileResult["kind"], ...}`.
    - The body is limited to 1 GiB and streamed to a temp file in `/data/tmp` before ingest.
  - `GET /agent/brief?scope=<scope>&budget=1500` → `text/plain`: the `brief` text, plus `\nclaude.ai export: <n> days old; export it from Settings > Privacy` when `exportDue`. Logs retrievals as client `agent:<name>`.
  - `glia token create <name>`, `glia token list`, `glia token revoke <name>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("stores and parses an uploaded session; the same bytes again change nothing", async () => {
  expect(await upload("-home-me-dev-x/" + S + ".jsonl", session)).toMatchObject({ status: "stored" });
  expect(await upload("-home-me-dev-x/" + S + ".jsonl", session)).toMatchObject({ status: "stored", created: false });
  expect(count("turns")).toBe(3);
});
it("refuses a path that leaves the projects view, a wrong hash and no token", async () => {
  expect((await rawUpload("../etc/passwd", "x")).status).toBe(400);
  expect((await rawUpload("p/" + S + ".jsonl", "x", { sha256: "00" })).status).toBe(422);
  expect((await rawUpload("p/" + S + ".jsonl", "x", { token: "brn_nope" })).status).toBe(401);
});
it("an excluded project uploaded anyway is not stored", async () => {
  expect(await upload("-home-me-work-client/" + S + ".jsonl", session, { exclude: ["-home-me-work-*"] })).toMatchObject({ status: "excluded" });
});
it("ingests an uploaded export ZIP", async () => { expect(await upload("exports/claude.zip", exportZip)).toMatchObject({ status: "export" }); });
it("briefs with the export reminder when the last export is over 7 days old", async () => {
  expect(await brief("project:ai-brain")).toMatch(/<\/brain-claims>\nclaude\.ai export: \d+ days old/);
});
it("a revoked token is refused", async () => { revoke("laptop"); expect((await rawUpload("p/" + S + ".jsonl", "x")).status).toBe(401); });
```

- [ ] **Step 2: Run them and check they fail:** `npx vitest run test/agent-routes.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Move the loop body from `cli.ts` into `ingestBytes` unchanged, then mount the routes.
- [ ] **Step 4: Run them and check they pass:** `npx vitest run --testTimeout 30000 && npm run typecheck`. Every existing `glia ingest` test still passes.
- [ ] **Step 5: Commit:** `git commit -m "Phase 2: agent upload and briefing endpoints with per-machine tokens"`

---

### Task 5: Local agent: sweep, scrub, upload; SessionEnd hook

**Files:** Create `src/agent/sync.ts`, `src/agent/hooks.ts`, `test/agent-sync.test.ts`. Modify `src/cli.ts`, `src/config.ts`, `src/daemon.ts` (the `sync` job).

**Interfaces:**
- Consumes: `/agent/upload` (Task 4).
- Produces:
  - `Config.remote?: { url: string }`. The token comes from `GLIA_AGENT_TOKEN` in `~/.config/glia/env`, read the way `anthropicApiKey` reads its key.
  - `syncOnce(opts: { roots: string[]; config: Config; statePath: string; upload: (view: string, data: Buffer, sha256: string) => Promise<{ status: string }> }): Promise<{ sent: number; unchanged: number; excluded: number; optedOut: number; failed: number }>`
    - It walks the roots with `walk`, `projectsView`, `isExcludedPath` and the opt-out check, as ingest does.
    - It runs `scrubText` on each file's text, then hashes the scrubbed bytes.
    - It sends files whose `(view, sha256)` is not in the state file.
    - It records a file in the state file only after a 2xx.
  - State file: `~/.local/state/glia/sync.json`, `{ "<view>": "<sha256>" }`, written atomically.
  - `glia sync [path...]`: the default root is `~/.claude/projects`. It prints `Sent <n>, unchanged <n>, excluded <n>, opted out <n>, failed <n>`, and exits 1 if anything failed.
  - `glia push <zip>`: uploads one export ZIP as `exports/<basename>`.
  - `glia hook session-end`: reads the hook JSON from stdin, starts `glia sync` detached (`spawn(..., { detached: true, stdio: "ignore" }).unref()`), and exits 0 at once.
  - A `sync` job in `localJobs` (`src/daemon.ts`, Packaging Task 2): `every15`, runs `glia sync` as a child process, and is returned only when `config.remote?.url` is set. No systemd timer: `glia daemon` already runs at login on every OS.

- [ ] **Step 1: Write the failing tests**

```ts
it("sends new and changed files once, scrubbed, and skips excluded and opted-out sessions", async () => {
  const sent: string[] = [];
  const r = await syncOnce({ ...opts, upload: async (v, d) => (sent.push(v), expect(d.toString()).not.toContain(KEY), { status: "stored" }) });
  expect(r).toMatchObject({ sent: 2, excluded: 1, optedOut: 1 });
  expect((await syncOnce({ ...opts, upload: never })).unchanged).toBe(2);
});
it("a failed upload is retried next sweep", async () => {
  expect((await syncOnce({ ...opts, upload: async () => { throw new Error("502"); } })).failed).toBe(2);
  expect((await syncOnce({ ...opts, upload: ok })).sent).toBe(2);
});
it("a grown session is sent again", async () => { append(sessionPath, line); expect((await syncOnce({ ...opts, upload: ok })).sent).toBe(1); });
it("the SessionEnd hook returns within 200 ms", async () => { expect(await timeHook("session-end", { transcript_path: sessionPath })).toBeLessThan(200); });
```

- [ ] **Step 2: Run them and check they fail:** `npx vitest run test/agent-sync.test.ts`
- [ ] **Step 3: Implement as in Interfaces.**
- [ ] **Step 4: Run them and check they pass:** `npx vitest run --testTimeout 30000 && npm run typecheck`
- [ ] **Step 5: Commit:** `git commit -m "Phase 2: local agent sweep and upload, SessionEnd hook, sync job in the daemon"`

---

### Task 6: SessionStart briefing hook

**Files:** Modify `src/hooks.ts` (the hook Packaging Task 4 built), `src/cli.ts`. Extend `test/hooks.test.ts`.

**What changes:** `sessionStartHook` today briefs from the local database. With `config.remote?.url` set it asks the server instead (`GET /agent/brief`), because the server holds the claims from every machine. Without `remote.url` nothing changes. The signature gains `fetchBrief` and becomes async.

**Interfaces:**
- Consumes: `scopeForSource` (`src/projects.ts`, Packaging Task 4); `sessionStartHook` (Packaging Task 4); `GET /agent/brief` (Task 4).
- Produces: `sessionStartHook(input: { cwd: string; session_id: string }, deps: { fetchBrief(scope: string | null): Promise<string>; gitRemote(cwd): string | null; config: Config; timeoutMs?: number /* 1500 */ }): Promise<string>`.
  - It returns the stdout to print: `JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })`, or `""` on timeout or error.
  - `glia hook session-start` wires it to stdin/stdout, with `git -C <cwd> remote get-url origin` as `gitRemote`.

- [ ] **Step 1: Write the failing tests**

```ts
it("briefs the session's project, tagged so ingestion flags it", async () => {
  const out = JSON.parse(await sessionStartHook({ cwd: "/home/me/dev/ai_second_brain", session_id: "s" }, deps));
  expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart", additionalContext: expect.stringMatching(/^<glia-claims>/) });
  expect(asked).toEqual(["project:ai-brain"]);
});
it("server down: silent within budget", async () => {
  const t = Date.now();
  expect(await sessionStartHook(input, { ...deps, fetchBrief: () => new Promise(() => {}) })).toBe("");
  expect(Date.now() - t).toBeLessThan(1700);
});
it("caps the context at 1500 tokens", async () => { expect(JSON.parse(await sessionStartHook(input, bigBrief)).hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(1500 * 2.25); });
```

- [ ] **Step 2: Run them and check they fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run them and check they pass:** `npx vitest run && npm run typecheck`
- [ ] **Step 5: Document the hooks in `docs/mcp.md`.** This is the `~/.claude/settings.json` block for `SessionStart`, `SessionEnd` and `PreCompact` (`"async": true` on the last two), all calling `glia hook …`. Then commit: `git commit -m "Phase 2: SessionStart briefing hook"`

---

### Task 7: Server jobs on the scheduler

**Files:** Create `src/server/jobs.ts`, `test/server-jobs.test.ts`. Modify `src/cli.ts` (`glia serve` starts the scheduler with these jobs; `--no-jobs` turns it off). The scheduler itself, its Paris-time helpers and the `jobs.run_key` column already exist (Packaging Task 1, migration v12); this task adds no migration.

**Interfaces:**
- Consumes (Packaging Task 1, `src/scheduler.ts`): `startScheduler(db, jobs, opts)`, `Job` (`{ type; key(now): string | null; run(): Promise<void>; timeoutMs }`), `every15`, `dailyAt`, `parisParts`. A job is due when `key(now)` is non-null and no `done` or `running` row holds that run key; the key is `YYYY-MM-DD` for daily jobs and `YYYY-MM-DDTHH:mm` floored to 15 minutes for the others. Each run is recorded in `jobs`, and a job still running is not started twice.
- Produces:
  - `serverJobs(ctx: { db; vault: Vault; embedder: Embedder; config: Config; hasApiKey(): boolean }): Job[]`.
  - Jobs, in process (the server owns the database, so no child processes):
    - `index`: `buildIndex` and `syncClaims`, `every15`.
    - `extract_submit`: `submitExtraction`, `dailyAt(2, 0)`, only when `hasApiKey()`.
    - `extract_poll`: poll → validate → dedup → route → expire, `every15`, only while an extraction batch is running. It is the same chain as `glia extract poll`, moved into one exported `processCandidates(db, vault, embedder): Promise<{ validated: ValidationReport; dedup: DedupReport; routed: RouteReport; expired: number }>`, which `glia extract poll` calls too.
    - `summary`: `dailyAt(23, 55)`, one `log.md` line: `- <date> · summary · sources +<n> · claims proposed <n> accepted <n> · inbox <n>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("the server's jobs are due at the Paris times the schedule names", () => {
  const jobs = serverJobs({ ...ctx, hasApiKey: () => true });
  const key = (type: string, iso: string) => jobs.find((j) => j.type === type)!.key(new Date(iso));
  expect(key("extract_submit", "2026-10-27T00:59:00Z")).toBeNull(); // 01:59 Paris
  expect(key("extract_submit", "2026-10-27T01:00:00Z")).toBe("2026-10-27"); // 02:00 Paris
  expect(key("index", "2026-10-27T11:44:59Z")).toBe("2026-10-27T12:30");
  expect(key("summary", "2026-10-27T21:55:00Z")).toBe("2026-10-27"); // 23:55 Paris
  expect(serverJobs({ ...ctx, hasApiKey: () => false }).find((j) => j.type === "extract_submit")!.key(new Date("2026-10-27T01:00:00Z"))).toBeNull();
});
it("the summary job appends one line to log.md", async () => {
  await serverJobs(ctx).find((j) => j.type === "summary")!.run();
  expect(readFileSync(join(vault.dir, "log.md"), "utf8")).toMatch(/- \d{4}-\d{2}-\d{2} · summary · sources \+\d+ · claims proposed \d+ accepted \d+ · inbox \d+\n$/);
});
it("processCandidates runs the same chain as glia extract poll", async () => {
  // fixture: one new candidate citing a real turn → validated, deduplicated, auto-accepted, committed
  const r = await processCandidates(db, vault, new VectorEmbedder());
  expect(r).toMatchObject({ validated: { kept: 1 }, routed: { accepted: 1 } });
  expect(git(vault.dir, "log", "-1", "--format=%s")).toMatch(/^accept clm_/);
});
```

- [ ] **Step 2: Run them and check they fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run them and check they pass:** `npx vitest run --testTimeout 30000 && npm run typecheck`
- [ ] **Step 5: Commit:** `git commit -m "Phase 2: the server's jobs on the Packaging scheduler"`

---

### Task 8: Deployment: Docker Compose, Nginx, backups, runbook

**Files:** Create `deploy/Dockerfile`, `deploy/compose.yml`, `deploy/env.example`, `deploy/nginx/glia.conf`, `deploy/systemd/glia-backup.service`, `deploy/systemd/glia-backup.timer`, `docs/deploy.md`, `.dockerignore`.

**Decisions:**
- **Dockerfile:** `node:22-bookworm-slim`, multi-stage (`npm ci`, `npm run build`, `npm prune --omit=dev`). Runs as user `node`. `ENTRYPOINT ["node", "dist/cli.js"]`, `CMD ["serve", "--host", "0.0.0.0", "--port", "8787"]`. `ENV GLIA_DB=/data/glia.db BRAIN_CONFIG=/data/config.json`. `HEALTHCHECK` curls `/health`.
- **compose.yml:**
  - Service `glia`: volume `glia-data:/data`, `env_file: /etc/glia/env`, ports `127.0.0.1:8787:8787`, `restart: unless-stopped`.
  - Service `ollama`: `ollama/ollama`, volume `ollama:/root/.ollama`, not published.
  - glia's config sets `embedding.url` to `http://ollama:11434`.
- **nginx/glia.conf:**
  - `server_name __DOMAIN__`; `listen 443 ssl` with certbot paths; `location / { proxy_pass http://127.0.0.1:8787; }`.
  - `proxy_buffering off; proxy_read_timeout 300s; proxy_send_timeout 300s; client_max_body_size 1g;`
  - `proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https;`, so glia builds `publicUrl`-matching URLs.
  - `Authorization` and `Mcp-*` pass by default. Add a comment saying so, and never `proxy_set_header Authorization`.
  - The commented-out allowlist `allow 160.79.104.0/21; deny all;`.
- **glia-backup:** `restic backup` of the volume's host path, then `restic forget --keep-daily 14 --keep-weekly 8 --prune`. Runs at `OnCalendar=*-*-* 04:00 Europe/Paris`, with `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE` from `/etc/glia/restic.env`.

- [ ] **Step 1: Local smoke test.** Run `docker compose -f deploy/compose.yml up -d --build`, then `curl -s localhost:8787/health`.
  Expected: `{"status":"ok",...}`. A fresh volume reports schema 13 or later.
- [ ] **Step 2: Write `docs/deploy.md`** as a runbook, step by step:
  1. **(owner)** Get a VPS with a public IPv4, and create an A record for the domain.
  2. **(owner)** Run check #15: `ollama pull hf.co/gpustack/bge-m3-GGUF:Q8_0`, then `python3 scripts/bench_embed.py`. Under 4 GB free RAM, stop (Global Constraints).
  3. **(owner)** Create a GitHub OAuth app with callback `https://<domain>/api/auth/callback/github`, and note your numeric GitHub id (`gh api user -q .id`).
  4. Install Docker, Nginx, certbot and restic, and get the certificate.
  5. Create `/etc/glia/env` (mode 600) from `deploy/env.example`, and `/data/config.json` with `server.publicUrl`, `server.githubUserId` and `embedding.url`.
  6. Copy the existing data dir once (`glia.db`, `raw/`, `vault/`, `eval/`) into the volume, with `rsync -a`, before first start.
  7. Run `docker compose up -d` and `docker compose exec glia node dist/cli.js token create laptop`.
  8. On the laptop:
     - Put `GLIA_AGENT_TOKEN` in `~/.config/glia/env`.
     - Set `remote.url` in the config and re-run `glia init --yes`: the daemon's `sync` job starts uploading, and the hooks are documented in `docs/mcp.md`.
     - Run `glia sync` once.
  9. Enable the backup timer and run one backup.
  10. Running `glia review` on the server: `docker compose exec -it glia node dist/cli.js review`.
  11. Cloning the vault for Obsidian over SSH, read-only.
- [ ] **Step 3: Commit:** `git commit -m "Phase 2: Docker Compose, Nginx and restic deployment with runbook"`
- [ ] **Step 4 (owner): Deploy** following `docs/deploy.md`. Then check `curl https://<domain>/health` from outside, and confirm that `/mcp` with no token answers 401 with the `WWW-Authenticate` header.

---

### Task 9: Clients, briefing-injection arm, Phase 2 gate

**Files:** Modify `src/eval.ts`, `src/migrations.ts` (`eval_results.arm` allows `'D'`, a table rebuild like v11), `src/cli.ts`, `test/eval.test.ts`, `docs/mcp.md`, `docs/eval.md`.

**Interfaces:**
- Produces:
  - `ToolArm = "B" | "C" | "D"`.
  - Arm D runs arm C's tools and prompt, plus `--append-system-prompt <briefing>`. The briefing is `brief(db, { budget_tokens: 1500 }).text`, computed once per run (SPEC baseline 5).
  - `glia eval run` defaults to `--arms B,C,D`.
  - `EvalReport.armD` and `byCategory[c].D`.
  - The report adds the line `Briefing injected (D) against claims (C): <+/-n> overall; per category …`.
  - The Phase 2 rule `D ≥ C overall` is printed as `injection holds: met | NOT met`.

- [ ] **Step 1: Write the failing tests**

```ts
it("arm D runs the claim tools with the briefing appended to the system prompt", async () => {
  await runArms(["C", "D"]);
  const d = seen.filter((a) => a.includes("--append-system-prompt"));
  expect(d).toHaveLength(5);
  expect(d[0]![d[0]!.indexOf("--append-system-prompt") + 1]).toMatch(/^<glia-claims>/);
});
it("reports whether injection holds", async () => { expect(formatEvalReport(evalReport(db, id), false)).toMatch(/injection holds: (met|NOT met)/); });
```

- [ ] **Step 2: Run them and check they fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run them and check they pass:** `npx vitest run --testTimeout 30000 && npm run typecheck`
- [ ] **Step 5: Write the client section of `docs/mcp.md`:**
  - claude.ai: Settings → Connectors → Add custom connector → `https://<domain>/mcp`, added on web or Desktop first; mobile then follows.
  - Claude Code: `claude mcp add --transport http glia https://<domain>/mcp`, or it picks up the claude.ai connector. Remove the old local stdio `glia` server, so tools are not duplicated.
  - Zed: `context_servers.glia` with `"url": "https://<domain>/mcp"`; it signs in with OAuth.
  - Claude Code inside Zed (`claude-agent-acp`): configure the server in one place only.
- [ ] **Step 6: Commit:** `git commit -m "Phase 2: briefing-injection arm D and client setup"`
- [ ] **Step 7 (owner): the gate.**
  1. Connect claude.ai on web, then check `brief` and `recall` from the claude.ai mobile app.
  2. Do the same from Claude Code (connector plus SessionStart hook) and from Zed (tools and the `brief` prompt).
  3. Run `glia eval run` on the server, check D's verdicts by hand, and record the result on the Phase 2 gate issue: three clients working, and injection holds.
