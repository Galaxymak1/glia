// Text to vectors for the meaning index (#7), through a local Ollama server.

import { EMBEDDING_DIMS } from "./migrations.js";

export interface Embedder {
  /** Stored with every vector: a different model means a re-embed, never a mix of spaces. */
  readonly model: string;
  /** One vector of EMBEDDING_DIMS numbers per text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Tokens embedded so far, when the embedder counts them. */
  readonly tokens?: number;
}

/**
 * BGE-M3, quantised to Q8_0 (634 MB; cosine 0.9993 or more against F16 on sample turns). The
 * laptop and the server must run this same file, so the vectors one embeds and the queries the
 * other embeds share one space.
 */
export const DEFAULT_EMBED_MODEL = "hf.co/gpustack/bge-m3-GGUF:Q8_0";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/**
 * Ollama cuts every input to 2,048 tokens unless both num_ctx and num_batch are raised, and
 * says nothing. `truncate: false` turns a too-long input into an error instead. A chunk is
 * far below this: 1,400 characters stay under 8,192 tokens even at one token per character.
 */
const CONTEXT_TOKENS = 8192;

export class OllamaEmbedder implements Embedder {
  constructor(
    readonly model = DEFAULT_EMBED_MODEL,
    private readonly url = DEFAULT_OLLAMA_URL,
    private readonly timeoutMs = 300_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Tokens Ollama read since this embedder was created. */
  tokens = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const endpoint = `${this.url.replace(/\/+$/, "")}/api/embed`;
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          truncate: false,
          options: { num_ctx: CONTEXT_TOKENS, num_batch: CONTEXT_TOKENS },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err instanceof Error ? err.name : String(err));
      throw new Error(`cannot reach Ollama at ${this.url} (${cause})`);
    }
    const body = (await res.json().catch(() => null)) as { embeddings?: number[][]; prompt_eval_count?: number; error?: string } | null;
    if (!res.ok) {
      const message = body?.error ?? res.statusText;
      const hint = res.status === 404 ? `; run: ollama pull ${this.model}` : "";
      throw new Error(`Ollama ${res.status}: ${message}${hint}`);
    }
    const vectors = body?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error(`Ollama returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${texts.length} inputs`);
    }
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS) {
        throw new Error(`${this.model} returned ${Array.isArray(v) ? v.length : "no"} dimensions, expected ${EMBEDDING_DIMS}`);
      }
    }
    this.tokens += body?.prompt_eval_count ?? 0;
    return vectors.map((v) => Float32Array.from(v));
  }
}
