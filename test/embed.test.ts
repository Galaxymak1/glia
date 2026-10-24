import { describe, expect, it } from "vitest";
import { OllamaEmbedder } from "../src/embed.js";
import { EMBEDDING_DIMS } from "../src/migrations.js";

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

describe("OllamaEmbedder", () => {
  it("asks for no truncation and a context large enough, and returns one vector per input", async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ embeddings: [new Array(EMBEDDING_DIMS).fill(0.1), new Array(EMBEDDING_DIMS).fill(0.2)], prompt_eval_count: 7 }));
    }) as unknown as typeof fetch;
    const e = new OllamaEmbedder("m", "http://host:11434/", 1000, fetchImpl);
    const vs = await e.embed(["a", "b"]);
    expect(sent!.url).toBe("http://host:11434/api/embed");
    expect(sent!.body).toMatchObject({ model: "m", input: ["a", "b"], truncate: false, options: { num_ctx: 8192, num_batch: 8192 } });
    expect(vs).toHaveLength(2);
    expect(vs[1]![0]).toBeCloseTo(0.2);
    expect(e.tokens).toBe(7);
  });

  it("sends nothing for no input", async () => {
    const e = new OllamaEmbedder("m", "http://x", 1000, (() => {
      throw new Error("called");
    }) as unknown as typeof fetch);
    expect(await e.embed([])).toEqual([]);
  });

  it("fails loudly on a too-long input, a missing model, or the wrong shape", async () => {
    await expect(new OllamaEmbedder("m", "http://x", 1000, reply(413, { error: "the input length exceeds the context length" })).embed(["a"])).rejects.toThrow(
      /413: the input length exceeds/,
    );
    await expect(new OllamaEmbedder("m", "http://x", 1000, reply(404, { error: 'model "m" not found' })).embed(["a"])).rejects.toThrow(/ollama pull m/);
    await expect(new OllamaEmbedder("m", "http://x", 1000, reply(200, { embeddings: [[1, 2, 3]] })).embed(["a"])).rejects.toThrow(/3 dimensions/);
    await expect(new OllamaEmbedder("m", "http://x", 1000, reply(200, { embeddings: [] })).embed(["a"])).rejects.toThrow(/0 vectors for 1/);
  });

  it("names the server it cannot reach", async () => {
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    await expect(new OllamaEmbedder("m", "http://localhost:1", 1000, refused).embed(["a"])).rejects.toThrow("cannot reach Ollama at http://localhost:1 (ECONNREFUSED)");
  });
});
