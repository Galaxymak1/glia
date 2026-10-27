import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { DEFAULT_EMBED_MODEL, DEFAULT_OLLAMA_URL } from "./embed.js";

export interface Config {
  claudeCode: {
    /**
     * Claude Code project folders (names under ~/.claude/projects, `*` as wildcard) that are
     * never stored or parsed, e.g. client or employer repositories. Everything else is in.
     * Adding a project later stops new copies; it does not remove what is already stored.
     */
    exclude: string[];
  };
  /** The Ollama server and model of the meaning index; defaults in `embeddingSettings`. */
  embedding?: { url?: string; model?: string };
}

const DEFAULTS: Config = { claudeCode: { exclude: [] } };

/** The embedding server and model, with the defaults filled in. */
export function embeddingSettings(config: Config): { url: string; model: string } {
  return { url: config.embedding?.url ?? DEFAULT_OLLAMA_URL, model: config.embedding?.model ?? DEFAULT_EMBED_MODEL };
}

/** `$GLIA_CONFIG`, else `$XDG_CONFIG_HOME/glia/config.json` (XDG default `~/.config`). */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GLIA_CONFIG) return env.GLIA_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "glia", "config.json");
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
  const embedding = (raw as { embedding?: unknown })?.embedding ?? {};
  const { url, model } = embedding as { url?: unknown; model?: unknown };
  if (typeof embedding !== "object" || [url, model].some((v) => v !== undefined && typeof v !== "string")) {
    throw new Error(`${path}: embedding.url and embedding.model must be strings`);
  }
  return { claudeCode: { exclude }, embedding: { url: url as string | undefined, model: model as string | undefined } };
}

/** Whether a Claude Code project folder name matches one of the exclusion patterns. */
export function isExcludedProject(projectDir: string, config: Config): boolean {
  return config.claudeCode.exclude.some((pattern) => {
    const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(projectDir);
  });
}

/**
 * Whether any folder of `path` matches an exclusion pattern; the file name itself is not
 * checked. Fails closed: wherever an excluded project's folder appears (nested, copied,
 * under another projects/), the file is out. Callers pass only the part of a path they
 * walked, so a folder above the ingested root never excludes everything below it.
 */
export function isExcludedPath(path: string, config: Config): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => segment !== "" && isExcludedProject(segment, config));
}

/**
 * The Anthropic API key, from `$XDG_CONFIG_HOME/glia/env`, never from the shell: a Claude
 * Code session sets its own ANTHROPIC_API_KEY, which is not the one extraction is billed to.
 */
export function anthropicApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const path = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "glia", "env");
  const key = existsSync(path) ? parseEnv(readFileSync(path, "utf8")).ANTHROPIC_API_KEY : undefined;
  if (!key) throw new Error(`${path}: no ANTHROPIC_API_KEY (add a line ANTHROPIC_API_KEY=sk-ant-…)`);
  return key;
}
