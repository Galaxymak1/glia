import { beforeEach, describe, expect, it } from "vitest";
import { syncClaims } from "../src/claimIndex.js";
import { openDb } from "../src/db.js";
import {
  cutRequests,
  forgetSubmitted,
  markSubmitted,
  MAX_REQUEST_CHARS,
  recalledStatements,
  requestText,
  type RequestTurn,
  selectForExtraction,
} from "../src/extractInput.js";
import { migrate } from "../src/migrations.js";
import { scopeForSource } from "../src/projects.js";
import { type SourceRow, type TurnRow, writeSource } from "../src/sources.js";
import { Vault } from "../src/vault.js";
import { claimFixture, tmpDir } from "./helpers.js";

let db: ReturnType<typeof openDb>;

const turn = (externalUuid: string, role: string, text: string, ts: string, extra: Partial<TurnRow> = {}): TurnRow => ({
  externalUuid,
  parentUuid: null,
  role,
  ts,
  text,
  isSidechain: false,
  isInjected: false,
  ...extra,
});
const source = (kind: SourceRow["kind"], external_id: string, turns: TurnRow[], over: Partial<SourceRow> = {}) => {
  writeSource(
    db,
    { kind, external_id, title: `title ${external_id}`, project_hint: null, cwd: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-10T00:00:00Z", raw_path: "raw", raw_sha256: "abc", parser_version: "test", ...over },
    turns,
  );
  return (db.prepare("SELECT id FROM sources WHERE kind = ? AND external_id = ?").get(kind, external_id) as { id: number }).id;
};
const src = { kind: "cc", title: "t", created_at: null };
const turnsOf = (n: number, chars: number): RequestTurn[] =>
  Array.from({ length: n }, (_, i) => ({ ref: `T${i + 1}`, turnId: i + 1, role: "user", ts: null, text: `${"mot ".repeat(chars / 4 - 1)}fin` }));

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});

describe("selectForExtraction", () => {
  it("scopes a source as the SessionStart hook will brief it: by its folder's git remote first", () => {
    const cwd = "/home/me/dev/ai_second_brain";
    source("cc", "s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")], { cwd });
    const gitRemote = (dir: string) => (dir === cwd ? "git@github.com:me/glia.git" : null);
    const [picked] = selectForExtraction(db, { gitRemote });
    expect(picked!.source.scope).toBe("project:glia");
    const briefed = scopeForSource({ cwd, git_remote: gitRemote(cwd), project_hint: null }, { claudeCode: { exclude: [] } });
    expect(picked!.source.scope).toBe(briefed);
    // A folder that is gone, or not a repository: its name.
    expect(selectForExtraction(db, { gitRemote: () => null })[0]!.source.scope).toBe("project:ai-second-brain");
  });

  it("a second run with no new turns selects nothing", () => {
    source("cc", "s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    source("cai", "c1", [turn("h1", "user", "Je préfère le thé.", "2026-10-02T09:00:00Z")]);
    const first = selectForExtraction(db);
    expect(first).toHaveLength(2);
    for (const s of first) markSubmitted(db, s.sourceId, s.inputSha256, 1);
    expect(selectForExtraction(db)).toEqual([]);
  });

  it("a changed turn selects its source again, and only it", () => {
    const s1 = source("cc", "s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    source("cc", "s2", [turn("u2", "user", "Autre chose.", "2026-10-01T09:00:00Z")]);
    for (const s of selectForExtraction(db)) markSubmitted(db, s.sourceId, s.inputSha256, 1);
    source("cc", "s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z"), turn("u3", "user", "Et sur Hono.", "2026-10-01T10:00:00Z")]);
    expect(selectForExtraction(db).map((s) => s.sourceId)).toEqual([s1]);
  });

  it("forgetting a job's sources selects them again", () => {
    source("cc", "s1", [turn("u1", "user", "On part sur SQLite.", "2026-10-01T09:00:00Z")]);
    for (const s of selectForExtraction(db)) markSubmitted(db, s.sourceId, s.inputSha256, 7);
    forgetSubmitted(db, 7);
    expect(selectForExtraction(db)).toHaveLength(1);
  });

  it("leaves out excluded and artifact sources, sidechains, tool turns and injected turns", () => {
    const s = source("cc", "s1", [
      turn("u1", "user", "Plain user words.", "2026-10-01T09:00:00Z"),
      turn("a1", "assistant", "Plain assistant words.", "2026-10-01T09:00:01Z"),
      turn("t1", "tool", "tool output", "2026-10-01T09:00:02Z"),
      turn("x1", "user", "sidechain words", "2026-10-01T09:00:03Z", { isSidechain: true }),
      turn("i1", "user", "<system-reminder>ctx</system-reminder>", "2026-10-01T09:00:04Z", { isInjected: true }),
    ]);
    source("caa", "art1", [turn("z1", "assistant", "An artifact.", "2026-10-01T09:00:00Z")]);
    const ex = source("cc", "s9", [turn("e1", "user", "Excluded words.", "2026-10-01T09:00:00Z")]);
    db.prepare("UPDATE sources SET excluded = 1 WHERE id = ?").run(ex);
    const picked = selectForExtraction(db);
    expect(picked.map((p) => p.sourceId)).toEqual([s]);
    expect(picked[0]!.turns.map((t) => [t.ref, t.text])).toEqual([
      ["T1", "Plain user words."],
      ["T2", "Plain assistant words."],
    ]);
  });

  it("--from keeps only sources updated on or after the date", () => {
    source("cc", "old", [turn("u1", "user", "Old words.", "2026-09-01T09:00:00Z")], { updated_at: "2026-09-01T09:00:00Z" });
    const recent = source("cc", "new", [turn("u2", "user", "New words.", "2026-10-20T09:00:00Z")], { updated_at: "2026-10-20T09:00:00Z" });
    expect(selectForExtraction(db, { from: "2026-10-19" }).map((s) => s.sourceId)).toEqual([recent]);
  });
});

describe("request text", () => {
  it("no injected span or recalled claim reaches a request", async () => {
    const vault = new Vault(tmpDir("brain-vault-"));
    vault.writeClaim(claimFixture({ id: "clm_A", statement: "Kylian uses SQLite for the brain index." }), "a");
    await syncClaims(db, vault, null);
    db.prepare("INSERT INTO retrievals (claim_id, client, session_ref, ts) VALUES ('clm_A', 'claude-code', NULL, '2026-10-01T00:00:00Z')").run();
    source("cc", "s1", [
      turn("u1", "user", "<system-reminder>secret ctx</system-reminder> real words", "2026-10-01T09:00:00Z"),
      turn("a1", "assistant", "As noted: Kylian uses SQLite for the brain index. Next step is the parser.", "2026-10-01T09:00:01Z"),
    ]);
    expect(recalledStatements(db)).toEqual(["Kylian uses SQLite for the brain index."]);
    const [s] = selectForExtraction(db);
    const text = cutRequests(s!.sourceId, s!.source, s!.turns).flatMap((r) => r.turns.map((t) => t.text)).join("\n");
    expect(text).not.toContain("Kylian uses SQLite for the brain index.");
    expect(text).not.toContain("secret ctx");
    expect(text).toContain("real words");
    expect(text).toContain("Next step is the parser.");
  });

  it("scrubs again before the request", () => {
    const key = "sk-ant-" + "api03-" + "A1b2".repeat(20);
    expect(requestText(`my key is ${key} ok`, [])).not.toContain(key);
  });

  it("a turn that is only a recalled statement is left out", async () => {
    expect(requestText("  Kylian uses SQLite.  ", ["Kylian uses SQLite."])).toBe("");
  });
});

describe("cutRequests", () => {
  it("no request goes over the limit; a long session splits on turn boundaries", () => {
    const reqs = cutRequests(1, src, turnsOf(50, 10_000), 100_000);
    expect(reqs.length).toBeGreaterThan(1);
    expect(reqs.every((r) => r.chars <= 100_000)).toBe(true);
    expect(reqs.flatMap((r) => r.turns.map((t) => t.ref))).toEqual(Array.from({ length: 50 }, (_, i) => `T${i + 1}`));
    expect(reqs.map((r) => r.customId)).toEqual(reqs.map((_, i) => `s1-c${i + 1}`));
  });

  it("splits an oversized turn into pieces under the same ref", () => {
    const [big] = turnsOf(1, 250_000);
    const reqs = cutRequests(1, src, [big!], 100_000);
    expect(reqs).toHaveLength(3);
    expect(reqs.every((r) => r.turns.length === 1 && r.turns[0]!.ref === "T1" && r.chars <= 100_000)).toBe(true);
    const squash = (s: string) => s.replace(/\s+/g, "");
    expect(squash(reqs.map((r) => r.turns[0]!.text).join(""))).toBe(squash(big!.text));
  });

  it("keeps the default cap at 180k characters", () => {
    expect(MAX_REQUEST_CHARS).toBe(180_000);
  });
});
