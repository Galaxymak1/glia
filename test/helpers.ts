import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../src/embed.js";
import { EMBEDDING_DIMS } from "../src/migrations.js";
import type { Claim } from "../src/claims.js";

/**
 * Fixed vectors per text, padded to EMBEDDING_DIMS and normalised, so a test chooses the cosine
 * between two statements. A text it was not given gets a vector seeded from its hash.
 */
export class VectorEmbedder implements Embedder {
  calls = 0;
  constructor(
    private readonly vectors: Record<string, number[]> = {},
    readonly model = "fake@1",
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Float32Array(EMBEDDING_DIMS);
      const given = this.vectors[t];
      if (given) given.forEach((x, i) => (v[i] = x));
      else {
        const h = createHash("sha256").update(t).digest();
        for (let i = 0; i < 16; i++) v[100 + i] = h[i]! - 128;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** Two unit vectors at the given cosine, for VectorEmbedder. */
export function atCosine(cos: number): [number[], number[]] {
  return [[1, 0], [cos, Math.sqrt(1 - cos * cos)]];
}

export const failingEmbedder: Embedder = {
  model: "fake@1",
  embed: async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  },
};

export const tmpDir = (prefix = "brain-test-") => mkdtempSync(join(tmpdir(), prefix));

export const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** A claim with every SPEC field set; override what a test needs. */
export function claimFixture(over: Partial<Claim> = {}): Claim {
  return {
    id: "clm_01JB7Q3W9K0000000000000000",
    kind: "project_fact",
    scope: "project:ai-brain",
    statement_lang: "fr",
    origin: "user_stated",
    evidence: [{ source: "cc:s1", turn: "u1", quote: "on part sur SQLite, pas Postgres", quote_sha256: createHash("sha256").update("on part sur SQLite, pas Postgres").digest("hex") }],
    extractor: { model: "claude-haiku-5-5", prompt: "extract@v3", batch: "msgbatch_1" },
    confidence: 0.86,
    valid_from: "2026-10",
    valid_from_precision: "month",
    valid_to: null,
    recorded_at: "2026-10-20T14:02:11Z",
    supersedes: [],
    superseded_by: null,
    status: "active",
    review: "auto_accepted",
    reviewed_at: null,
    sensitivity: "normal",
    statement: "L'utilisateur utilise SQLite pour l'index du brain.",
    ...over,
  };
}
