// Spike (not shipped): does BGE-M3 Q8_0 run in-process, with node-llama-cpp, as well as through
// Ollama? It embeds the same chunk texts from the local database both ways and compares the vectors
// and the speed. Prints numbers only, never text from the history.
//
//   npm i --no-save node-llama-cpp@3.22 && npx tsx scripts/spike-llamacpp.ts [db] [n]
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getLlama, resolveModelFile } from "node-llama-cpp";
import { OllamaEmbedder } from "../src/embed.js";
import { chunkInputs, type TurnRow } from "../src/vectors.js";

const TOKENS_PER_SECOND_MIN = 200;
const COSINE_MIN = 0.999;

const candidates = [process.argv[2], join(homedir(), ".local/share/glia/glia.db"), join(homedir(), ".local/share/ai_second_brain/brain.db")].filter((p): p is string => !!p);
const dbPath = candidates.find(existsSync);
if (!dbPath) throw new Error("no database found; pass its path");
const N = Number(process.argv[3] ?? 200);

const db = new Database(dbPath, { readonly: true });
const turns = db
  .prepare("SELECT t.id, t.source_id, t.external_uuid, t.parent_uuid, t.role, t.text, t.is_injected, s.title FROM turns t JOIN sources s ON s.id = t.source_id WHERE s.excluded = 0 ORDER BY t.id")
  .all() as TurnRow[];
const all = [...chunkInputs(turns).values()].flat();
// A seeded shuffle, so a re-run uses the same sample.
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const texts = all.map((t) => [rand(), t] as const).sort((a, b) => a[0] - b[0]).slice(0, N).map(([, t]) => t);
console.log(`${texts.length} chunks sampled from ${all.length}`);

const normalize = (v: ArrayLike<number>) => {
  const n = Math.hypot(...Array.from(v)) || 1;
  return Array.from(v, (x) => x / n);
};
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;

const modelPath = await resolveModelFile("hf:gpustack/bge-m3-GGUF/bge-m3-Q8_0.gguf", join(homedir(), ".cache", "glia-spike"));
// "auto" picked Vulkan on the owner's AMD GPU and lost the device (see the spike notes), so the CPU is the baseline.
const llama = await getLlama({ gpu: process.env.SPIKE_GPU === "auto" ? "auto" : false });
const model = await llama.loadModel({ modelPath });
const context = await model.createEmbeddingContext({ contextSize: 8192, batchSize: 8192 });
const tokenCount = texts.reduce((s, t) => s + model.tokenize(t).length + 2, 0);
console.log(`${tokenCount} tokens`);

await context.getEmbeddingFor([model.tokens.bos!, ...model.tokenize("warm up"), model.tokens.eos!]);
let t0 = performance.now();
const inProcess: number[][] = [];
// Two settings Ollama makes for this model and node-llama-cpp does not: batchSize 8192 (the default 512
// splits a longer chunk and the vector drifts, cosine 0.23 to 0.4 above 512 tokens), and the
// sentence markers below.
// BGE-M3 needs its sentence markers: given a bare string, node-llama-cpp adds none and the
// vectors drift from Ollama's (median cosine 0.66 on this sample).
const withMarkers = (t: string) => [model.tokens.bos!, ...model.tokenize(t), model.tokens.eos!];
for (const t of texts) inProcess.push(normalize((await context.getEmbeddingFor(withMarkers(t))).vector));
const llamaSeconds = (performance.now() - t0) / 1000;

const ollama = new OllamaEmbedder();
await ollama.embed(["warm up"]);
t0 = performance.now();
const viaOllama: number[][] = [];
for (let i = 0; i < texts.length; i += 16) for (const v of await ollama.embed(texts.slice(i, i + 16))) viaOllama.push(normalize(v));
const ollamaSeconds = (performance.now() - t0) / 1000;

const cos = inProcess.map((v, i) => cosine(v, viaOllama[i]!));
const worst = cos.map((c, i) => ({ c, i })).filter((x) => x.c < COSINE_MIN).sort((a, b) => a.c - b.c);
console.log(`${worst.length} of ${cos.length} chunks below ${COSINE_MIN}`);
for (const { c, i } of worst.slice(0, 12)) console.log(`  cosine ${c.toFixed(3)}  ${model.tokenize(texts[i]!).length} tokens  ${texts[i]!.length} chars`);
const llamaRate = tokenCount / llamaSeconds;
const ollamaRate = tokenCount / ollamaSeconds;
console.log(`cosine  min ${Math.min(...cos).toFixed(5)}  p1 ${quantile(cos, 0.01).toFixed(5)}  median ${quantile(cos, 0.5).toFixed(5)}`);
console.log(`speed   in-process ${llamaRate.toFixed(0)} tokens/s   ollama ${ollamaRate.toFixed(0)} tokens/s`);
const decision = Math.min(...cos) >= COSINE_MIN && llamaRate >= TOKENS_PER_SECOND_MIN ? "in-process" : "ollama";
console.log(`decision: ${decision}`);
await context.dispose();
await model.dispose();
await llama.dispose();
