import { describe, expect, it } from "vitest";
import { detectLang, splitInjected } from "../src/enrich.js";

describe("splitInjected", () => {
  it("splits harness spans out of a user's own words", () => {
    const text = "Fix the parser please\n\n<system-reminder>\nTodo list is empty\n</system-reminder>\n\n<local-command-stdout>ok</local-command-stdout>";
    expect(splitInjected(text)).toEqual({
      own: "Fix the parser please",
      injected: ["<system-reminder>\nTodo list is empty\n</system-reminder>", "<local-command-stdout>ok</local-command-stdout>"],
    });
  });

  it("leaves a text without spans, or with a tag left open, as written", () => {
    expect(splitInjected("plain")).toEqual({ own: "plain", injected: [] });
    expect(splitInjected("what does <system-reminder> mean?")).toEqual({ own: "what does <system-reminder> mean?", injected: [] });
  });

  it("gives an empty own text when everything is injected", () => {
    expect(splitInjected("<task-notification>done</task-notification>").own).toBe("");
  });
});

describe("detectLang", () => {
  it("tells French from English", () => {
    expect(detectLang("Est-ce que tu peux corriger le bug dans le parser ? Je pense que c'est la date.")).toBe("fr");
    expect(detectLang("Can you fix the bug in the parser? I think it's the date that is wrong.")).toBe("en");
  });

  it("reads French with curly apostrophes and without accents", () => {
    expect(detectLang("C’est pas grave, on verra ca demain avec les tests")).toBe("fr");
  });

  it("calls a turn mixed when both languages carry real sentences", () => {
    const text = "Je veux que le doc soit mis à jour à chaque issue. Il faut que tu le fasses.\n" + "The parser should keep every branch and the tests should cover it. This is what we want.";
    expect(detectLang(text)).toBe("mixed");
  });

  it("is not tipped by an English term quoted in a French sentence", () => {
    expect(detectLang("Je pense que le merge de la pull request est fait, tu peux faire le review of the code ?")).toBe("fr");
  });

  it("ignores code, links and paths, and gives no language to text without prose", () => {
    expect(detectLang("```ts\nconst the = is.not.a.sentence;\n```\nsrc/the/and/is.ts https://the.is/and")).toBeNull();
    expect(detectLang("OK")).toBeNull();
    expect(detectLang("le `x\nJe pense que le bug est dans le parser\net `y")).toBe("fr");
    expect(detectLang('ça plante encore\n<pasted_content id="1">\nError: the file is not found and it is missing\n</pasted_content>')).toBe("fr");
    expect(detectLang('[tool_use Bash] {"command":"ls -la"}')).toBeNull();
  });
});

describe("cost on hostile input", () => {
  // Turns can be megabytes of tool output: every step must stay linear.
  const timed = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };

  it("handles a long token, unclosed tags and stray backticks in linear time", () => {
    expect(timed(() => detectLang("a".repeat(5_000_000)))).toBeLessThan(2000);
    expect(timed(() => detectLang("<pasted_content id=1> ".repeat(80_000)))).toBeLessThan(2000);
    expect(timed(() => detectLang("x ` ".repeat(200_000) + "``` y ".repeat(200_000)))).toBeLessThan(2000);
    expect(timed(() => splitInjected("<system-reminder> ".repeat(200_000)))).toBeLessThan(2000);
  });

  it("still finds spans after an opener of another tag that never closes", () => {
    expect(splitInjected("<task-notification> open\nme <system-reminder>r</system-reminder>")).toEqual({
      own: "<task-notification> open\nme",
      injected: ["<system-reminder>r</system-reminder>"],
    });
  });
});

