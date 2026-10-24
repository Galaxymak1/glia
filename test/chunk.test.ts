import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, chunkText, contextHeader, embedView, OVERLAP_CHARS, turnChunks } from "../src/chunk.js";

const words = (n: number, w = "mot") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");

describe("chunkText", () => {
  it("keeps a short text whole and drops an empty one", () => {
    expect(chunkText("  une phrase courte.  ")).toEqual(["une phrase courte."]);
    expect(chunkText(" \n\t ")).toEqual([]);
  });

  it("cuts long text into overlapping chunks no longer than the limit, at word starts", () => {
    const text = words(1000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(c).toMatch(/^mot\d+/);
      expect(c).toMatch(/mot\d+$/);
    }
    // Consecutive chunks overlap: the next one starts with words from the end of the previous.
    for (let i = 1; i < chunks.length; i++) {
      const first = chunks[i]!.split(" ")[0]!;
      expect(chunks[i - 1]!.slice(-OVERLAP_CHARS - 10)).toContain(first);
    }
    // Nothing is lost: every word appears in some chunk.
    const seen = new Set(chunks.flatMap((c) => c.split(" ")));
    expect(seen.size).toBe(1000);
  });

  it("prefers a paragraph break, then a line break, then a sentence end", () => {
    const para = `${"a".repeat(900)}\n\n${"b".repeat(900)}`;
    expect(chunkText(para)[0]).toBe("a".repeat(900));
    const line = `${"a ".repeat(450)}\n${"b ".repeat(450)}`;
    expect(chunkText(line)[0]).toBe("a ".repeat(450).trim());
    const sentence = `${"word ".repeat(180)}end. ${"more ".repeat(200)}`;
    expect(chunkText(sentence)[0]!.endsWith("end.")).toBe(true);
  });

  it("cuts a text with no break at the limit, never inside a surrogate pair", () => {
    const hash = "x".repeat(CHUNK_CHARS - 1) + "😀".repeat(10);
    const chunks = chunkText(hash);
    expect(chunks[0]!.length).toBe(CHUNK_CHARS - 1);
    expect(chunks.join("")).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("is deterministic and linear on large inputs", () => {
    const big = words(200_000);
    const start = Date.now();
    const a = chunkText(big);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(chunkText(big)).toEqual(a);
  });
});

describe("embedView", () => {
  it("shortens tool call lines and keeps prose", () => {
    const call = `[tool_use Write] {"file_path":"/x","content":"${"y".repeat(5000)}"}`;
    const view = embedView(`Je crée le fichier.\n${call}\nFait.`);
    const lines = view.split("\n");
    expect(lines[0]).toBe("Je crée le fichier.");
    expect(lines[1]!.length).toBeLessThan(310);
    expect(lines[1]!.startsWith('[tool_use Write] {"file_path":"/x"')).toBe(true);
    expect(lines[2]).toBe("Fait.");
  });
});

describe("contextHeader", () => {
  it("puts the title and the first line of the turn answered before the chunk", () => {
    expect(contextHeader("Choix de la base", "\n  On part sur SQLite ?\nDétails...")).toBe("Choix de la base\n> On part sur SQLite ?\n\n");
    expect(contextHeader(null, null)).toBe("");
    expect(contextHeader("  ", "x".repeat(400)).length).toBeLessThan(170);
  });
});

describe("turnChunks", () => {
  it("embeds nothing for injected turns and only the first chunk of tool output", () => {
    expect(turnChunks({ role: "user", text: "<system-reminder>x</system-reminder>", is_injected: 1 })).toEqual([]);
    expect(turnChunks({ role: "tool", text: words(2000), is_injected: 0 })).toHaveLength(1);
    expect(turnChunks({ role: "assistant", text: words(2000), is_injected: 0 }).length).toBeGreaterThan(1);
  });
});
