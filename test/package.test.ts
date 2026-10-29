import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "./helpers.js";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const BIN_CHECK = "plugin/bin-check.mjs";
const win = process.platform === "win32";

describe("package", () => {
  it("holds dist and the docs only", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", shell: win });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(files.every((f) => /^(dist\/|README\.md$|LICENSE$|package\.json$)/.test(f))).toBe(true);
    expect(files.some((f) => /^(eval|test|src|docs|scripts|plugin)\//.test(f))).toBe(false);
  });

  it("is public under the scope, with the glia command", () => {
    const pkg = readJson("package.json");
    expect(pkg).toMatchObject({ name: "@galaxymak1/glia", version: expect.stringMatching(/^\d+\.\d+\.\d+$/), bin: { glia: "dist/cli.js" }, publishConfig: { access: "public" }, license: "Elastic-2.0" });
    expect(pkg.private).toBeUndefined();
    expect(pkg.scripts.prepack).toBe("npm run build");
  });

  it("plugin and package versions match", () => {
    expect(readJson("plugin/.claude-plugin/plugin.json").version).toBe(readJson("package.json").version);
  });

  it("the marketplace lists the plugin from ./plugin", () => {
    const m = readJson(".claude-plugin/marketplace.json");
    expect(m.plugins).toEqual([expect.objectContaining({ name: "glia", source: "./plugin" })]);
  });

  it("the plugin starts glia through bin-check, with the CLAUDE_PLUGIN_ROOT variable", () => {
    expect(readJson("plugin/.mcp.json")).toEqual({ mcpServers: { glia: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin-check.mjs", "mcp"] } } });
    const hooks = readJson("plugin/hooks/hooks.json");
    expect(hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/bin-check.mjs" hook session-start' });
  });

  it("every skill has a name and a description", () => {
    for (const name of ["setup", "recall", "search", "status"]) {
      const text = readFileSync(`plugin/skills/${name}/SKILL.md`, "utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n(?:[a-z-]+: .+\\n)*---\\n`));
    }
  });
});

describe("plugin/bin-check.mjs", () => {
  const run = (args: string[], env: Record<string, string>, input = "{}") => spawnSync(process.execPath, [BIN_CHECK, ...args], { env, input, encoding: "utf8" });
  // What a command needs to start at all: cmd.exe and its folder on Windows.
  const system: Record<string, string> = win ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", ComSpec: process.env.ComSpec ?? "cmd.exe" } : {};
  const systemPath = win ? join(system.SystemRoot!, "System32") : "/usr/bin:/bin";
  /** A glia stand-in in `dir`, as npm would install it there: node runs `script` with glia's arguments. */
  const stub = (dir: string, script: string) => {
    writeFileSync(join(dir, "stub.cjs"), script);
    if (win) return writeFileSync(join(dir, "glia.cmd"), `@"${process.execPath}" "%~dp0stub.cjs" %*\r\n`);
    writeFileSync(join(dir, "glia"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/stub.cjs" "$@"\n`);
    chmodSync(join(dir, "glia"), 0o755);
  };

  it("missing glia points to setup", () => {
    const r = run(["hook", "session-start"], { PATH: "/nonexistent", HOME: "/nonexistent" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart", additionalContext: expect.stringMatching(/\/glia:setup/) });
  });

  it("missing glia fails the MCP server with the same hint", () => {
    const r = run(["mcp"], { PATH: "/nonexistent", HOME: "/nonexistent" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/glia is not installed yet: run \/glia:setup \(or npm i -g @galaxymak1\/glia && glia init\)/);
  });

  it("runs the glia on PATH with the arguments and the standard input", () => {
    const bin = tmpDir("glia-bin-");
    stub(bin, 'process.stdout.write(`args:${process.argv.slice(2).join(" ")}\\n`);\nprocess.stdin.pipe(process.stdout);\n');
    const r = run(["hook", "session-start"], { ...system, PATH: `${bin}${delimiter}${systemPath}`, HOME: "/nonexistent" }, "stdin-text");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("args:hook session-start\nstdin-text");
  });

  it("finds glia under the npm global prefix when PATH lacks it", () => {
    const prefix = tmpDir("glia-prefix-");
    // npm puts global commands in <prefix>/bin, and in the prefix itself on Windows.
    const bin = win ? prefix : join(prefix, "bin");
    mkdirSync(bin, { recursive: true });
    stub(bin, 'process.stdout.write("from prefix\\n");\n');
    const r = run(["mcp"], { ...system, PATH: systemPath, HOME: "/nonexistent", npm_config_prefix: prefix });
    expect(r.stdout).toBe("from prefix\n");
  });

  it("finds the glia that install put in the plugin's data folder", () => {
    const data = tmpDir("glia-data-");
    // install runs npm i --global --prefix <data>/npm: the same layout as a global install.
    const bin = win ? join(data, "npm") : join(data, "npm", "bin");
    mkdirSync(bin, { recursive: true });
    stub(bin, 'process.stdout.write(`data:${process.argv.slice(2).join(" ")}\\n`);\n');
    const base = { ...system, PATH: systemPath, HOME: "/nonexistent", npm_config_prefix: "/nonexistent" };
    expect(run(["mcp"], { ...base, CLAUDE_PLUGIN_DATA: data }).stdout).toBe("data:mcp\n");
    // Commands Claude runs do not get CLAUDE_PLUGIN_DATA: the skills pass the folder.
    expect(run(["--data", data, "doctor"], base).stdout).toBe("data:doctor\n");
  });

  it("install without a data folder says how to call it", () => {
    const r = run(["install"], { PATH: "/nonexistent", HOME: "/nonexistent" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: bin-check\.mjs install <data folder>/);
  });

  it("ships next to its manifest", () => {
    expect(existsSync("plugin/.claude-plugin/plugin.json")).toBe(true);
  });
});
