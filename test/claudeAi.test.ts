import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestExportZip } from "../src/claudeAiExport.js";
import { openDb } from "../src/db.js";
import { EvidenceStore } from "../src/evidence.js";
import { migrate } from "../src/migrations.js";
import { exportCategory, htmlText, isIngestedEntry, parseArtifact, parseConversations, parseMemories } from "../src/parsers/claudeAi.js";

const ROOT = "00000000-0000-4000-8000-000000000000";
const SECRET = "gh" + "p_" + "K".repeat(36);
const msg = (uuid: string, parent: string, sender: string, content: object[], extra: object = {}) => ({
  uuid, parent_message_uuid: parent, sender, text: "", content, created_at: `2026-10-20T10:00:0${uuid.slice(-1)}Z`, attachments: [], files: [], ...extra,
});
const conversation = (updatedAt = "2026-10-20T11:00:00Z") => ({
  uuid: "c1", name: "DB choice", summary: "", created_at: "2026-10-20T10:00:00Z", updated_at: updatedAt, account: { uuid: "acct" },
  chat_messages: [
    msg("m1", ROOT, "human", [{ type: "text", text: "SQLite or Postgres?" }], { attachments: [{ file_name: "notes.txt", extracted_content: `token ${SECRET}` }] }),
    msg("m2", "m1", "assistant", [{ type: "thinking", thinking: "x" }, { type: "text", text: "SQLite." }, { type: "tool_use", name: "web_search", input: { q: "sqlite" } },
      { type: "tool_result", content: [{ type: "knowledge", title: "SQLite docs", url: "https://sqlite.org", text: "long page text" }, { type: "image" }] }]),
    msg("m3", "m2", "human", []), // no content at all, as in real exports
    msg("m4", "m3", "assistant", [{ type: "injected_prompt_block", prompt: "x" }, { type: "text", text: "Branch A" }]),
    msg("m5", "m2", "assistant", [{ type: "text", text: "Branch B (regenerated)" }]),
    msg("m6", "m4", "human", [], { files: [{ file_uuid: "f1", file_name: "schema.png" }] }),
  ],
});

describe("parser", () => {
  it("turns a conversation into turns, keeping every branch and skipping empty messages", () => {
    const stats = { skippedBlocks: {} };
    const [c] = parseConversations([conversation()], stats);
    expect(c!.source).toMatchObject({ kind: "cai", external_id: "c1", title: "DB choice", updated_at: "2026-10-20T11:00:00Z" });
    expect(c!.turns.map((t) => [t.externalUuid, t.parentUuid, t.role, t.text])).toEqual([
      ["m1", null, "user", `SQLite or Postgres?\n[attachment notes.txt]\ntoken ${SECRET}`],
      ["m2", "m1", "assistant", 'SQLite.\n[tool_use web_search] {"q":"sqlite"}\n[source] SQLite docs https://sqlite.org\n[image]'],
      ["m4", "m2", "assistant", "Branch A"], // m3 is empty: m4 hangs on m2
      ["m5", "m2", "assistant", "Branch B (regenerated)"],
      ["m6", "m4", "user", "[file] schema.png"],
    ]);
    expect(stats.skippedBlocks).toEqual({ thinking: 1, injected_prompt_block: 1 });
  });

  it("never makes a message its own parent, directly or through a cycle of empty messages", () => {
    const c = {
      uuid: "c2", name: "loop", created_at: "2026-10-20", updated_at: "2026-10-20",
      chat_messages: [
        msg("x1", "y1", "human", [{ type: "text", text: "x" }]),
        msg("y1", "x1", "assistant", []), // empty: not stored
        msg("s1", "s1", "human", [{ type: "text", text: "self" }]),
      ],
    };
    expect(parseConversations([c], { skippedBlocks: {} })[0]!.turns.map((t) => [t.externalUuid, t.parentUuid])).toEqual([["x1", null], ["s1", null]]);
  });

  it("keeps claude.ai memory and its files as one source", () => {
    const p = parseMemories({ account_uuid: "acct", conversations_memory: "Prefers SQLite.", memory_files: [{ path: "/a.md", content: "A", updated_at: "2026-10-01" }, { path: "/b.md", content: " ", updated_at: "2026-10-02" }] });
    expect(p!.source).toMatchObject({ kind: "mem", external_id: "claude.ai/acct" });
    expect(p!.turns.map((t) => t.externalUuid)).toEqual(["conversations_memory", "/a.md"]);
  });

  it("uses an artifact's doc page, else the text of its newest HTML version, plus its comments", () => {
    const meta = { id: "a1", active_version: "v2", updated_at: "2026-10-21", versions: [{ id: "v1", title: "Old", created_at: "2026-10-20" }, { id: "v2", title: "Report", created_at: "2026-10-21" }] };
    const html = new Map([["1789000000-aaaa.html", "<p>old</p>"], ["1790000000-bbbb.html", "<style>x{}</style><h1>RGESN &amp; report</h1><script>evil()</script>"]].map(([k, v]) => [k!, htmlText(v!)]));
    const comments = [{ comments: [{ body: "Fix the intro", created_at: "2026-10-21" }, { body: " ", created_at: "2026-10-21" }, { body: "Done", created_at: "2026-10-22" }] }];
    const fromHtml = parseArtifact(meta, null, html, comments);
    expect(fromHtml!.source).toMatchObject({ kind: "caa", external_id: "a1", title: "Report", created_at: "2026-10-20" });
    expect(fromHtml!.turns.map((t) => [t.externalUuid, t.parentUuid, t.role, t.text])).toEqual([
      ["version/1790000000-bbbb.html", null, "doc", "RGESN & report"],
      ["comment/0/0", null, "comment", "Fix the intro"],
      ["comment/0/2", "comment/0/0", "comment", "Done"], // the empty comment/0/1 is skipped
    ]);
    expect(parseArtifact(meta, "# Spec", html, [])!.turns.map((t) => t.text)).toEqual(["# Spec"]);
    expect(htmlText("<div>a</div>\n\n<div> b </div>")).toBe("a\nb");
    expect(htmlText("<p>DB_PASS<b></b>WORD&#61;x &#x3d; &quot;q&quot;</p>")).toBe('DB_PASSWORD=x = "q"');
  });

  it("sorts entries into categories and keeps only the ingested ones", () => {
    expect(["conversations.json", "projects/p.json", "memories/m.json", "design_chats/d.json", "artifacts/a/page.md", "users.json", "login_history.json", "claude_code_cloud/routines.json", "other.json"].map(exportCategory)).toEqual(
      ["conversations", "projects", "memories", "design_chats", "frames", "light_metadata", "light_metadata", "claude_code_cloud", null],
    );
    expect(["artifacts/a/artifact.json", "artifacts/a/page.md", "artifacts/a/comments.json", "artifacts/a/versions/1-x.html"].every(isIngestedEntry)).toBe(true);
    expect(["artifacts/a/versions/1-x/artifact-type/app.js", "artifacts/a/versions/1-x/index.html", "login_history.json", "users.json", "claude_code_cloud/routines.json"].some(isIngestedEntry)).toBe(false);
  });
});

describe("ingestExportZip", () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;
  let store: EvidenceStore;
  const zip = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  const turnTexts = () => (db.prepare("SELECT text FROM turns ORDER BY id").all() as { text: string }[]).map((r) => r.text);
  const storedOrigins = () => (db.prepare("SELECT origin_path FROM raw_files").all() as { origin_path: string }[]).map((r) => r.origin_path);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-cai-"));
    db = openDb(join(dir, "brain.db"));
    migrate(db);
    store = new EvidenceStore(db, join(dir, "raw"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and parses kept categories, scrubbed, and never stores account metadata", () => {
    const r = ingestExportZip(db, store, "/x/conversations-000.zip", zip({ "conversations.json": JSON.stringify([conversation()]) }));
    const meta = ingestExportZip(db, store, "/x/light_metadata-000.zip", zip({ "users.json": '[{"email_address":"me@example.com"}]', "login_history.json": '{"login_events":[{"ip_address":"203.0.113.9"}]}' }));
    expect(r).toMatchObject({ isExport: true, sources: { cai: { new: 1 } }, turnsWritten: 5, errors: [] });
    expect(meta).toMatchObject({ isExport: true, notIngested: { light_metadata: 2 }, sources: {} });
    expect(turnTexts().join("\n")).not.toContain(SECRET);
    expect(turnTexts()[0]).toContain("[REDACTED:github_token]");
    expect(storedOrigins()).toEqual(["/x/conversations-000.zip!/conversations.json"]);
  });

  it("is idempotent, and an older export changes nothing", () => {
    const newer = zip({ "conversations.json": JSON.stringify([conversation("2026-10-20T11:00:00Z")]) });
    ingestExportZip(db, store, "/x/new.zip", newer);
    expect(ingestExportZip(db, store, "/x/new.zip", newer)).toMatchObject({ sources: { cai: { unchanged: 1 } }, turnsWritten: 0 });
    const older = conversation("2026-10-19T09:00:00Z");
    older.chat_messages = older.chat_messages.slice(0, 1);
    expect(ingestExportZip(db, store, "/x/old.zip", zip({ "conversations.json": JSON.stringify([older]) }))).toMatchObject({ sources: { cai: { older: 1 } }, turnsRemoved: 0 });
    expect(turnTexts()).toHaveLength(5);
  });

  it("stores an HTML artifact as its visible text, so markup cannot hide a secret from the scrubber", () => {
    const P = "hunter2" + "hunter2";
    const page = `<html><body><code>DB_PASSWORD=${P}</code><p>DB_PASS<b></b>WORD&#61;${P}</p><pre>&quot;password&quot;: &quot;${P}&quot;</pre><script>x()</script></body></html>`;
    const r = ingestExportZip(db, store, "/x/frames-000.zip", zip({
      "artifacts/a1/artifact.json": JSON.stringify({ id: "a1", active_version: "v1", updated_at: "2026-10-21", versions: [{ id: "v1", title: "Report", created_at: "2026-10-21" }] }),
      "artifacts/a1/versions/1790000000-bbbb.html": page,
    }));
    expect(r).toMatchObject({ sources: { caa: { new: 1 } }, errors: [] });
    expect(turnTexts().join("\n")).not.toContain(P);
    const raws = (db.prepare("SELECT sha256 FROM raw_files").all() as { sha256: string }[]).map((x) => store.read(x.sha256));
    expect(raws.join("\n")).not.toContain(P);
    expect(raws.join("\n")).not.toContain("<script>");
  });

  it("leaves a ZIP that is not a claude.ai export alone", () => {
    expect(ingestExportZip(db, store, "/x/photos.zip", zip({ "IMG_1.txt": "hello" }))).toMatchObject({ isExport: false });
    expect(storedOrigins()).toEqual([]);
  });

  it("reports an entry it cannot read and ingests the rest", () => {
    const r = ingestExportZip(db, store, "/x/projects-000.zip", zip({
      "projects/p1.json": JSON.stringify({ uuid: "p1", name: "Brain", description: "Second brain", prompt_template: "", docs: [{ uuid: "d1", filename: "spec.md", content: "SQLite" }] }),
      "projects/broken.json": '{"uuid": "p2", "name": ',
    }));
    expect(r.sources).toEqual({ cap: { new: 1 } });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/projects\/broken\.json.*not valid JSON/);
  });
});
