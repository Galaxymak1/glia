#!/usr/bin/env node
// The plugin ships no native code: it runs the glia command installed on this machine. This
// file finds that command and hands over to it (same arguments, same standard input and output).
// When glia is not installed, it says how to install it instead of leaving Claude with an empty memory.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const HINT = "glia is not installed yet: run /glia:setup (or npm i -g @galaxymak1/glia && glia init)";
const win = process.platform === "win32";

const isFile = (p) => existsSync(p) && statSync(p).isFile();
function inDir(dir) {
  for (const name of win ? ["glia.cmd", "glia.exe", "glia"] : ["glia"]) {
    const p = join(dir, name);
    if (isFile(p)) return p;
  }
  return null;
}

function find() {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const p = inDir(dir);
    if (p) return p;
  }
  // A GUI app may not see the shell's PATH (macOS): look where npm and Homebrew put global commands.
  const prefixes = [process.env.npm_config_prefix];
  const npm = spawnSync(win ? "npm.cmd" : "npm", ["config", "get", "prefix"], { encoding: "utf8", timeout: 5000, shell: win });
  if (npm.status === 0) prefixes.push(npm.stdout.trim());
  for (const prefix of prefixes.filter(Boolean)) {
    const p = inDir(win ? prefix : join(prefix, "bin"));
    if (p) return p;
  }
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global", "bin"), join(homedir(), ".local", "bin")]) {
    const p = inDir(dir);
    if (p) return p;
  }
  return null;
}

const args = process.argv.slice(2);
const glia = find();
if (!glia) {
  if (args[0] === "hook") {
    // A session must still start: say it in the context instead of failing.
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: HINT } })}\n`);
    process.exit(0);
  }
  process.stderr.write(`${HINT}\n`);
  process.exit(1);
}
const child = spawn(glia, args, { stdio: "inherit", shell: win });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("error", (err) => {
  process.stderr.write(`${HINT} (${err.message})\n`);
  process.exit(1);
});
child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
