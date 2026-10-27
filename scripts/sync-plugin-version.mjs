// Runs from `npm version`: the plugin manifest carries the same version as the package.
import { readFileSync, writeFileSync } from "node:fs";

const file = "plugin/.claude-plugin/plugin.json";
const version = process.env.npm_package_version;
if (!version) throw new Error("run this through `npm version`");
const text = readFileSync(file, "utf8");
const next = text.replace(/"version": "[^"]*"/, `"version": "${version}"`);
if (next === text && !text.includes(`"version": "${version}"`)) throw new Error(`${file} has no version field`);
writeFileSync(file, next);
