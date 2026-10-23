import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryTimes, ingestExportZip } from "../src/claudeAiExport.js";
import { openDb } from "../src/db.js";
import { EvidenceStore } from "../src/evidence.js";
import { migrate } from "../src/migrations.js";
import { exportCategory, htmlText, isIngestedEntry, newestVersion, parseArtifact, parseConversations, parseMemories } from "../src/parsers/claudeAi.js";

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
    const rows = fromHtml!.turns.map((t) => [t.externalUuid, t.parentUuid, t.role, t.text]);
    expect(rows.map((r) => r.slice(2))).toEqual([["doc", "RGESN & report"], ["comment", "Fix the intro"], ["comment", "Done"]]); // the empty comment is skipped
    expect(rows[0]![0]).toBe("version/1790000000-bbbb.html");
    expect(rows[2]![1]).toBe(rows[1]![0]);
    // Comment ids do not depend on position: deleting the first one leaves the others' ids.
    const later = parseArtifact(meta, null, html, [{ comments: comments[0]!.comments.slice(1) }])!.turns;
    expect(later.filter((t) => t.role === "comment").map((t) => [t.externalUuid, t.parentUuid])).toEqual([[rows[2]![0], null]]);
    const twice = parseArtifact(meta, null, new Map(), [{ comments: [{ body: "ok", created_at: "t" }, { body: "ok", created_at: "t" }] }])!.turns;
    expect(new Set(twice.map((t) => t.externalUuid)).size).toBe(2);
    expect(parseArtifact(meta, "# Spec", html, [])!.turns.map((t) => t.text)).toEqual(["# Spec"]);
    expect(htmlText("<div>a</div>\n\n<div> b </div>")).toBe("a\nb");
    expect(htmlText("<p>DB_PASS<b></b>WORD&#61;x &#x3d; &quot;q&quot;</p>")).toBe('DB_PASSWORD=x = "q"');
  });

  it("reads HTML text like a browser: quoted '>' stays in its tag, a lone '<' is text, comments go", () => {
    expect(htmlText('<div title="a>b">x</div>')).toBe("x");
    expect(htmlText("<p>if a < b and c > d</p>")).toBe("if a < b and c > d");
    expect(htmlText("a<!-- hidden -->b<!DOCTYPE html><?xml x?>c")).toBe("abc");
    expect(htmlText("<SCRIPT type='x'>if (a<b) {}</script >after<style>p{}</style>")).toBe("after");
    expect(htmlText("kept <b class=\"never closed")).toBe("kept");
    expect(htmlText("kept <!-- never closed")).toBe("kept");
    expect(htmlText("<p title=don't>Hello</p> rest of page")).toBe("Hello\nrest of page");
    expect(htmlText("<p class = 'a>b' data-x=\"it's\">x</p>")).toBe("x");
    // Linear: inputs that make a backtracking regex quadratic.
    const t0 = Date.now();
    for (const bad of ["<a".repeat(200_000), "<!--".repeat(200_000), "a <".repeat(200_000), '<a "'.repeat(200_000), "<script>".repeat(100_000), "\r".repeat(200_000) + "x"]) htmlText(bad);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("picks the newest HTML version by its epoch, whatever the other names look like", () => {
    expect(newestVersion(["9-a.html", "10-b.html"])).toBe("10-b.html");
    expect(newestVersion(["v2-a.html", "1790-b.html", "x.html", "1789-c.html"])).toBe("1790-b.html");
    expect(newestVersion(["b.html", "a.html"])).toBe("b.html");
    expect(newestVersion([])).toBeUndefined();
  });

  it("dates claude.ai memory by the export, not by its newest file", () => {
    const data = { account_uuid: "acct", conversations_memory: "x", memory_files: [{ path: "/a.md", content: "A", updated_at: "2026-10-01" }] };
    expect(parseMemories(data, "2026-10-22T08:00:00.000Z")!.source.updated_at).toBe("2026-10-22T08:00:00.000Z");
    expect(parseMemories(data)!.source.updated_at).toBe("2026-10-01");
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

  it("keeps a conversations.json with one conversation it cannot read", () => {
    const r = ingestExportZip(db, store, "/x/c.zip", zip({ "conversations.json": JSON.stringify([conversation(), { uuid: "odd", chat_messages: null }, "?"]) }));
    expect(r).toMatchObject({ isExport: true, sources: { cai: { new: 2 } }, errors: [] });
  });

  it("an older export changes nothing, also after a parser change", () => {
    ingestExportZip(db, store, "/x/new.zip", zip({ "conversations.json": JSON.stringify([conversation("2026-10-20T11:00:00Z")]) }));
    db.prepare("UPDATE sources SET parser_version = 'cai@0'").run();
    const older = conversation("2026-10-19T09:00:00Z");
    older.chat_messages = older.chat_messages.slice(0, 1);
    expect(ingestExportZip(db, store, "/x/old.zip", zip({ "conversations.json": JSON.stringify([older]) }))).toMatchObject({ sources: { cai: { older: 1 } }, turnsRemoved: 0 });
    expect(turnTexts()).toHaveLength(5);
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
    // Same file names as an export, other shapes: a ChatGPT export, a project with an artifacts/ folder.
    const chatgpt = zip({ "conversations.json": JSON.stringify([{ title: "t", mapping: {} }]), "artifacts/x/artifact.json": '{"name": "build"}', "artifacts/x/page.md": "notes" });
    expect(ingestExportZip(db, store, "/x/chatgpt.zip", chatgpt)).toMatchObject({ isExport: false, errors: [] });
    // A damaged export is not taken for one, but never silently: its unreadable entry is reported.
    const broken = ingestExportZip(db, store, "/x/broken.zip", zip({ "conversations.json": "{ not json" }));
    expect(broken).toMatchObject({ isExport: false });
    expect(broken.errors).toEqual(["/x/broken.zip!/conversations.json: not valid JSON, not stored"]);
    expect(storedOrigins()).toEqual([]);
  });

  it("takes a newer export of an artifact whose page is unchanged, for its new comments", () => {
    const files = (comments: object[]) => zip({
      "artifacts/a1/artifact.json": JSON.stringify({ id: "a1", active_version: "v1", updated_at: "2026-10-21", versions: [{ id: "v1", title: "Spec", created_at: "2026-10-21" }] }),
      "artifacts/a1/page.md": "# Spec",
      "artifacts/a1/comments.json": JSON.stringify(comments),
    });
    ingestExportZip(db, store, "/x/frames-1.zip", files([]));
    expect(ingestExportZip(db, store, "/x/frames-2.zip", files([{ comments: [{ body: "Typo in 2.1", created_at: "2026-10-22" }] }]))).toMatchObject({ sources: { caa: { updated: 1 } }, turnsWritten: 1 });
    expect(turnTexts()).toEqual(["# Spec", "Typo in 2.1"]);
  });

  it("takes a newer memory export even when its newest memory file was deleted", () => {
    const memZip = (files: object[], mtime: Date) => Buffer.from(zipSync({ "memories/acct.json": [strToU8(JSON.stringify({ account_uuid: "acct", conversations_memory: "summary", memory_files: files })), { mtime }] }));
    const first = memZip([{ path: "/a.md", content: "A", updated_at: "2026-10-01" }, { path: "/b.md", content: "B", updated_at: "2026-10-05" }], new Date(2026, 9, 6));
    const second = memZip([{ path: "/a.md", content: "A", updated_at: "2026-10-01" }], new Date(2026, 9, 20));
    expect([...entryTimes(second).keys()]).toEqual(["memories/acct.json"]);
    ingestExportZip(db, store, "/x/memories-1.zip", first);
    expect(ingestExportZip(db, store, "/x/memories-2.zip", second)).toMatchObject({ sources: { mem: { updated: 1 } }, turnsRemoved: 1 });
    expect(ingestExportZip(db, store, "/x/memories-1.zip", first)).toMatchObject({ sources: { mem: { older: 1 } } });
    expect(turnTexts()).toEqual(["summary", "A"]);
  });

  it("dates an export by the ZIP file's time when its entries carry the DOS zero date, as claude.ai's do", () => {
    const memZip = (files: object[]) => Buffer.from(zipSync({ "memories/acct.json": [strToU8(JSON.stringify({ account_uuid: "acct", conversations_memory: "summary", memory_files: files })), { mtime: new Date(1980, 0, 1) }] }));
    const first = memZip([{ path: "/a.md", content: "A", updated_at: "2026-10-01" }, { path: "/b.md", content: "B", updated_at: "2026-10-05" }]);
    const second = memZip([{ path: "/a.md", content: "A", updated_at: "2026-10-01" }]);
    expect(entryTimes(second).size).toBe(0);
    ingestExportZip(db, store, "/x/memories-1.zip", first, new Date(), new Date("2026-10-06T00:00:00Z"));
    expect(ingestExportZip(db, store, "/x/memories-2.zip", second, new Date(), new Date("2026-10-20T00:00:00Z"))).toMatchObject({ sources: { mem: { updated: 1 } }, turnsRemoved: 1 });
    expect(ingestExportZip(db, store, "/x/memories-1.zip", first, new Date(), new Date("2026-10-06T00:00:00Z"))).toMatchObject({ sources: { mem: { older: 1 } } });
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
