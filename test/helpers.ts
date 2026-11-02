import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../src/embed.js";
import { EMBEDDING_DIMS } from "../src/migrations.js";

/**
 * Fixed vectors per text, padded to EMBEDDING_DIMS and normalised, so a test chooses the cosine
 * between two texts. A text it was not given gets a vector seeded from its hash.
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

export const tmpDir = (prefix = "brain-test-") => mkdtempSync(join(tmpdir(), prefix));
