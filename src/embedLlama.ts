// The meaning index without a separate server: the same BGE-M3 Q8_0 file as Ollama's, run inside
// glia's own process with node-llama-cpp. Measured against Ollama on 200 real chunks (see SPEC,
// "Embeddings without Ollama"): minimum cosine 0.99975, the same speed. Ollama stays the fallback.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { DEFAULT_EMBED_MODEL, type Embedder, OllamaEmbedder } from "./embed.js";
import { embeddingSettings } from "./config.js";
import { EMBEDDING_DIMS } from "./migrations.js";

export const MODEL_FILE = "bge-m3-Q8_0.gguf";
const MODEL_URI = "hf:gpustack/bge-m3-GGUF/bge-m3-Q8_0.gguf";

/** Where `glia init` puts the model file. */
export const modelPathFor = (dataDir: string) => join(dataDir, "models", MODEL_FILE);

type LlamaModule = typeof import("node-llama-cpp");

/** Whether node-llama-cpp can be loaded here: an optional dependency that may be missing or unbuilt. */
export const loadLlamaModule = (): Promise<LlamaModule> => import("node-llama-cpp");

export class LlamaCppEmbedder implements Embedder {
  readonly model = DEFAULT_EMBED_MODEL;
  /** Tokens embedded since this embedder was created. */
  tokens = 0;
  private opened?: Promise<{ embed(tokens: number[]): Promise<number[]>; tokenize(text: string): number[]; bos: number; eos: number }>;

  constructor(
    private readonly modelPath: string,
    private readonly load: () => Promise<LlamaModule> = loadLlamaModule,
  ) {}

  private open() {
    this.opened ??= (async () => {
      const { getLlama } = await this.load();
      // The CPU on purpose: automatic GPU selection picked Vulkan on an AMD GPU and lost the device.
      const llama = await getLlama({ gpu: false, logLevel: "error" as never });
      const model = await llama.loadModel({ modelPath: this.modelPath });
      // batchSize 8192 as Ollama sets it: the default 512 splits a longer chunk and its vector drifts.
      const context = await model.createEmbeddingContext({ contextSize: 8192, batchSize: 8192 });
      return {
        embed: async (tokens: number[]) => Array.from((await context.getEmbeddingFor(tokens as never)).vector),
        tokenize: (text: string) => Array.from(model.tokenize(text)) as number[],
        bos: model.tokens.bos as number,
        eos: model.tokens.eos as number,
      };
    })();
    return this.opened;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const m = await this.open();
    const out: Float32Array[] = [];
    for (const text of texts) {
      // BGE-M3 wants its sentence markers; a bare string would get none.
      const tokens = [m.bos, ...m.tokenize(text), m.eos];
      const raw = await m.embed(tokens);
      if (raw.length !== EMBEDDING_DIMS) throw new Error(`the model returned ${raw.length} numbers, the index holds ${EMBEDDING_DIMS}`);
      const norm = Math.hypot(...raw) || 1;
      out.push(Float32Array.from(raw, (x) => x / norm));
      this.tokens += tokens.length;
    }
    return out;
  }
}

/** An embedder that is only built when first used, for a server that may never be asked. */
export class LazyEmbedder implements Embedder {
  private real?: Promise<Embedder>;
  constructor(
    readonly model: string,
    private readonly make: () => Promise<Embedder>,
  ) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.real ??= this.make();
    return (await this.real).embed(texts);
  }
}

/**
 * The embedder this install uses: in-process when the module loads, the model file is in the data
 * folder and the model is the default one; else Ollama. `embedding.provider` forces either.
 */
export async function createEmbedder(
  config: Config,
  dataDir: string,
  deps: { load?: () => Promise<unknown>; exists?: (p: string) => boolean } = {},
): Promise<Embedder> {
  const { url, model } = embeddingSettings(config);
  const provider = config.embedding?.provider;
  const ollama = () => new OllamaEmbedder(model, url, 120_000);
  if (provider === "ollama" || model !== DEFAULT_EMBED_MODEL) return ollama();
  const path = modelPathFor(dataDir);
  let loadable = true;
  try {
    await (deps.load ?? loadLlamaModule)();
  } catch {
    loadable = false;
  }
  if (provider === "llama.cpp" && !loadable) {
    throw new Error("embedding.provider is llama.cpp but node-llama-cpp cannot be loaded; reinstall glia (npm i -g @galaxymak1/glia) or set the provider to ollama, then run: glia init");
  }
  if (loadable && (deps.exists ?? existsSync)(path)) return new LlamaCppEmbedder(path, deps.load as never);
  return ollama();
}

/** Downloads the model into `<dataDir>/models/`; progress as bytes. */
export async function downloadModel(dataDir: string, onProgress: (done: number, total: number) => void): Promise<string> {
  const { createModelDownloader } = await loadLlamaModule();
  const downloader = await createModelDownloader({
    modelUri: MODEL_URI,
    dirPath: join(dataDir, "models"),
    fileName: MODEL_FILE,
    onProgress: ({ downloadedSize, totalSize }) => onProgress(downloadedSize, totalSize),
  });
  return downloader.download();
}
