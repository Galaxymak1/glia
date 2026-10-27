import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { tmpDir } from "./helpers.js";

const load = (json: unknown) => {
  const path = join(tmpDir("glia-config-"), "config.json");
  writeFileSync(path, JSON.stringify(json));
  return loadConfig(path);
};

describe("loadConfig daemon", () => {
  it("keeps the folders the daemon sweeps", () => {
    expect(load({ claudeCode: { exclude: [] }, daemon: { paths: ["/a", "/b"] } }).daemon).toEqual({ paths: ["/a", "/b"] });
  });
  it("no daemon section: the default sweep", () => {
    expect(load({ claudeCode: { exclude: [] } }).daemon).toBeUndefined();
  });
  it("rejects paths that are not a list of strings", () => {
    expect(() => load({ daemon: { paths: "/a" } })).toThrow(/daemon\.paths must be a list of strings/);
  });
});
