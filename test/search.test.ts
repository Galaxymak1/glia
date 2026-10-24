import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import type { Embedder } from "../src/embed.js";
import { EMBEDDING_DIMS, migrate } from "../src/migrations.js";
import { ftsQuery, search } from "../src/search.js";
import { type TurnRow, writeSource } from "../src/sources.js";
import { buildIndex, chunkInputs, indexStatus } from "../src/vectors.js";

// A stand-in for BGE-M3: a bag of words hashed into the vector, with a few words mapped across
// languages, so "meaning" search can match a French query to English text and back.
const SAME = new Map(Object.entries({ chat: "cat", dort: "sleeps", canape: "sofa", base: "database", donnees: "database" }));
class FakeEmbedder implements Embedder {
  calls: string[][] = [];
  constructor(readonly model = "fake@1") {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map((t) => {
      const v = new Float32Array(EMBEDDING_DIMS);
      for (const raw of t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/\p{L}+/gu) ?? []) {
        const w = SAME.get(raw) ?? raw;
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        v[h % EMBEDDING_DIMS]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
  get inputs() {
    return this.calls.flat();
  }
}

let db: ReturnType<typeof openDb>;
const turn = (externalUuid: string, parentUuid: string | null, role: string, text: string, isInjected = false): TurnRow => ({
  externalUuid,
  parentUuid,
  role,
  ts: `2026-10-20T10:00:0${externalUuid.slice(-1)}Z`,
  text,
  isSidechain: false,
  isInjected,
});
const source = (external_id: string, title: string | null, turns: TurnRow[]) =>
  writeSource(
    db,
    { kind: "cai", external_id, title, project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "raw", raw_sha256: "abc", parser_version: "test" },
    turns,
  );
const idOf = (uuid: string) => (db.prepare("SELECT id FROM turns WHERE external_uuid = ?").get(uuid) as { id: number }).id;
const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  source("c1", "Animaux", [
    turn("u1", null, "user", "Where does the cat sleep during the day?"),
    turn("a2", "u1", "assistant", "The cat sleeps on the sofa most afternoons."),
    turn("u3", "a2", "user", "<system-reminder>cat sofa reminder</system-reminder>", true),
  ]);
  source("c2", "Stockage", [
    turn("u1", null, "user", "Quelle base de données choisir pour le brain ?"),
    turn("a2", "u1", "assistant", "SQLite: one file, zero ops, and sqlite-vec for vectors."),
    turn("t3", "a2", "tool", `${"log line ".repeat(400)}`),
  ]);
});

describe("ftsQuery", () => {
  it("quotes every word and joins them with OR", () => {
    expect(ftsQuery('Où dort le "chat" ? AND NOT')).toBe('"où" OR "dort" OR "le" OR "chat" OR "and" OR "not"');
    expect(ftsQuery(" ?! ")).toBeNull();
  });
});

describe("buildIndex", () => {
  it("embeds every turn a person or Claude wrote, with its context header, and nothing injected", async () => {
    const e = new FakeEmbedder();
    const r = await buildIndex(db, e);
    expect(r).toMatchObject({ turns: 6, turnsEmbedded: 5, turnsUnchanged: 0, turnsCleared: 0 });
    expect(r.chunksEmbedded).toBe(5); // the long tool output gives its first chunk only
    expect(e.inputs).toContain("Animaux\n> Where does the cat sleep during the day?\n\nThe cat sleeps on the sofa most afternoons.");
    expect(e.inputs.some((t) => t.includes("system-reminder"))).toBe(false);
    expect(count("chunks_vec")).toBe(5);
    expect(db.prepare("SELECT DISTINCT model, dims FROM chunks_vec").all()).toEqual([{ model: "fake@1", dims: EMBEDDING_DIMS }]);
  });

  it("answers the nearest turn a person or Claude wrote, passing over tool output", () => {
    source("c3", null, [turn("u1", null, "user", "Lance les tests"), turn("t2", "u1", "tool", "ok 126 passed"), turn("a3", "t2", "assistant", "All green.")]);
    const rows = db
      .prepare("SELECT t.id, t.source_id, t.external_uuid, t.parent_uuid, t.role, t.text, t.is_injected, s.title FROM turns t JOIN sources s ON s.id = t.source_id")
      .all() as Parameters<typeof chunkInputs>[0];
    expect(chunkInputs(rows).get(idOf("a3"))).toEqual(["> Lance les tests\n\nAll green."]);
  });

  it("embeds nothing on a second run, and only what changed after an edit", async () => {
    const e = new FakeEmbedder();
    await buildIndex(db, e);
    const second = new FakeEmbedder();
    expect(await buildIndex(db, second)).toMatchObject({ turnsEmbedded: 0, turnsUnchanged: 5 });
    expect(second.calls).toEqual([]);

    // A new reply in c1 and a changed title in c2: the reply, and every c2 turn (its header changed).
    source("c1", "Animaux", [
      turn("u1", null, "user", "Where does the cat sleep during the day?"),
      turn("a2", "u1", "assistant", "The cat sleeps on the sofa most afternoons."),
      turn("u3", "a2", "user", "<system-reminder>cat sofa reminder</system-reminder>", true),
      turn("a4", "a2", "assistant", "And at night, on the bed."),
    ]);
    db.prepare("UPDATE sources SET title = 'Base' WHERE external_id = 'c2'").run();
    const third = new FakeEmbedder();
    expect(await buildIndex(db, third)).toMatchObject({ turnsEmbedded: 4, turnsUnchanged: 2 });
  });

  it("re-embeds vectors of another model and drops chunks of turns that lost their text", async () => {
    await buildIndex(db, new FakeEmbedder("old@1"));
    db.prepare("UPDATE turns SET is_injected = 1 WHERE external_uuid = 'a2' AND source_id = (SELECT id FROM sources WHERE external_id = 'c1')").run();
    expect(indexStatus(db, "fake@1")).toEqual({ missing: 0, otherModel: 5 });
    const r = await buildIndex(db, new FakeEmbedder("fake@1"));
    expect(r).toMatchObject({ turnsEmbedded: 4, turnsCleared: 1 });
    expect(indexStatus(db, "fake@1")).toEqual({ missing: 0, otherModel: 0 });
    expect(count("chunks")).toBe(4);
  });

  it("deletes a turn's vectors with the turn", async () => {
    await buildIndex(db, new FakeEmbedder());
    source("c2", "Stockage", [turn("u1", null, "user", "Quelle base de données choisir pour le brain ?")]);
    expect(count("chunks")).toBe(3);
    expect(count("chunks_vec")).toBe(3);
    expect(indexStatus(db, "fake@1").missing).toBe(0);
  });

  it("keeps every turn it finished when the embedder fails midway", async () => {
    const e = new FakeEmbedder();
    let n = 0;
    const flaky: Embedder = { model: e.model, embed: async (t) => (n++ ? Promise.reject(new Error("down")) : e.embed(t)) };
    await expect(buildIndex(db, flaky, { batchSize: 2 })).rejects.toThrow("down");
    expect(count("chunks")).toBe(2);
    expect(count("chunks")).toBe(count("chunks_vec"));
    expect(await buildIndex(db, new FakeEmbedder(), { batchSize: 2 })).toMatchObject({ turnsEmbedded: 3, turnsUnchanged: 2 });
  });
});

describe("search", () => {
  it("finds a turn from a French query and from an English one", async () => {
    const e = new FakeEmbedder();
    await buildIndex(db, e);
    const fr = await search(db, e, "un chat qui dort");
    expect(fr.hits[0]).toMatchObject({ turnId: idOf("a2"), kind: "cai", sourceTitle: "Animaux", role: "assistant" });
    expect(fr.hits[0]!.meaningRank).toBe(1);
    const en = await search(db, e, "which database should the brain use");
    expect(en.hits.slice(0, 2).map((h) => h.turnId)).toContain(db.prepare("SELECT t.id FROM turns t JOIN sources s ON s.id = t.source_id WHERE s.external_id = 'c2' AND external_uuid = 'u1'").pluck().get());
  });

  it("applies the kind and date filters to the meaning side too", async () => {
    const e = new FakeEmbedder();
    await buildIndex(db, e);
    const ids = async (opts: Parameters<typeof search>[3]) => (await search(db, e, "un chat qui dort", opts)).hits.map((h) => h.turnId);
    expect(await ids({ kind: "cai" })).toContain(idOf("a2"));
    expect(await ids({ kind: "cc" })).toEqual([]);
    expect(await ids({ to: "2026-10-20T10:00:01Z" })).not.toContain(idOf("a2"));
    expect(await ids({ from: "2026-10-20", to: "2026-10-20" })).toContain(idOf("a2"));
    expect(await ids({ from: "2026-10-21" })).toEqual([]);
  });

  it("fuses keyword and meaning ranks, and a turn in both lists ranks first", async () => {
    const e = new FakeEmbedder();
    await buildIndex(db, e);
    const r = await search(db, e, "sqlite-vec");
    const top = r.hits[0]!;
    expect(top.keywordRank).toBe(1);
    expect(top.meaningRank).toBe(1);
    expect(top.score).toBeCloseTo(2 / 61);
    expect(top.snippet).toContain("[sqlite]-[vec]");
  });

  it("gives each hit the snippet of its own turn", async () => {
    const e = new FakeEmbedder();
    await buildIndex(db, e);
    const r = await search(db, e, "cat");
    const byId = new Map(r.hits.map((h) => [h.turnId, h.snippet]));
    expect(byId.get(idOf("a2"))).toContain("[cat] sleeps on the sofa");
    expect(r.hits.find((h) => h.snippet.startsWith("Where does the [cat]"))).toBeDefined();
  });

  it("leaves injected turns out unless asked", async () => {
    const e = new FakeEmbedder();
    await buildIndex(db, e);
    expect((await search(db, e, "reminder")).hits.some((h) => h.isInjected)).toBe(false);
    const all = await search(db, e, "reminder", { includeInjected: true });
    expect(all.hits[0]).toMatchObject({ isInjected: true, keywordRank: 1, meaningRank: null });
  });

  it("falls back to keyword results when the query cannot be embedded", async () => {
    await buildIndex(db, new FakeEmbedder());
    const down: Embedder = { model: "fake@1", embed: async () => Promise.reject(new Error("cannot reach Ollama")) };
    const r = await search(db, down, "sofa");
    expect(r.meaningError).toBe("cannot reach Ollama");
    expect(r.hits[0]).toMatchObject({ turnId: idOf("a2"), keywordRank: 1, meaningRank: null });
  });

  it("ignores vectors of another model", async () => {
    await buildIndex(db, new FakeEmbedder("old@1"));
    const r = await search(db, new FakeEmbedder("fake@1"), "chat dort");
    expect(r.hits.every((h) => h.meaningRank === null)).toBe(true);
  });

  it("gives the same results after the index is deleted and rebuilt", async () => {
    const e = new FakeEmbedder();
    await buildIndex(db, e);
    const queries = ["où dort le chat", "database", "sqlite-vec", "log line"];
    const before = await Promise.all(queries.map((q) => search(db, e, q)));
    const r = await buildIndex(db, e, { rebuild: true });
    expect(r).toMatchObject({ turnsEmbedded: 5, turnsUnchanged: 0 });
    const after = await Promise.all(queries.map((q) => search(db, e, q)));
    expect(after).toEqual(before);
  });
});
