# Phase 1 · Claims and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 0 evidence store into reviewed, dated, attributed claims (Haiku 5.5 batch extraction → validation → deduplication → routing → `brain review`), serve them through `recall` and `brief`, and decide the Phase 1 gate.

**Architecture:** Each stage of the pipeline is a pure-ish module that reads and writes one SQLite stage table. `candidates` carries a claim from batch result to vault, with a `state` column per stage, so any stage can be re-run or resumed. The vault (`<data dir>/vault/`, Markdown + git) is the truth for accepted claims. The `claims*` tables mirror it and can be rebuilt from it. Proposals, the log and retrievals are operational state in SQLite, and the log is mirrored to `vault/log.md`.

**Tech Stack:** Node 22, TypeScript, better-sqlite3 + FTS5 + sqlite-vec, zod 4, `@anthropic-ai/sdk` (Batch API, structured output), `@modelcontextprotocol/server` 2.3, vitest, `git` CLI, and one new dependency: `js-yaml` 4 (MIT).

**Spec:** `SPEC.md` (sections "Data model", "Extraction and consolidation", "Review inbox", "Serving", "Evaluation"). Work packages: GitHub issues #34–#42 and check #33 (project "AI Second Brain"). Findings that already bind: the #32 result comment and the #35 comment.

## Global Constraints

- Follow the work-package flow: one branch per work package (`wp11-claim-store`, …). Commit messages follow the repo style (`WP11: …`). Opening a PR is outward-facing, so ask the owner before running `gh pr create`.
- Migrations are append-only (`src/migrations.ts`). Every task that adds one also updates the schema version that `test/cli.test.ts` expects (currently `v7`).
- Nothing personal goes in the repository. The vault lives at `join(dirname(dbPath), "vault")`, next to `raw/`. The API key comes from `~/.config/ai_second_brain/env` (`ANTHROPIC_API_KEY`), never from the shell, and the base URL is always `https://api.anthropic.com` (see `scripts/check-extract.ts`).
- Extraction model `claude-haiku-5-5`, effort `medium`, through the Batch API. A prompt or schema change bumps `EXTRACT_PROMPT_VERSION`. Every claim records `extractor: {model, prompt, batch}`.
- Requests stay under Haiku's 100k-token price step. Sources tokenize at about **2.25 characters per token**, not 3.5 (#32).
- RRF `k = 60`; FTS5 `unicode61 remove_diacritics 2`; vectors are 1024-dim BGE-M3 with `model` and `dims` stored per row (reuse `EMBEDDING_DIMS`, `RRF_K`, `ftsQuery`).
- Never update or delete a claim automatically: status changes only through review actions. The vault file is written and committed first, then the index row. `brain index --claims` repairs any gap.
- Auto-accept only `user_stated` / `user_confirmed`, non-sensitive, not a decision, not similar to an active claim. Proposals expire after 30 days. Snooze lasts 7 days. 10% of auto-accepted claims are resurfaced for audit.
- MCP tool results stay under 25k tokens (`RESULT_CHARS = 50_000` as in `src/mcp.ts`) and are annotated `readOnlyHint`.
- Psychological or personality inferences are dropped, never stored.
- Out of Phase 1, do not build: the nightly timer, consolidation edges (`supersedes`/`contradicts` proposals), the MCP App widget, `brief` as an MCP prompt, `remember`/`record_decision`/`resolve`/`forget` tools, and the "suggested rewordings" for `e` (they need a model call; inline edit only).

## Review Focus

1. **A claim file edited in Obsidian.** Obsidian rewrites frontmatter as block YAML and may reorder keys. A hand edit can also break it. The index must read the rewritten file. A broken file is reported by path and skipped; it must not abort the sync or be overwritten. → Task 1, `claims.test.ts` "obsidian-style" and "broken file".
2. **The same source extracted twice** (a resumed session, a re-imported export). This must not duplicate claims or evidence entries, and must not re-propose a statement the user rejected. → Task 6 "re-extraction adds no evidence twice", Task 7 "a statement once rejected is never proposed again".
3. **Ollama down during dedup or recall.** Candidates must not be lost or wrongly merged: dedup falls back to exact statement match, and recall to keyword only, with a note. → Task 6 "embedder down", Task 9 "recall without embedder".
4. **One turn longer than the request cap** (a huge paste). It is split into pieces under the same ref. No request goes over the cap, and quotes from any piece still validate. → Task 2 "oversized turn".
5. **The vault working tree holds the user's unrelated edits.** A claim commit must commit only that claim's file and `log.md`, and must work with no global git identity (CI, fresh machine). → Task 1 "commit leaves unrelated edits", "no global identity".

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/ulid.ts` | `ulid(now?)`: Crockford base32, 48-bit time + 80-bit random | 1 |
| `src/claims.ts` | Claim zod schema, serialize/parse of claim files, `statementKey` | 1 |
| `src/vault.ts` | `Vault`: the vault directory, git commits, `log.md`, `appendLog` | 1 |
| `src/claimIndex.ts` | Mirror vault → `claims`, `claims_fts`, `claims_vec`, `edges`; `syncClaims` | 1 |
| `src/extractInput.ts` | Select sources, strip injected/recalled text, scrub, cut requests | 2 |
| `src/extractPrompt.ts` (modify) | Prompt `extract@v2` with the #32 fixes | 3 |
| `src/extractor.ts` | Batch submit, poll and resume via `jobs`; store `candidates` | 3 |
| `src/validate.ts` | Quote, origin, scope, personality and valid-time checks | 5 |
| `src/dedup.ts` | Merge candidates into claims, proposals and each other | 6 |
| `src/route.ts` | Auto-accept or propose; audit picks; expiry | 7 |
| `src/review.ts` | Inbox, card, review actions, stats; the key loop | 8 |
| `src/recall.ts` | `recall` and `brief` over claims; `retrievals` | 9 |
| `src/mcp.ts`, `src/enrich.ts` (modify) | Register `recall`/`brief`; tag `brain-claims` as injected | 9 |
| `src/eval.ts` (modify), `src/audit.ts` | Arm C (claims), precision audit | 10 |
| `src/cli.ts` (modify) | `index --claims`, `extract`, `review`, `audit`, `eval run --arms` | 1, 3, 5–8, 10 |
| `test/helpers.ts` | `VectorEmbedder` (fixed vectors per text), `tmpVault()` | 1 |

---

### Task 1: Claim store, vault files, index tables, rebuild (WP11, #34)

**Files:**
- Create: `src/ulid.ts`, `src/claims.ts`, `src/vault.ts`, `src/claimIndex.ts`, `test/helpers.ts`, `test/claims.test.ts`, `test/vault.test.ts`
- Modify: `src/migrations.ts` (v8), `src/cli.ts` (`index --claims`), `test/cli.test.ts` (v8), `package.json` (`js-yaml`, `@types/js-yaml`)

**Interfaces:**
- Produces:
  - `ulid(now?: number): string`
  - `ClaimSchema` (zod), `type Claim`, with every SPEC frontmatter field plus `statement`. Evidence entries are `{source: string /* "<kind>:<external_id>" */, turn: string /* turn external_uuid */, quote: string, quote_sha256: string}`. `extractor: {model, prompt, batch} | null` (null for hand-made claims). Decision-only fields are optional.
  - `serializeClaim(c: Claim): string`; `parseClaimFile(text: string, path: string): Claim` (throws `` `${path}: ${field}: …` ``)
  - `statementKey(statement: string): string`: sha256 of NFKC, lowercased, diacritics stripped, whitespace collapsed, trailing `.!?` removed
  - `class Vault { constructor(dir: string); claimPath(c: Claim): string /* claims/<year of recorded_at>/<id>.md */; writeClaim(c: Claim, message: string): string /* commit sha */; readAll(): {claims: Claim[]; errors: string[]} }`
  - `appendLog(db, vault: Vault, e: {actor: string; action: string; claim_id?: string; payload?: unknown}, now?: Date): void`
  - `vaultDirFor(dbPath: string): string`
  - `syncClaims(db, vault: Vault, embedder: Embedder | null): {inserted: number; updated: number; removed: number; embedded: number; errors: string[]}`
  - `claimRow(db, id: string): Claim | null`
  - test helper `VectorEmbedder(vectors: Record<string, number[]>, model = "fake@1")`: pads to 1024 and normalises; an unknown text gets a hash-seeded vector

- [ ] **Step 1: Write the failing tests**

```ts
// test/claims.test.ts
it("round-trips a decision claim with every field unchanged", () => {
  const c = fullDecisionClaim(); // statement: 'On part sur SQLite: "zéro ops", pas Postgres.' with a newline inside rationale
  expect(parseClaimFile(serializeClaim(c), "x.md")).toEqual(c);
});
it("reads obsidian-style block YAML with reordered keys", () => {
  const text = obsidianRewrite(serializeClaim(fullDecisionClaim())); // fixture: block lists, keys sorted, dates unquoted
  expect(parseClaimFile(text, "x.md")).toEqual(fullDecisionClaim());
});
it("keeps dates as strings", () => {
  expect(parseClaimFile(serializeClaim(c), "x.md").recorded_at).toBe("2026-10-20T14:02:11Z");
});
it("names the file and field of a broken claim", () => {
  expect(() => parseClaimFile(serializeClaim(c).replace("kind: decision", "kind: mood"), "claims/2026/a.md")).toThrow(/claims\/2026\/a\.md: kind/);
});
it("statementKey ignores case, accents, spacing and the final stop", () => {
  expect(statementKey("Kylian préfère  SQLite.")).toBe(statementKey("kylian prefere sqlite"));
});

// test/vault.test.ts
it("each write is one commit holding the claim file and log.md only", () => { /* unrelated.md modified before; after writeClaim, `git status --porcelain` still lists unrelated.md and `git show --name-only HEAD` lists exactly the claim path and log.md */ });
it("commits with no global git identity", () => { /* run with env HOME=<tmp>, GIT_CONFIG_NOSYSTEM=1 */ });
it("every write appends a log row and a log.md line", () => {
  appendLog(db, vault, { actor: "extractor", action: "auto_accept", claim_id: "clm_X", payload: { source: "cc:s1" } }, new Date("2026-10-26T10:00:00Z"));
  expect(db.prepare("SELECT actor, action, claim_id FROM log").all()).toEqual([{ actor: "extractor", action: "auto_accept", claim_id: "clm_X" }]);
  expect(readFileSync(join(dir, "log.md"), "utf8")).toContain('- 2026-10-26T10:00:00Z · extractor · auto_accept · clm_X · {"source":"cc:s1"}');
});

// test/claims.test.ts, index
it("rebuilding from the vault gives the same rows", async () => {
  // three claims written, one superseding another; syncClaims; snapshot claims (all columns but n), edges, claims_vec (claim_n, model)
  // DELETE FROM claims; DELETE FROM edges; syncClaims again → snapshots equal
});
it("skips a broken file, reports it, and indexes the rest", () => { /* errors.length === 1, names the path; other rows present; file bytes unchanged */ });
it("picks up an edited statement and re-embeds it", () => { /* edit body on disk; sync → updated 1, embedded 1, claims_fts finds the new word */ });
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/claims.test.ts test/vault.test.ts`
Expected: FAIL, modules `../src/claims.js` and `../src/vault.js` not found.

- [ ] **Step 3: Add migration 8 "claim layer" in `src/migrations.ts`**

- `claims`: `n INTEGER PRIMARY KEY`, `id TEXT UNIQUE NOT NULL`, one column per frontmatter scalar (CHECKs with the SPEC enums), and JSON text for `evidence`, `extractor`, `supersedes`, `options`, `expected_outcome`. Also `statement`, `file_path`, `file_sha`.
- `claims_fts`: external content on `claims.statement`, `content_rowid = 'n'`, kept in sync by triggers, as `turns_fts` is.
- `claims_vec`: vec0 with `claim_n INTEGER PRIMARY KEY`, `embedding FLOAT[1024] distance_metric=cosine`, `model`, `dims`, `input_sha256`. Add a delete trigger on `claims`.
- `edges (src, dst, type CHECK IN ('supersedes','contradicts','refines','about','derived_from'), valid_from, valid_to, PRIMARY KEY (src, dst, type))`.
- `retrievals (claim_id, client, session_ref, ts)`.
- `proposals (id TEXT PK, kind CHECK IN ('claim','decision','audit'), claim_id, claim_json, statement_key, reason, similar_to, created_at, expires_at, snoozed_until, shown_at, decided_at, decision_ms, state CHECK IN ('open','accepted','edited','merged','rejected','expired'))`, indexed on `(state, created_at)` and on `statement_key`.
- `log (ts, actor, action, claim_id, payload)`.
- `jobs` already exists (v1); leave it.

- [ ] **Step 4: Implement `src/ulid.ts`, `src/claims.ts`, `src/vault.ts`, `src/claimIndex.ts`**

- YAML: `js-yaml` with `schema: JSON_SCHEMA` on both load and dump, so timestamps stay strings, and `lineWidth: -1`.
- File layout: `---\n<yaml>---\n\n<statement>\n`. The statement is the trimmed body.
- `Vault` runs `git` via `execFileSync`. On first use: `git init`, then local `user.name=brain` and `user.email=brain@localhost`. `writeClaim` runs `git add -- <file> log.md`, then `git commit -m <message> -- <file> log.md`, so nothing else is committed. Callers `appendLog` before `writeClaim`, so the entry is in the same commit.
- `syncClaims` walks `claims/**/*.md` in path order and inserts in `id` order. Rows whose `file_sha` is unchanged are skipped. Rows whose file is gone are removed. `edges` is rebuilt from each claim's `supersedes`. A claim is re-embedded when the sha256 of its statement differs from `claims_vec.input_sha256`. With `embedder` null, vectors are left as they are.
- Add `brain index --claims` in `src/cli.ts`: it opens the vault and prints `Claims: <inserted> new, <updated> updated, <removed> removed, <embedded> embedded` plus one `brain: <error>` line per broken file. It exits 1 if there were errors. Add the line to `USAGE`.

- [ ] **Step 5: Run the tests and check they pass**

Run: `npx vitest run test/claims.test.ts test/vault.test.ts test/cli.test.ts test/migrations.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ulid.ts src/claims.ts src/vault.ts src/claimIndex.ts src/migrations.ts src/cli.ts test/helpers.ts test/claims.test.ts test/vault.test.ts test/cli.test.ts package.json package-lock.json
git commit -m "WP11: claim files, vault commits, claim index and rebuild"
```

---

### Task 2: Extraction input: select, strip, chunk (WP12, #35)

**Files:**
- Create: `src/extractInput.ts`, `test/extractInput.test.ts`
- Modify: `src/migrations.ts` (v9), `test/cli.test.ts` (v9)

**Interfaces:**
- Consumes: `retrievals` (Task 1), `extractView` (src/extractPrompt.ts), `scrubText` (src/scrub.ts)
- Produces:
  - `EXTRACT_KINDS = ["cc", "cai", "cad", "cap", "mem"] as const` (artifacts `caa` are Claude's output and are not extracted)
  - `MAX_REQUEST_CHARS = 180_000` (about 80k tokens at 2.25 characters per token, plus about 3k for prompt and schema)
  - `recalledStatements(db): string[]`: the distinct `claims.statement` values joined through `retrievals`
  - `requestText(text: string, recalled: string[]): string`: `extractView`, then every recalled statement removed, then `scrubText(...).value`, trimmed. Validation (Task 5) checks quotes against this.
  - `interface RequestTurn { ref: string /* T1.. numbered over the whole source */; turnId: number; role: string; ts: string | null; text: string }`
  - `interface ExtractionRequest { customId: string /* s<sourceId>-c<n> */; sourceId: number; source: RenderableSource; turns: RequestTurn[]; chars: number }`
  - `selectForExtraction(db, opts?: {from?: string}): {sourceId: number; inputSha256: string; turns: RequestTurn[]}[]`
  - `cutRequests(sourceId: number, source: RenderableSource, turns: RequestTurn[], maxChars = MAX_REQUEST_CHARS): ExtractionRequest[]`
  - `markSubmitted(db, sourceId: number, inputSha256: string, jobId: number): void`; `forgetSubmitted(db, jobId: number, sourceIds?: number[]): void`

- [ ] **Step 1: Write the failing tests**

```ts
it("a second run with no new turns selects nothing", () => {
  const first = selectForExtraction(db);
  for (const s of first) markSubmitted(db, s.sourceId, s.inputSha256, 1);
  expect(selectForExtraction(db)).toEqual([]);
});
it("a changed turn selects its source again", () => { /* update one turn text → that source only */ });
it("leaves out excluded sources, caa sources, sidechains, tool turns and injected turns", () => { /* fixture with each; only the plain user/assistant turns of non-excluded sources appear */ });
it("no injected span or recalled claim reaches a request", () => {
  // retrievals holds clm_A whose statement is 'Kylian uses SQLite for the brain index.'
  // an assistant turn says 'As noted: Kylian uses SQLite for the brain index. Next step…'
  // a user turn holds '<system-reminder>secret ctx</system-reminder> real words'
  const text = cutRequests(...).flatMap((r) => r.turns.map((t) => t.text)).join("\n");
  expect(text).not.toContain("Kylian uses SQLite for the brain index.");
  expect(text).not.toContain("secret ctx");
  expect(text).toContain("real words");
});
it("scrubs again before the request", () => { /* a turn holding an sk-ant- key is masked */ });
it("no request goes over the limit; a long session splits on turn boundaries", () => {
  const reqs = cutRequests(1, src, fiftyTurnsOf(10_000), 100_000);
  expect(reqs.every((r) => r.chars <= 100_000)).toBe(true);
  expect(reqs.flatMap((r) => r.turns.map((t) => t.ref))).toEqual(refs(50)); // every turn once, in order
});
it("splits an oversized turn into pieces under the same ref", () => {
  const reqs = cutRequests(1, src, [turnOf(250_000)], 100_000);
  expect(reqs.length).toBe(3);
  expect(reqs.every((r) => r.turns[0]!.ref === "T1" && r.chars <= 100_000)).toBe(true);
  const squash = (s: string) => s.replace(/\s+/g, "");
  expect(squash(reqs.map((r) => r.turns[0]!.text).join(""))).toBe(squash(requestText(original, []))); // pieces cover the turn, cut at whitespace
});
it("--from keeps only sources updated on or after the date", () => {});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/extractInput.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Add migration 9 "extraction state"**

`extraction_state (source_id INTEGER PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE, input_sha256 TEXT NOT NULL, job_id INTEGER NOT NULL, submitted_at TEXT NOT NULL)`.

- [ ] **Step 4: Implement `src/extractInput.ts`**

- Selection: sources with `excluded = 0`, kind in `EXTRACT_KINDS`, and `updated_at >= from` when given. Eligible turns: `is_injected = 0`, `is_sidechain = 0`, `role <> 'tool'`, and a non-empty `requestText`, ordered by `ts, id`.
- `inputSha256` is the sha256 over the eligible turns' `id`, `\0` and `requestText`. A source is selected when it has no `extraction_state` row, or the row's `input_sha256` differs.
- Recalled statements come from `recalledStatements(db)`, read once per run.
- Cutting: turns are packed greedily in order. A turn's size is `text.length` plus 200 for its `<turn>` header. A turn larger than `maxChars` alone gets pieces of at most `maxChars - 200`, cut at the last whitespace, each in its own request.

- [ ] **Step 5: Run the tests and check they pass**

Run: `npx vitest run test/extractInput.test.ts test/cli.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/extractInput.ts src/migrations.ts test/extractInput.test.ts test/cli.test.ts
git commit -m "WP12: select, strip and cut extraction input"
```

---

### Task 3: Extractor: Haiku 5.5 batch submit and poll (WP13, #36)

**Files:**
- Create: `src/extractor.ts`, `test/extractor.test.ts`
- Modify: `src/extractPrompt.ts` (v2), `src/config.ts` (`anthropicApiKey`), `src/migrations.ts` (v10), `src/cli.ts` (`extract`), `test/cli.test.ts` (v10)

**Interfaces:**
- Consumes: `selectForExtraction`, `cutRequests`, `markSubmitted`, `forgetSubmitted` (Task 2); `EXTRACT_SYSTEM`, `ExtractionSchema`, `renderSource`, `EXTRACT_MODEL`, `EXTRACT_PROMPT_VERSION`
- Produces:
  - `anthropicApiKey(env = process.env): string` in `src/config.ts` (reads `$XDG_CONFIG_HOME/ai_second_brain/env`)
  - `interface BatchClient { create(requests: BatchRequest[]): Promise<{id: string}>; status(id: string): Promise<"in_progress" | "canceling" | "ended">; results(id: string): AsyncIterable<{custom_id: string; result: {type: "succeeded"; text: string} | {type: "errored" | "canceled" | "expired"}}>; countTokens(params: BatchRequest["params"]): Promise<number> }`
  - `anthropicBatchClient(apiKey: string): BatchClient`
  - `MAX_REQUEST_TOKENS = 97_000`
  - `submitExtraction(db, client: BatchClient, opts?: {from?: string}): Promise<{jobId: number | null; requests: number; sources: number; inputTokens: number}>`
  - `pollExtraction(db, client: BatchClient): Promise<{ended: number; running: number; candidates: number; failedRequests: number; inputTokens: number; outputTokens: number}>`. An ended job's token totals are saved in `jobs.payload.usage` as `{input_tokens, output_tokens}`. The `BatchClient.results` success variant also carries `usage: {input_tokens, output_tokens}`.
  - table `candidates`: `id INTEGER PK, job_id, custom_id, ord, source_id, claim_json, model, prompt, batch_id, state CHECK IN ('new','valid','dropped','merged','accepted','queued'), reason, similar_to, claim_id, UNIQUE (job_id, custom_id, ord)`. In `claim_json`, each evidence entry is `{ref, turn_id: number | null, quote}`, resolved from the job's ref map.

- [ ] **Step 1: Write the failing tests** (fake `BatchClient` that records `create` calls and serves canned results)

```ts
it("a batch over a fixture slice comes back as parsed candidate claims", async () => {
  const { jobId } = await submitExtraction(db, fake);
  fake.end(jobId, { "s1-c1": okText([claimFixture({ evidence: [{ turn: "T2", quote: "on part sur SQLite" }] })]) });
  expect((await pollExtraction(db, fake)).candidates).toBe(1);
  const c = db.prepare("SELECT * FROM candidates").get();
  expect(JSON.parse(c.claim_json).evidence[0]).toEqual({ ref: "T2", turn_id: turnIdOf("u2"), quote: "on part sur SQLite" });
});
it("stores prompt version, model and batch id on every candidate", () => {
  expect(rows.every((r) => r.prompt === "extract@v2" && r.model === "claude-haiku-5-5" && r.batch_id === "msgbatch_1")).toBe(true);
});
it("an interrupted poll resumes from jobs without resubmitting", async () => {
  fake.failResultsAfter(1); // the iterator throws after the first result
  await expect(pollExtraction(db, fake)).rejects.toThrow();
  expect(jobState()).toBe("running");
  fake.failResultsAfter(Infinity);
  await pollExtraction(db, fake);
  expect(fake.createCalls).toBe(1);
  expect(count("candidates")).toBe(2); // not 3
  expect(jobState()).toBe("done");
});
it("a source whose request errored is selected again next run", async () => {});
it("an unparsable result counts as failed, not as zero claims", async () => {});
it("re-cuts a request whose counted tokens pass MAX_REQUEST_TOKENS", async () => { /* fake countTokens returns 120k for the first cut → two requests sent */ });
it("does not submit while another extract job is running", async () => {});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/extractor.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Bump the prompt to `extract@v2` in `src/extractPrompt.ts`**

Add these rules to `EXTRACT_SYSTEM` to fix the #32 findings, and change nothing else:
- `Name the person "the user" in English statements and "l'utilisateur" in French ones, never by name.`
- `Skip facts that will not hold in a month: one game, build or purchase, a single bug, a one-off errand. A hobby or a recurring situation is context:<tag>, never project:<slug>; project: is for something the user builds or runs.`
- `When the time words give only a month or a year ("depuis mars", "in 2024", "last summer"), use that precision (month, year, approx); use day only when the day is known.`
- `In a conversation that mixes languages, write the statement in the language of the user turn you quote.`

- [ ] **Step 4: Add migration 10 "extraction jobs"**

`ALTER TABLE jobs ADD COLUMN payload TEXT` holds the JSON `{requests: {[customId]: {sourceId, refs: {[ref]: turnId}}}}`. Also create `candidates` as specified in the Interfaces block.

- [ ] **Step 5: Implement `src/extractor.ts` and `anthropicApiKey`**

- Each request's params: `model`, `max_tokens: 16000`, `system: EXTRACT_SYSTEM`, one user message `renderSource(...)`, and `output_config: {format: zodOutputFormat(ExtractionSchema), effort: "medium"}`.
- Before `create`, call `countTokens` once per request. Over `MAX_REQUEST_TOKENS`, re-cut that source with half the characters until it fits.
- Job lifecycle: `create` succeeds, then the `jobs` row is `type 'extract', state 'running'` with `batch_id` and `payload`, and `markSubmitted` runs for each source.
- In `pollExtraction`, an ended batch is read whole and inserted with `INSERT OR IGNORE`. The job is set to `done` with `finished_at` in the same transaction as the last insert. Sources with an errored, canceled, expired or unparsable request go through `forgetSubmitted`.

- [ ] **Step 6: Add `brain extract` in `src/cli.ts`**

- `brain extract [--from <date>] [--dry-run]` submits. `--dry-run` prints `<sources> sources, <requests> requests, <chars> characters, about <chars/2.25> tokens, about $<cost> batched` and submits nothing. Prices come from `scripts/check-extract.ts` (`0.1`/`0.5` per MTok, halved when batched).
- `brain extract poll [--wait]` polls once. `--wait` repeats every 60 s until no extract job is running. Each poll prints `Batch <id>: ended|in progress; <n> candidates, <f> failed requests`.
- Add both lines to `USAGE`.

- [ ] **Step 7: Run the tests and check they pass**

Run: `npx vitest run test/extractor.test.ts test/cli.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/extractor.ts src/extractPrompt.ts src/config.ts src/migrations.ts src/cli.ts test/extractor.test.ts test/cli.test.ts
git commit -m "WP13: Haiku 5.5 batch extraction with resumable polling"
```

---

### Task 4: Check #33: Batch API cost and turnaround on a real week (owner)

This task spends API credit and posts to GitHub. The owner runs it or approves each command.

- [ ] **Step 1: Dry run on the last seven days**

Run: `npm run brain -- extract --from <today − 7 days> --dry-run`
Expected: one line with sources, requests, characters, an estimated token count and an estimated cost.

- [ ] **Step 2: Submit and wait**

Run: `npm run brain -- extract --from <same date> && npm run brain -- extract poll --wait`
Expected: `Batch msgbatch_…: ended; <n> candidates, 0 failed requests`.

- [ ] **Step 3: Record the result in #33**

Take input and output tokens from `jobs.payload.usage`. Take the turnaround from `jobs.started_at` to `finished_at`. Project the monthly cost at the current ingest rate: (week's cost) × 4.3, plus nothing for consolidation in Phase 1. Write a short result comment in the style of #32 and show it to the owner before posting. Leave the candidates in place: Tasks 5–7 validate, deduplicate and route them.

---

### Task 5: Validation: quotes, origin, scope, valid time (WP14, #37)

**Files:**
- Create: `src/validate.ts`, `test/validate.test.ts`
- Modify: `src/cli.ts` (`extract poll` runs validation after polling)

**Interfaces:**
- Consumes: `candidates` (Task 3), `requestText`, `recalledStatements` (Task 2), `ExtractedClaim`
- Produces:
  - `type DropReason = "no_evidence" | "unknown_turn" | "quote_not_verbatim" | "personality" | "bad_scope" | "bad_kind_fields"`
  - `resolveValidFrom(expression: string | null, turnTs: string, model: {valid_from: string | null; precision: Precision}): {valid_from: string | null; valid_from_precision: Precision}`
  - `checkOrigin(claimOrigin: Origin, cited: {role: string; ts: string | null; inPasted: boolean; sourceKind: string}[]): Origin`
  - `validateCandidates(db): {kept: number; corrected: Record<string, number>; dropped: Record<DropReason, number>}`. A kept candidate becomes `state 'valid'`. Its `claim_json` is rewritten into vault evidence form (`{source: "<kind>:<external_id>", turn: <external_uuid>, quote, quote_sha256, turn_id}`) with the resolved times and origin. A dropped candidate gets `state 'dropped'` and `reason`.
  - `formatValidation(r): string`, for example `Validated 38: kept 31 (origin corrected 3, quote whitespace fixed 2); dropped 7 (quote_not_verbatim 4, personality 2, unknown_turn 1)`

- [ ] **Step 1: Write the failing tests**

```ts
it("drops a planted fake quote, a personality inference, and corrects a mislabelled origin", () => {
  const r = validateCandidates(db); // fixture: one quote not in its turn; 'L'utilisateur est perfectionniste et anxieux'; user_stated citing only an assistant turn
  expect(r.dropped).toMatchObject({ quote_not_verbatim: 1, personality: 1 });
  expect(origin("c3")).toBe("ai_suggested");
});
it("accepts a quote that differs only by whitespace and stores the turn's exact text", () => {});
it("drops a translated quote", () => { /* French turn, English quote */ });
it.each([
  ["since March", "2026-10-14T09:00:00Z", "2026-03", "month"],
  ["depuis mars", "2026-10-14T09:00:00Z", "2026-03", "month"],
  ["since November", "2026-10-14T09:00:00Z", "2025-11", "month"],
  ["depuis 2024", "2026-10-14T09:00:00Z", "2024", "year"],
  ["last year", "2026-10-14T09:00:00Z", "2025", "year"],
  ["le mois dernier", "2026-10-14T09:00:00Z", "2026-09", "month"],
  ["yesterday", "2026-10-14T09:00:00Z", "2026-10-13", "day"],
  ["la semaine dernière", "2026-10-14T09:00:00Z", "2026-10-07", "approx"],
])("resolves %s in a message of %s to %s, precision %s", (expr, ts, from, precision) => {
  expect(resolveValidFrom(expr, ts, { valid_from: null, precision: "unknown" })).toEqual({ valid_from: from, valid_from_precision: precision });
});
it("keeps the model's date only when it is well formed and not after the turn", () => {});
it.each([
  ["user_stated", [{ role: "assistant" }], "ai_suggested"],
  ["user_confirmed", [{ role: "assistant", ts: "2026-10-14T09:00:00Z" }, { role: "user", ts: "2026-10-14T09:01:00Z" }], "user_confirmed"],
  ["user_confirmed", [{ role: "assistant" }], "ai_suggested"],
  ["user_confirmed", [{ role: "user" }], "user_stated"],
  ["user_stated", [{ role: "user", inPasted: true }], "external_doc"],
  ["user_stated", [{ role: "memory", sourceKind: "mem" }], "imported_memory"],
  ["user_stated", [{ role: "user", sourceKind: "cap" }], "external_doc"],
])("origin %s citing %j becomes %s", () => {});
it("drops a bad scope and decision fields on a non-decision", () => {});
it("counts drops by reason in the run summary", () => { expect(formatValidation(r)).toMatch(/dropped 2 \(quote_not_verbatim 1, personality 1\)/); });
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/validate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/validate.ts`**

- Quote check: the quote must be in `requestText(turn.text, recalledStatements(db))`, the text the model was sent. If it is not, a match that differs only in whitespace is accepted: the quote's words joined by `\s+`, regex-escaped, and the quote is replaced by the matched span. Anything else is `quote_not_verbatim`.
- `inPasted`: the quote's position falls inside a `<pasted_content …>…</pasted_content>` span, or after an `[attachment …]` line.
- `user_confirmed` requires a cited user turn whose `ts` is later than a cited assistant turn.
- Personality: drop when the statement matches any of these (case-insensitive), as `PERSONALITY_PATTERNS`: `/\b(personality|personnalité|anxious|anxieu[xs]e?|insecure|narciss\w*|perfectionnist\w*|perfectionist\w*|introvert\w*|extravert\w*|extrovert\w*|tends to|a tendance à|is the kind of person|est quelqu'un de|struggles with (?:self|confidence)|manque de confiance)\b/i`
- Scope: must match `/^(global|project:[a-z0-9][a-z0-9-]*|context:[a-z0-9][a-z0-9-]*)$/` after lowercasing.
- Time resolution, when `expression` names a month or year:
  - A month name (fr and en) gives the latest such month at or before the turn's month.
  - `since|depuis|en|in <YYYY>` gives that year.
  - `last year|l'an dernier|l'année dernière` gives the year before.
  - `last month|le mois dernier` gives the month before.
  - `yesterday|hier` gives the day before.
  - `last week|la semaine dernière` gives the turn date − 7 days, `approx`.
  - Otherwise the model's value is kept if it is well formed and not after the turn, else `null`/`unknown`.
- In `src/cli.ts`, `brain extract poll` runs `validateCandidates` after polling and prints `formatValidation`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run test/validate.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts src/cli.ts test/validate.test.ts
git commit -m "WP14: validate quotes, origin, scope and valid time"
```

---

### Task 6: Deduplication: merge evidence into existing claims (WP15, #38)

**Files:**
- Create: `src/dedup.ts`, `test/dedup.test.ts`
- Modify: `src/cli.ts` (`extract poll` runs dedup after validation)

**Interfaces:**
- Consumes: `valid` candidates (Task 5), `Vault`, `syncClaims`, `statementKey`, `appendLog` (Task 1), `Embedder`
- Produces:
  - `MERGE_SIMILARITY = 0.93`, `SIMILAR_SIMILARITY = 0.85`, `MERGE_OVERLAP = 0.5` (initial values; Step 4 calibrates them)
  - `sameFact(a: string, b: string, cosine: number): "merge" | "similar" | "different"`. It returns `merge` when the statement keys are equal, or when cosine ≥ MERGE_SIMILARITY, the distinctive tokens are equal and content-word Jaccard ≥ MERGE_OVERLAP. It returns `similar` when cosine ≥ SIMILAR_SIMILARITY and the distinctive tokens are equal. Otherwise `different`. Distinctive tokens are words holding a digit, a capital letter not at the start of the sentence, or one of `._/-` inside the word. Content words are the remaining words of three letters or more that are not in the FR/EN function-word sets of `src/enrich.ts` (export them).
  - `dedupCandidates(db, vault: Vault, embedder: Embedder | null): {merged: {intoClaims: number; intoProposals: number; intoCandidates: number}; similar: number; evidenceSkipped: number; exactOnly: boolean}`. A `similar` candidate stays `valid` with `similar_to = <claim id>`, which Task 7 queues.
  - `addEvidence(target: Claim, evidence: Claim["evidence"]): {claim: Claim; added: number}`: skips entries already present (same `source`, `turn`, `quote_sha256`)

- [ ] **Step 1: Write the failing tests** (VectorEmbedder with chosen vectors)

```ts
it("the same fact stated in three sessions gives one claim with three evidence entries", async () => {
  // three valid candidates from s1, s2, s3: 'L'utilisateur a choisi SQLite pour l'index du brain.' / '…utilise SQLite pour l'index du brain.' / '…garde SQLite pour l'index du brain.'
  // cosines 0.95; then routeCandidates is NOT run here: assert on candidates
  await dedupCandidates(db, vault, emb);
  expect(states()).toEqual({ valid: 1, merged: 2 });
  expect(evidenceOf(validOne()).map((e) => e.source)).toEqual(["cc:s1", "cc:s2", "cc:s3"]);
});
it("two different facts with similar wording stay two claims", async () => {
  // 'L'utilisateur utilise SQLite pour l'index.' vs '…utilise Postgres pour l'index.' at cosine 0.96 → both valid, no similar_to
});
it("a near fact with no distinctive difference is marked similar, not merged", async () => {
  // 'The user prefers dark mode in the editor.' vs 'The user prefers light mode in the editor.' at cosine 0.92 → similar_to set
});
it("merges into an active claim in the same scope and commits the new evidence", async () => {
  // claim in vault; candidate from s9 → file has 2 evidence entries; HEAD message 'evidence clm_… from cc:s9'; log action add_evidence
});
it("never merges across scopes", async () => {});
it("merges into an open proposal's claim_json", async () => {});
it("re-extraction adds no evidence twice", async () => { /* same candidate run twice → evidenceSkipped 1, file unchanged, no new commit */ });
it("embedder down: exact statement match only, nothing marked similar", async () => {
  const r = await dedupCandidates(db, vault, failingEmbedder);
  expect(r.exactOnly).toBe(true);
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/dedup.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/dedup.ts`**

- Run `syncClaims` first, so Obsidian edits count.
- Candidates are processed in `id` order. Each one is compared, in this order, with: active claims in the same scope (top 10 by `claims_vec` cosine plus exact `statementKey`), open proposals in the same scope (exact key, plus cosine against their embedded statement, computed on the fly), and the valid candidates already kept in this run.
- The first `merge` wins.
- A merge into a claim writes the file and commits with `evidence <id> from <source refs>`, then logs `add_evidence` with actor `extractor`.

- [ ] **Step 4: Calibrate on the real model** (needs Ollama running)

Run: `npx tsx -e` with a one-off script that embeds the five fixture pairs above through `OllamaEmbedder` and prints their cosines. Do not commit the script.
Expected: same-fact pairs ≥ `MERGE_SIMILARITY`, and the dark/light pair in `[SIMILAR_SIMILARITY, MERGE_SIMILARITY)`. If a pair lands on the wrong side, move the constant. Write the measured values in a comment above the constants, the way `CHUNK_CHARS` records its measurement.

- [ ] **Step 5: Run the tests and check they pass**

Run: `npx vitest run test/dedup.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dedup.ts src/enrich.ts src/cli.ts test/dedup.test.ts
git commit -m "WP15: merge duplicate candidates into claims, proposals and each other"
```

---

### Task 7: Routing and vault writer: auto-accept, proposals, git (WP16, #39)

**Files:**
- Create: `src/route.ts`, `test/route.test.ts`
- Modify: `src/cli.ts` (`extract poll` routes after dedup and expires old proposals)

**Interfaces:**
- Consumes: `valid` candidates with optional `similar_to` (Task 6); `Vault`, `appendLog`, `ulid`, `statementKey`, `syncClaims` (Task 1)
- Produces:
  - `AUTO_ORIGINS = ["user_stated", "user_confirmed"] as const`, `PROPOSAL_DAYS = 30`, `AUDIT_SHARE = 0.1`
  - `routeFor(c: {origin: Origin; sensitivity: string; kind: string; similar_to: string | null}): {auto: true} | {auto: false; reason: string}`. Reasons: `origin:<origin>`, `decision`, `sensitive`, `similar:<claim id>`. The first that applies wins, in that order.
  - `isAuditPick(claimId: string): boolean`: the first 8 hex digits of `sha256(claimId)`, as an integer mod 10, equal 0
  - `routeCandidates(db, vault: Vault, now = new Date()): {accepted: number; queued: number; audits: number; previouslyRejected: number}`
  - `expireProposals(db, vault: Vault, now = new Date()): number`
  - Accepted claims get `review: auto_accepted`, `status: active`, `recorded_at: now`, `extractor: {model, prompt, batch}` from the candidate. Commit message: `accept <id> from <source refs, comma-separated>: <statement cut to 72 chars>`.
  - Queued proposals get `id: prp_<ulid>`, `kind: decision | claim`, `claim_json` (claim with reserved id, `status: proposed`, `review: pending`), `statement_key`, `expires_at = now + 30 days`, `state: open`. Actor `extractor`, action `propose`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(ORIGINS)("origin %s: auto-accepted only if user_stated or user_confirmed", (origin) => {
  for (const sensitivity of ["normal", "sensitive"]) for (const kind of CLAIM_KINDS) for (const similar_to of [null, "clm_X"]) {
    const r = routeFor({ origin, sensitivity, kind, similar_to });
    expect(r.auto).toBe(AUTO_ORIGINS.includes(origin) && sensitivity === "normal" && kind !== "decision" && similar_to === null);
  }
});
it("every decision and every sensitive claim is queued", () => {});
it("each accepted claim is one git commit naming its source", () => {
  routeCandidates(db, vault, NOW); // two auto candidates from cc:s1 and cai:c2
  expect(gitLog(vault)).toEqual([expect.stringMatching(/^accept clm_\w+ from cai:c2: /), expect.stringMatching(/^accept clm_\w+ from cc:s1: /)]);
  expect(claimRow(db, idOf("cc:s1"))?.review).toBe("auto_accepted");
});
it("a statement once rejected is never proposed again", () => { /* proposals row state rejected with the same statement_key → candidate dropped reason previously_rejected, no new proposal */ });
it("an imported memory is queued once on first import", () => { /* second identical mem candidate → merged into the open proposal by Task 6, or dropped here if the proposal was decided */ });
it("about 10% of auto-accepted claims get an audit proposal", () => { /* isAuditPick over 1000 ulids → between 70 and 130 */ });
it("proposals unreviewed after 30 days expire and leave the inbox", () => {
  expect(expireProposals(db, vault, addDays(NOW, 31))).toBe(1);
});
it("routing is idempotent: candidates already routed are not routed again", () => {});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/route.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/route.ts`**

- A candidate is first checked against any `proposals.statement_key` with `state = 'rejected'`. A match gets `dropped` with `previously_rejected`.
- An auto claim is written and committed, then its `claims` row is synced. If the process dies between the two, the next `syncClaims` closes the gap.
- When `isAuditPick` holds, an `audit` proposal is opened with `claim_id`, reason `audit`.
- In `src/cli.ts`, `brain extract poll` now runs validate → dedup → route → expire and prints `Routed: <a> auto-accepted, <q> queued (<audits> for audit), <r> previously rejected`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run test/route.test.ts && npx vitest run && npm run typecheck`
Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add src/route.ts src/cli.ts test/route.test.ts
git commit -m "WP16: auto-accept policy, proposals, audit picks and expiry"
```

---

### Task 8: `brain review`: keyboard triage in the terminal (WP17, #40)

**Files:**
- Create: `src/review.ts`, `test/review.test.ts`
- Modify: `src/cli.ts` (`review`)

**Interfaces:**
- Consumes: `proposals`, `Vault`, `appendLog`, `addEvidence` (Task 6), `syncClaims`, `expireProposals`, `openEvidence` (src/mcp.ts)
- Produces:
  - `type Action = "accept" | "edit" | "merge" | "reject" | "snooze"`; keys `a e m r s`, plus `o` (show the evidence turn in context, no effect) and `q` (quit)
  - `SNOOZE_DAYS = 7`
  - `inbox(db, now: Date, opts?: {audit?: boolean}): Proposal[]`: open, not snoozed past `now`, oldest first
  - `formatCard(db, p: Proposal): string`, at most 20 lines: statement; `origin · scope · valid_from (precision)[ → valid_to]`; `queued: <reason>`; each quote cut to 300 chars with `turn <turn_id> (<source>)`; `similar to <id>: <statement>` when set
  - `resolveProposal(db, vault: Vault, id: string, action: Action, opts: {statement?: string; mergeInto?: string; shownAt: Date; now: Date}): void`
  - `reviewStats(db): {week: string /* 2026-W43 */; decided: number; rejectionRate: number; medianSeconds: number}[]`
  - `runReview(db, vault, io: {keys: AsyncIterator<string>; ask(prompt: string, initial: string): Promise<string>; write(s: string): void}, now: () => Date, opts?: {audit?: boolean}): Promise<{decided: number}>`

| Key | Claim/decision proposal | Audit proposal |
| --- | --- | --- |
| `a` | file written with `review: approved`, `status: active`, `reviewed_at`; commit `approve <id> from <sources>`; state `accepted` | claim unchanged; log `audit_ok`; state `accepted` |
| `e` | `ask` with the statement prefilled; file written with `review: edited`, `status: active`; commit `edit <id> …`; state `edited` | statement edited in the claim file, `review: edited`; state `edited` |
| `m` | target = `similar_to`, else `ask` for a claim id; `addEvidence` into the target, commit `evidence <target> from <sources>`; state `merged` | not offered |
| `r` | `review: rejected`, nothing written to the vault; `statement_key` kept on the row; state `rejected` | claim file `status: retracted`, `review: rejected`; commit `retract <id>`; state `rejected` |
| `s` | `snoozed_until = now + 7 days`; state stays `open` | same |

Every action sets `decided_at` and `decision_ms = now − shownAt` (except `s`) and logs with actor `user`, action = the action name.

- [ ] **Step 1: Write the failing tests**

```ts
it.each(["accept", "edit", "merge", "reject", "snooze"] as const)("%s has its SPEC effect and is logged", (action) => { /* assert file/frontmatter, proposal state, git HEAD message, log row */ });
it("audit: reject retracts the claim, accept leaves it unchanged", () => {});
it("a card fits on one screen", () => { expect(formatCard(db, longProposal()).split("\n").length).toBeLessThanOrEqual(20); });
it("the key loop triages a scripted session", async () => {
  const r = await runReview(db, vault, scripted(["a", "r", "s", "e", "q"], { ask: ["Reworded."] }), clock);
  expect(r.decided).toBe(3);
});
it("--stats reports rejection rate and median decision time per week", () => {
  expect(reviewStats(db)).toEqual([{ week: "2026-W43", decided: 4, rejectionRate: 0.25, medianSeconds: 6 }]);
});
it("a snoozed item comes back after 7 days", () => {});
it("an expired item does not show", () => {});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/review.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/review.ts` and `brain review [--stats] [--audit]` in `src/cli.ts`**

- `brain review` runs `syncClaims` and `expireProposals` first.
- The terminal `io` uses `process.stdin.setRawMode(true)` for single keys and `readline` with `rl.write(initial)` for `ask`.
- With an empty inbox it prints `Inbox empty.`.
- `--stats` prints one line per week: `2026-W43: 12 decided, rejection rate 17%, median 9.5 s`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run test/review.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Ten real items in about two minutes (owner)**

The owner triages ten real items from Task 4's run with `npm run brain -- review`, then runs `npm run brain -- review --stats`.
Expected: the median is 12 s or less. If it is slower, note which card line slowed the owner down and shorten it.

- [ ] **Step 6: Commit**

```bash
git add src/review.ts src/cli.ts test/review.test.ts
git commit -m "WP17: brain review keyboard triage and weekly stats"
```

---

### Task 9: Local MCP: `recall` and `brief` (WP18, #41)

**Files:**
- Create: `src/recall.ts`, `test/recall.test.ts`
- Modify: `src/mcp.ts` (register both tools), `src/enrich.ts` (tag, `ENRICH_VERSION = "enrich@2"`), `test/mcp.test.ts`, `test/claudeCode.test.ts`, `docs/mcp.md`

**Interfaces:**
- Consumes: `claims`, `claims_fts`, `claims_vec`, `retrievals` (Task 1); `RRF_K`, `ftsQuery` (src/search.ts)
- Produces:
  - `CLAIMS_TAG = "brain-claims"`. Every `recall`/`brief` result is wrapped in `<brain-claims>…</brain-claims>`, and `"brain-claims"` joins `INJECTED_TAGS`.
  - `interface ClaimHit { id; statement; kind; scope; origin; status; valid_from; valid_from_precision; valid_to; as_of /* valid_from, else date of recorded_at */; evidence: {source; turn_id: number | null}[] }`
  - `recall(db, embedder: Embedder | null, opts: {query: string; scope?: string; as_of?: string; include_superseded?: boolean; limit?: number /* 8, max 20 */}): Promise<{hits: ClaimHit[]; meaningError?: string}>`
  - `brief(db, opts: {scope?: string; budget_tokens?: number /* 1500, 200..4000 */}): string`
  - `logRetrievals(db, ids: string[], client: string, now?: Date): void`
  - `BRIEF_CHARS_PER_TOKEN = 2.25`

- [ ] **Step 1: Write the failing tests**

```ts
it("recall ranks by RRF over keyword and meaning, filtered by scope (scope or global)", async () => {});
it("hides superseded claims unless include_superseded or as_of asks", async () => {
  // A (SQLite, valid_from 2026-03, superseded, valid_to 2026-09) → B (Postgres, active)
  expect(ids(await recall(db, emb, { query: "index database" }))).toEqual(["B"]);
  expect(ids(await recall(db, emb, { query: "index database", as_of: "2026-05" }))).toEqual(["A"]);
});
it("never returns proposed, retracted, rejected or expired claims", async () => {});
it("recall without embedder answers by keyword with a note", async () => {});
it("brief holds profile, project claims and open decisions with as_of dates, under budget", () => {
  const text = brief(db, { scope: "project:ai-brain", budget_tokens: 300 });
  expect(text.length).toBeLessThanOrEqual(300 * 2.25 + "<brain-claims>\n\n</brain-claims>".length);
  expect(text).toMatch(/\(as of 2026-10\)/);
});
it("every served claim is logged in retrievals", async () => { /* via the MCP client: call recall, brief → retrievals rows with client 'test' */ });
it("results stay under RESULT_CHARS at limit 20 with 1000-char statements", async () => {});

// test/claudeCode.test.ts
it("a tool result holding recall output is flagged injected on the next ingest", () => {
  // transcript fixture: assistant tool_use mcp__brain__recall, then a user line whose tool_result text is '<brain-claims>…</brain-claims>'
  expect(turnByRole("tool").isInjected).toBe(true);
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/recall.test.ts test/mcp.test.ts test/claudeCode.test.ts`
Expected: FAIL, module not found and the injected assertion fails.

- [ ] **Step 3: Implement `src/recall.ts`, register the tools, and add the tag**

- `recall` filters:
  - status `active` by default.
  - With `include_superseded`: `active` or `superseded`.
  - With `as_of`: `valid_from ≤ as_of` (null counts as before), `valid_to` null or `> as_of`, status `active` or `superseded`.
  - A scope matches the claim's own scope, or `global`.
- `brief` sections, in order, each newest `recorded_at` first; it stops at the first line that would pass the budget:
  - `Profile` (global `profile`/`preference`)
  - `Project <scope>` (`project_fact`/`procedure`/`lesson` in scope)
  - `Open decisions` (active `decision` in scope or global)
  - Each line reads `- <statement> (as of <as_of>, <origin>)`.
- MCP tool descriptions name the as-of semantics. The `client` in retrievals is the MCP `clientInfo.name` from initialize, or `unknown`.
- Bumping `ENRICH_VERSION` re-parses every source on the next ingest: expected, and it says so in the commit message.
- Add both tools to `docs/mcp.md`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (full suite).

- [ ] **Step 5: Answer from Claude Code (manual)**

Run: `npm run build`, then in a Claude Code session with the `brain` server registered, ask "what do you know about my brain project?".
Expected: Claude calls `brief` or `recall`, the answer cites claims with `as of` dates, and `SELECT count(*) FROM retrievals` grows. After `brain ingest ~/.claude/projects`, that session's tool turn holding the result has `is_injected = 1`.

- [ ] **Step 6: Commit**

```bash
git add src/recall.ts src/mcp.ts src/enrich.ts docs/mcp.md test/recall.test.ts test/mcp.test.ts test/claudeCode.test.ts
git commit -m "WP18: recall and brief over claims; recalled text flagged injected (enrich@2 re-parses every source)"
```

---

### Task 10: Phase 1 gate: precision audit and claims arm (WP19, #42)

**Files:**
- Create: `src/audit.ts`, `test/audit.test.ts`
- Modify: `src/eval.ts` (arm C, `arms` option, report columns), `src/migrations.ts` (v11), `src/cli.ts` (`audit`, `eval run --arms`), `test/eval.test.ts`, `test/cli.test.ts` (v11), `docs/eval.md`

**Interfaces:**
- Consumes: `proposals` kind `audit` and the `a`/`r` audit actions (Task 8); `runEval`, `evalReport` (src/eval.ts)
- Produces:
  - `sampleAudit(db, vault: Vault, n = 50, now?: Date): number`: opens `audit` proposals for `n` auto-accepted, active claims that have never been audited, picked in `sha256("audit:" + id)` order
  - `auditReport(db): {judged: number; kept: number; retracted: number; precision: number | null; aiAutoAccepted: number}`. `aiAutoAccepted` counts claims with `review = 'auto_accepted'` and an origin outside `AUTO_ORIGINS`; it must be 0.
  - Migration 11 rebuilds `eval_results` with `arm CHECK IN ('A','B','C')` (`rebuildsTables: true`).
  - `RunOptions.arms?: ("B" | "C")[]` (default `["B"]`, so `brain eval run` keeps its current behaviour). Arm C runs `claude -p` with the same `ISOLATION` and only `mcp__brain__recall` and `mcp__brain__brief`.
  - `evalReport` adds an `armC` tally per category, and `formatEvalReport` adds an `arm C` column next to `arm B` when a run has arm C results.

- [ ] **Step 1: Write the failing tests**

```ts
it("samples 50 auto-accepted claims never audited before", () => { expect(sampleAudit(db, vault, 50)).toBe(50); expect(sampleAudit(db, vault, 50)).toBe(rest); });
it("precision is kept over judged", () => { expect(auditReport(db)).toMatchObject({ judged: 50, kept: 42, retracted: 8, precision: 0.84 }); });
it("counts AI-origin claims that were auto-accepted", () => { /* one planted row → aiAutoAccepted 1 */ });
it("arm C runs with recall and brief only", async () => { /* runner sees --allowedTools 'mcp__brain__recall mcp__brain__brief' */ });
it("brain eval run without --arms runs arm B only", async () => {});
it("the report compares arms B and C per category", () => {});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npx vitest run test/audit.test.ts test/eval.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Commands: `brain audit sample [--n 50]` prints `Opened <n> audit items; triage them with: brain review --audit`. `brain audit report` prints `Write precision: <kept>/<judged> (<pct>); AI-origin claims auto-accepted: <n>`.
- `brain eval run --arms B,C`.
- Update `docs/eval.md`: arm C, the audit, and the Phase 1 gate as the roadmap states it ("write precision of 80% or more on a sampled audit; zero AI-suggested claims auto-accepted"), with the B vs C per-category comparison reported for the owner's decision.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts src/eval.ts src/migrations.ts src/cli.ts test/audit.test.ts test/eval.test.ts test/cli.test.ts docs/eval.md
git commit -m "WP19: precision audit and claims arm in brain eval"
```

- [ ] **Step 6: Run the gate (owner, spends API credit)**

1. `brain extract`, then `brain extract poll --wait`, over the whole corpus. #32 projected about $0.45.
2. `brain audit sample`, then `brain review --audit` on the 50 items, then `brain audit report`.
   Expected: precision ≥ 0.80 and `AI-origin claims auto-accepted: 0`.
3. `brain index --claims`, then `brain eval run --arms B,C`, then `brain eval report --details`. Check the C verdicts by hand with `brain eval verify`.
4. Draft the gate result for #42 (precision, zero-AI count, B vs C per category, decision). Show it to the owner before posting.
