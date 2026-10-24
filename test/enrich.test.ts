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
    expect(detectLang('ça plante encore\n<pasted_content id="1">\nError: the file is not found and it is missing\n</pasted_content>')).toBe("fr");
    expect(detectLang('[tool_use Bash] {"command":"ls -la"}')).toBeNull();
  });
});
