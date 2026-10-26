import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { openDb } from "../src/db.js";
import { createMcpServer, NEIGHBOUR_CHARS, openEvidence, RESULT_CHARS, TURN_CHARS } from "../src/mcp.js";
import { migrate } from "../src/migrations.js";
import { type TurnRow, writeSource } from "../src/sources.js";

let db: ReturnType<typeof openDb>;
let client: Client;

const turn = (externalUuid: string, parentUuid: string | null, role: string, text: string, ts: string | null, isInjected = false): TurnRow => ({
  externalUuid,
  parentUuid,
  role,
  ts,
  text,
  isSidechain: false,
  isInjected,
});
const source = (kind: Parameters<typeof writeSource>[1]["kind"], external_id: string, title: string, turns: TurnRow[]) =>
  writeSource(
    db,
    { kind, external_id, title, project_hint: null, cwd: null, created_at: null, updated_at: null, raw_path: "raw", raw_sha256: "abc", parser_version: "test" },
    turns,
  );
const idOf = (uuid: string) => (db.prepare("SELECT id FROM turns WHERE external_uuid = ?").get(uuid) as { id: number }).id;

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError ?? false };
}

beforeEach(async () => {
  db = openDb(":memory:");
  migrate(db);
  // A chain u1 → a2 → (injected r3) → u4 → a5 → u6, plus a later branch a5b off u4.
  source("cai", "c1", "Kubernetes ingress", [
    turn("u1", null, "user", "How do I set up an ingress for the kubernetes cluster?", "2026-10-01T09:00:00Z"),
    turn("a2", "u1", "assistant", "Install the nginx ingress controller first.", "2026-10-01T09:00:10Z"),
    turn("r3", "a2", "user", "<system-reminder>kubernetes reminder</system-reminder>", "2026-10-01T09:00:11Z", true),
    turn("u4", "r3", "user", "Done, what next for kubernetes?", "2026-10-01T09:01:00Z"),
    turn("a5", "u4", "assistant", "Now write the Ingress resource.", "2026-10-01T09:01:10Z"),
    turn("a5b", "u4", "assistant", "A regenerated answer.", "2026-10-01T09:05:00Z"),
    turn("u6", "a5", "user", "Thanks.", "2026-10-01T09:02:00Z"),
  ]);
  source("cc", "s1", "Kubernetes session", [turn("k1", null, "user", "kubernetes helm chart upgrade", "2026-10-20T15:30:00Z")]);
  source("mem", "m1", "notes", [turn("n1", null, "memory", "kubernetes is the main cluster", null)]);
  const server = createMcpServer(db, null);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  db.close();
});

describe("tools/list", () => {
  it("lists every tool as read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
      ["search_evidence", true],
      ["open_evidence", true],
      ["recall", true],
      ["brief", true],
    ]);
  });
});

describe("search_evidence", () => {
  it("finds turns across sources and names each turn id", async () => {
    const { text } = await call("search_evidence", { query: "kubernetes" });
    for (const uuid of ["u1", "u4", "k1", "n1"]) expect(text).toContain(`turn ${idOf(uuid)} `);
    expect(text).not.toContain(`turn ${idOf("r3")} `); // injected
  });

  it("filters by source kind", async () => {
    const { text } = await call("search_evidence", { query: "kubernetes", source_kind: "cc" });
    expect(text).toContain(`turn ${idOf("k1")} `);
    expect(text).not.toContain("[cai]");
    expect(text).not.toContain("[mem]");
  });

  it("filters by date, with `to` covering its whole day and undated turns left out", async () => {
    const day = await call("search_evidence", { query: "kubernetes", from: "2026-10-20", to: "2026-10-20" });
    expect(day.text).toContain(`turn ${idOf("k1")} `);
    expect(day.text).not.toContain(`turn ${idOf("u1")} `);
    expect(day.text).not.toContain(`turn ${idOf("n1")} `);
    const before = await call("search_evidence", { query: "kubernetes", to: "2026-10-01T09:00:30Z" });
    expect(before.text).toContain(`turn ${idOf("u1")} `);
    expect(before.text).not.toContain(`turn ${idOf("u4")} `);
  });

  it("rejects a malformed date and an unknown kind", async () => {
    expect((await call("search_evidence", { query: "kubernetes", from: "last week" })).isError).toBe(true);
    expect((await call("search_evidence", { query: "kubernetes", source_kind: "gpt" })).isError).toBe(true);
  });

  it("says so when nothing matches", async () => {
    expect((await call("search_evidence", { query: "terraform" })).text).toBe("No results.");
  });
});

describe("open_evidence", () => {
  it("shows the parent chain and the earliest child chain, passing over injected turns", () => {
    const r = openEvidence(db, idOf("u4"), 6)!;
    expect(r.turns.map((t) => t.id)).toEqual(["u1", "a2", "u4", "a5", "u6"].map(idOf));
    expect(r.turns.find((t) => t.cited)?.id).toBe(idOf("u4"));
    expect(r.source).toMatchObject({ kind: "cai", title: "Kubernetes ingress" });
  });

  it("stops at `window` turns on each side", () => {
    expect(openEvidence(db, idOf("u4"), 1)!.turns.map((t) => t.id)).toEqual(["a2", "u4", "a5"].map(idOf));
    expect(openEvidence(db, idOf("u4"), 0)!.turns.map((t) => t.id)).toEqual([idOf("u4")]);
  });

  it("returns the cited turn text, marked, through the tool", async () => {
    const { text, isError } = await call("open_evidence", { id: idOf("a5"), window: 1 });
    expect(isError).toBe(false);
    expect(text).toContain("Kubernetes ingress");
    expect(text).toContain(`--- turn ${idOf("a5")} · assistant · 2026-10-01T09:01:10Z ← cited\nNow write the Ingress resource.`);
    expect(text).toContain("Done, what next for kubernetes?");
    expect(text).toContain("Thanks.");
  });

  it("is an error for an unknown turn or one in an excluded source", async () => {
    expect((await call("open_evidence", { id: 999_999 })).isError).toBe(true);
    db.prepare("UPDATE sources SET excluded = 1 WHERE external_id = 's1'").run();
    expect((await call("open_evidence", { id: idOf("k1") })).isError).toBe(true);
    expect((await call("search_evidence", { query: "helm" })).text).toBe("No results.");
  });

  it("cuts long turns and keeps the whole result under the cap", async () => {
    const big = "x".repeat(200_000);
    const chain = Array.from({ length: 41 }, (_, i) => turn(`b${i}`, i ? `b${i - 1}` : null, i % 2 ? "assistant" : "user", big, `2026-10-02T10:00:${String(i).padStart(2, "0")}Z`));
    source("cc", "big", "T".repeat(5_000), chain);
    const r = openEvidence(db, idOf("b20"), 20)!;
    const cited = r.turns.find((t) => t.cited)!;
    expect(cited.truncated).toBe(true);
    expect(cited.text.length).toBe(TURN_CHARS + 1);
    expect(r.turns.filter((t) => !t.cited).every((t) => t.text.length === NEIGHBOUR_CHARS + 1)).toBe(true);
    expect(r.omittedTurns).toBeGreaterThan(0);
    // Nearest neighbours are kept first, on both sides.
    const ids = r.turns.map((t) => t.id);
    expect(ids).toContain(idOf("b19"));
    expect(ids).toContain(idOf("b21"));
    const { text } = await call("open_evidence", { id: idOf("b20"), window: 20 });
    expect(text.length).toBeLessThanOrEqual(RESULT_CHARS);
    expect(text).toContain("left out to stay under the size cap");
    // No gap: the kept turns are one unbroken stretch of the chain.
    const n = ids.map((id) => chain.findIndex((t) => idOf(t.externalUuid) === id));
    expect(n).toEqual(n.map((_, i) => n[0]! + i));
  });

  it("cuts long source titles in search results", async () => {
    source("cai", "long", "kubernetes ".repeat(500), [turn("l1", null, "user", "kubernetes title test", "2026-10-03T10:00:00Z")]);
    const { text } = await call("search_evidence", { query: "kubernetes title test" });
    expect(text.split("\n").every((line) => line.length < 300)).toBe(true);
  });
});
