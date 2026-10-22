import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  claudeCode: {
    /**
     * Claude Code project folders (names under ~/.claude/projects, `*` as wildcard) that are
     * never stored or parsed, e.g. client or employer repositories. Everything else is in.
     * Adding a project later stops new copies; it does not remove what is already stored.
     */
    exclude: string[];
  };
}

const DEFAULTS: Config = { claudeCode: { exclude: [] } };

/** `$BRAIN_CONFIG`, else `$XDG_CONFIG_HOME/ai_second_brain/config.json` (XDG default `~/.config`). */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BRAIN_CONFIG) return env.BRAIN_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ai_second_brain", "config.json");
}

/** Reads the config file; a missing file means the defaults. Throws on a file that is present but invalid. */
export function loadConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path)) return DEFAULTS;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const exclude = (raw as { claudeCode?: { exclude?: unknown } })?.claudeCode?.exclude ?? [];
  if (!Array.isArray(exclude) || !exclude.every((p) => typeof p === "string")) {
    throw new Error(`${path}: claudeCode.exclude must be a list of strings`);
  }
  return { claudeCode: { exclude } };
}

/** Whether a Claude Code project folder name matches one of the exclusion patterns. */
export function isExcludedProject(projectDir: string, config: Config): boolean {
  return config.claudeCode.exclude.some((pattern) => {
    const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(projectDir);
  });
}

/**
 * Whether any folder on `path` matches an exclusion pattern. Fails closed: wherever an
 * excluded project's folder appears in a path (nested, copied, under another projects/),
 * the file is out.
 */
export function isExcludedPath(path: string, config: Config): boolean {
  return path.split("/").some((segment) => segment !== "" && isExcludedProject(segment, config));
}
