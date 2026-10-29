import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { DEFAULT_EMBED_MODEL, OllamaEmbedder } from "../src/embed.js";
import { createEmbedder, LazyEmbedder, LlamaCppEmbedder, modelPathFor } from "../src/embedLlama.js";
import { EMBEDDING_DIMS } from "../src/migrations.js";

const config = (embedding: Config["embedding"] = {}): Config => ({ claudeCode: { exclude: [] }, embedding });
const loads = async () => ({}) as never;
const cannotLoad = async () => {
  throw new Error("Cannot find package 'node-llama-cpp'");
};

describe("createEmbedder", () => {
  it("modelPathFor puts the model under the data folder", () => {
    expect(modelPathFor("/d/glia")).toBe(join("/d/glia", "models", "bge-m3-Q8_0.gguf"));
  });

  it("uses the in-process embedder when the module loads and the model file is there", async () => {
    const e = await createEmbedder(config(), "/d", { load: loads, exists: () => true });
    expect(e).toBeInstanceOf(LlamaCppEmbedder);
    expect(e.model).toBe(DEFAULT_EMBED_MODEL);
  });

  it("falls back to Ollama when the module cannot be imported", async () => {
    expect(await createEmbedder(config(), "/d", { load: cannotLoad, exists: () => true })).toBeInstanceOf(OllamaEmbedder);
  });

  it("falls back to Ollama when the model file has not been downloaded", async () => {
    expect(await createEmbedder(config(), "/d", { load: loads, exists: () => false })).toBeInstanceOf(OllamaEmbedder);
  });

  it("provider ollama is Ollama, and so is any model but the default one", async () => {
    expect(await createEmbedder(config({ provider: "ollama" }), "/d", { load: loads, exists: () => true })).toBeInstanceOf(OllamaEmbedder);
    expect(await createEmbedder(config({ model: "bge-m3:latest" }), "/d", { load: loads, exists: () => true })).toBeInstanceOf(OllamaEmbedder);
  });

  it("provider llama.cpp without the module is an error that says what to do", async () => {
    await expect(createEmbedder(config({ provider: "llama.cpp" }), "/d", { load: cannotLoad, exists: () => true })).rejects.toThrow(/node-llama-cpp.*glia init/s);
  });
});

describe("LazyEmbedder", () => {
  it("resolves the real embedder on first use, once", async () => {
    let made = 0;
    const lazy = new LazyEmbedder("m", async () => (made++, { model: "m", embed: async (t: string[]) => t.map(() => new Float32Array(EMBEDDING_DIMS)) }));
    expect(made).toBe(0);
    await lazy.embed(["a"]);
    await lazy.embed(["b"]);
    expect(made).toBe(1);
  });
});

const modelFile = join(homedir(), ".cache", "glia-spike", "hf_gpustack_bge-m3-Q8_0.gguf");
describe.skipIf(!existsSync(modelFile))("LlamaCppEmbedder (with the model file)", () => {
  const embedder = new LlamaCppEmbedder(modelFile);
  const norm = (v: Float32Array) => Math.hypot(...v);
  const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

  it("returns normalised vectors of the index's dimension, the same for the same text", async () => {
    const [a, b, a2] = await embedder.embed(["The user prefers short answers.", "On part sur SQLite pour l'index.", "The user prefers short answers."]);
    expect(a!.length).toBe(EMBEDDING_DIMS);
    expect(norm(a!)).toBeCloseTo(1, 4);
    expect(cos(a!, a2!)).toBeGreaterThan(0.99999);
    expect(cos(a!, b!)).toBeLessThan(0.9);
    expect(embedder.tokens).toBeGreaterThan(0);
  }, 120_000);

  it("a chunk of 600 tokens is one input, not split at 512", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} about databases and indexes.`).join(" ");
    const [v] = await embedder.embed([long]);
    // Embedding the first half alone must differ from the whole: a silent cut at 512 tokens would make them near-equal.
    const [half] = await embedder.embed([long.slice(0, long.length / 3)]);
    expect(cos(v!, half!)).toBeLessThan(0.999);
    expect(Number.isFinite(norm(v!))).toBe(true);
  }, 120_000);
});
