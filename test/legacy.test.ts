import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfigPath } from "../src/config.js";
import { defaultDbPath } from "../src/db.js";
import { moveLegacyPaths } from "../src/legacy.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glia-legacy-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("glia paths", () => {
  it("the database and config live under glia", () => {
    expect(defaultDbPath({ XDG_DATA_HOME: "/d" })).toBe(join("/d", "glia", "glia.db"));
    expect(defaultDbPath({ GLIA_DB: "/x.db" })).toBe("/x.db");
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/c" })).toBe(join("/c", "glia", "config.json"));
    expect(defaultConfigPath({ GLIA_CONFIG: "/y.json" })).toBe("/y.json");
  });
});

describe("moveLegacyPaths", () => {
  it("old folders are moved once", () => {
    mkdirSync(join(home, ".local/share/ai_second_brain/vault/.git"), { recursive: true });
    writeFileSync(join(home, ".local/share/ai_second_brain/brain.db"), "x");
    writeFileSync(join(home, ".local/share/ai_second_brain/brain.db-wal"), "w");
    mkdirSync(join(home, ".config/ai_second_brain"), { recursive: true });
    writeFileSync(join(home, ".config/ai_second_brain/env"), "ANTHROPIC_API_KEY=k\n");
    const logs: string[] = [];
    expect(moveLegacyPaths({ home }, { log: (s) => logs.push(s) }).moved).toHaveLength(2);
    expect(readFileSync(join(home, ".local/share/glia/glia.db"), "utf8")).toBe("x");
    expect(existsSync(join(home, ".local/share/glia/glia.db-wal"))).toBe(true);
    expect(existsSync(join(home, ".local/share/glia/brain.db"))).toBe(false);
    expect(existsSync(join(home, ".local/share/glia/vault/.git"))).toBe(true);
    expect(readFileSync(join(home, ".config/glia/env"), "utf8")).toContain("ANTHROPIC_API_KEY");
    expect(existsSync(join(home, ".local/share/ai_second_brain"))).toBe(false);
    expect(logs).toEqual([expect.stringMatching(/^glia: moved .*ai_second_brain to .*glia$/), expect.stringMatching(/^glia: moved /)]);
    expect(moveLegacyPaths({ home }, { log: () => {} })).toEqual({ moved: [], conflict: [] });
  });

  it("both present: nothing moved", () => {
    mkdirSync(join(home, ".local/share/ai_second_brain"), { recursive: true });
    mkdirSync(join(home, ".local/share/glia"), { recursive: true });
    const r = moveLegacyPaths({ home }, { log: () => {} });
    expect(r.moved).toEqual([]);
    expect(r.conflict).toEqual([[join(home, ".local/share/ai_second_brain"), join(home, ".local/share/glia")]]);
    expect(existsSync(join(home, ".local/share/ai_second_brain"))).toBe(true);
  });

  it("a fresh machine sees nothing", () => {
    const logs: string[] = [];
    expect(moveLegacyPaths({ home }, { log: (s) => logs.push(s) })).toEqual({ moved: [], conflict: [] });
    expect(logs).toEqual([]);
  });

  it("follows XDG folders, and leaves an explicit GLIA_DB alone", () => {
    mkdirSync(join(home, "data/ai_second_brain"), { recursive: true });
    expect(moveLegacyPaths({ home, XDG_DATA_HOME: join(home, "data"), GLIA_DB: "/x.db" }, { log: () => {} }).moved).toEqual([]);
    expect(moveLegacyPaths({ home, XDG_DATA_HOME: join(home, "data") }, { log: () => {} }).moved).toEqual([join(home, "data/glia")]);
  });

  it("loses a race to another glia process without failing", () => {
    mkdirSync(join(home, ".local/share/ai_second_brain"), { recursive: true });
    const rename = () => {
      throw Object.assign(new Error("ENOENT: the other process moved it first"), { code: "ENOENT" });
    };
    expect(moveLegacyPaths({ home }, { log: () => {}, rename })).toEqual({ moved: [], conflict: [] });
  });

  it("still reports a move that fails for another reason", () => {
    mkdirSync(join(home, ".local/share/ai_second_brain"), { recursive: true });
    const rename = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    expect(() => moveLegacyPaths({ home }, { log: () => {}, rename })).toThrow(/EACCES/);
  });
});
