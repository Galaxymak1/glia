// Finds the MCP clients on this machine and plans how to register glia in each. A plan is data:
// the caller shows it, asks, and applies it. Claude Code and Claude Desktop are registered;
// other clients (Zed, Cursor...) get the snippet in docs/install.md.
import { join } from "node:path";
import type { Platform } from "./service.js";

export type Client = "claude-code" | "claude-desktop";

export type RegistrationPlan =
  | { kind: "commands"; argv: string[][] }
  | { kind: "edit"; path: string; next: string }
  | { kind: "ok" }
  | { kind: "manual"; snippet: string; why: string };

export function desktopConfigPath(platform: Platform, home: string, env: { APPDATA?: string }): string {
  const dir =
    platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude") : join(home, ".config", "Claude");
  return join(dir, "claude_desktop_config.json");
}

/** Claude Code is on PATH; Claude Desktop has its config folder. */
export function detectClients(env: { platform: Platform; home: string; which(cmd: string): string | null; exists(p: string): boolean; APPDATA?: string }): Client[] {
  const found: Client[] = [];
  if (env.which("claude")) found.push("claude-code");
  const desktopDir = desktopConfigPath(env.platform, env.home, env).replace(/[/\\]claude_desktop_config\.json$/, "");
  if (env.exists(desktopDir)) found.push("claude-desktop");
  return found;
}

/**
 * How to register glia in a client. `gliaArgv` starts the program (without `mcp`). For Claude Code
 * `current` is the output of `claude mcp list`; for Claude Desktop it is the config file's text, or
 * null when the file does not exist, and `path` is where that file lives. A legacy `brain` entry
 * (the name before glia) is replaced, so the tools are never listed twice.
 */
export function registrationPlan(client: Client, gliaArgv: string[], current: string | null, path = ""): RegistrationPlan {
  const [command, ...rest] = gliaArgv;
  const entry = { command: command!, args: [...rest, "mcp"] };
  if (client === "claude-code") {
    const listed = (name: string) => new RegExp(`^${name}:`, "m").test(current ?? "");
    const remove = listed("brain") ? [["claude", "mcp", "remove", "--scope", "user", "brain"]] : [];
    if (listed("glia")) return remove.length ? { kind: "commands", argv: remove } : { kind: "ok" };
    return { kind: "commands", argv: [...remove, ["claude", "mcp", "add", "--scope", "user", "glia", "--", ...gliaArgv, "mcp"]] };
  }
  let config: Record<string, unknown> = {};
  if (current !== null) {
    try {
      const parsed: unknown = JSON.parse(current);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch (err) {
      return {
        kind: "manual",
        why: `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); it was left untouched`,
        snippet: JSON.stringify({ mcpServers: { glia: entry } }, null, 2),
      };
    }
  }
  const servers = { ...((config.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  const before = JSON.stringify(servers.glia);
  delete servers.brain;
  servers.glia = entry;
  const next = { ...config, mcpServers: servers };
  if (current !== null && before === JSON.stringify(entry) && JSON.stringify(next) === JSON.stringify(config)) return { kind: "ok" };
  return { kind: "edit", path, next: `${JSON.stringify(next, null, 2)}\n` };
}
