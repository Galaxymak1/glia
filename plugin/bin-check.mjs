#!/usr/bin/env node
// The plugin ships no native code: it runs the glia command installed on this machine. This
// file finds that command and hands over to it (same arguments, same standard input and output).
// When glia is not installed, it says how to install it instead of leaving Claude with an empty memory.
//
// `bin-check.mjs install <data folder>` installs glia, at the plugin's version, under the plugin's
// data folder (${CLAUDE_PLUGIN_DATA}): the user owns it, so it needs neither sudo nor a change to
// npm's global prefix. `--data <folder>` before glia's arguments says where to look for that copy
// when CLAUDE_PLUGIN_DATA is not set (commands Claude runs do not get it).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HINT = "glia is not installed yet: run /glia:setup (or npm i -g @galaxymak1/glia && glia init)";
const win = process.platform === "win32";

const isFile = (p) => existsSync(p) && statSync(p).isFile();
// npm puts the commands of a global install in <prefix>/bin, and in the prefix itself on Windows.
const binOf = (prefix) => (win ? prefix : join(prefix, "bin"));
const dataPrefix = (data) => join(data, "npm");
function inDir(dir) {
  for (const name of win ? ["glia.cmd", "glia.exe", "glia"] : ["glia"]) {
    const p = join(dir, name);
    if (isFile(p)) return p;
  }
  return null;
}

function find(data) {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const p = inDir(dir);
    if (p) return p;
  }
  // The copy `install` put in the plugin's data folder.
  if (data) {
    const p = inDir(binOf(dataPrefix(data)));
    if (p) return p;
  }
  // A GUI app may not see the shell's PATH (macOS): look where npm and Homebrew put global commands.
  const prefixes = [process.env.npm_config_prefix];
  const npm = spawnSync(win ? "npm.cmd" : "npm", ["config", "get", "prefix"], { encoding: "utf8", timeout: 5000, shell: win });
  if (npm.status === 0) prefixes.push(npm.stdout.trim());
  for (const prefix of prefixes.filter(Boolean)) {
    const p = inDir(binOf(prefix));
    if (p) return p;
  }
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global", "bin"), join(homedir(), ".local", "bin")]) {
    const p = inDir(dir);
    if (p) return p;
  }
  return null;
}

let args = process.argv.slice(2);
let data = process.env.CLAUDE_PLUGIN_DATA;
if (args[0] === "--data") {
  data = args[1];
  args = args.slice(2);
}

if (args[0] === "install") {
  const into = args[1] ?? data;
  if (!into) {
    process.stderr.write("usage: bin-check.mjs install <data folder>\n");
    process.exit(2);
  }
  // The version this plugin was released with, so the plugin and the command it runs agree.
  const manifest = join(dirname(fileURLToPath(import.meta.url)), ".claude-plugin", "plugin.json");
  const { version } = JSON.parse(readFileSync(manifest, "utf8"));
  const prefix = dataPrefix(into);
  const npmArgs = ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", `@galaxymak1/glia@${version}`];
  // npm is a .cmd on Windows, which only a shell runs; the prefix is quoted for a folder with a space.
  const r = spawnSync(win ? "npm.cmd" : "npm", win ? npmArgs.map((a) => `"${a}"`) : npmArgs, { stdio: ["ignore", "inherit", "inherit"], shell: win });
  if (r.error) {
    process.stderr.write(`glia: npm did not start (${r.error.message}); install Node 22 or later from https://nodejs.org\n`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
  process.stdout.write(`glia ${version} installed in ${binOf(prefix)}\n`);
  process.exit(0);
}

const glia = find(data);
if (!glia) {
  if (args[0] === "hook") {
    // A session must still start: say it in the context instead of failing.
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: HINT } })}\n`);
    process.exit(0);
  }
  process.stderr.write(`${HINT}\n`);
  process.exit(1);
}
// On Windows glia is a .cmd, which only cmd.exe runs: quoted, so a folder with a space survives.
const child = spawn(win ? `"${glia}"` : glia, args, { stdio: "inherit", shell: win });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("error", (err) => {
  process.stderr.write(`${HINT} (${err.message})\n`);
  process.exit(1);
});
child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
