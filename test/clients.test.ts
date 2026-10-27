import { describe, expect, it } from "vitest";
import { desktopConfigPath, detectClients, registrationPlan } from "../src/clients.js";

const argv = ["/usr/bin/glia"];
const desktop = (current: string | null) => registrationPlan("claude-desktop", argv, current, "/c/claude_desktop_config.json");

describe("detectClients", () => {
  const env = (over: Partial<Parameters<typeof detectClients>[0]> = {}) => ({ platform: "linux" as const, home: "/home/me", which: () => null, exists: () => false, ...over });
  it("finds Claude Code on PATH and Claude Desktop by its config folder", () => {
    expect(detectClients(env())).toEqual([]);
    expect(detectClients(env({ which: (c) => (c === "claude" ? "/usr/bin/claude" : null) }))).toEqual(["claude-code"]);
    expect(detectClients(env({ platform: "darwin", exists: (p) => p === "/home/me/Library/Application Support/Claude" }))).toEqual(["claude-desktop"]);
    expect(detectClients(env({ exists: (p) => p === "/home/me/.config/Claude" }))).toEqual(["claude-desktop"]);
  });
  it("knows where each platform keeps the Claude Desktop config", () => {
    expect(desktopConfigPath("darwin", "/Users/me", {})).toBe("/Users/me/Library/Application Support/Claude/claude_desktop_config.json");
    expect(desktopConfigPath("linux", "/home/me", {})).toBe("/home/me/.config/Claude/claude_desktop_config.json");
    expect(desktopConfigPath("win32", "C:/Users/me", { APPDATA: "C:/Users/me/AppData/Roaming" })).toBe("C:/Users/me/AppData/Roaming/Claude/claude_desktop_config.json");
  });
});

describe("registrationPlan: Claude Desktop", () => {
  it("creates the file when absent", () => {
    const plan = desktop(null);
    expect(plan).toMatchObject({ kind: "edit", path: "/c/claude_desktop_config.json" });
    expect(JSON.parse((plan as { next: string }).next)).toEqual({ mcpServers: { glia: { command: "/usr/bin/glia", args: ["mcp"] } } });
  });
  it("an existing registration is ok", () => {
    expect(desktop(JSON.stringify({ mcpServers: { glia: { command: "/usr/bin/glia", args: ["mcp"] } } })).kind).toBe("ok");
  });
  it("a legacy brain entry is replaced and other servers are kept", () => {
    const cur = JSON.stringify({ theme: "x", mcpServers: { brain: { command: "/x/cli.js", args: ["mcp"] }, other: { command: "o" } } });
    const next = JSON.parse((desktop(cur) as { next: string }).next);
    expect(next.theme).toBe("x");
    expect(Object.keys(next.mcpServers).sort()).toEqual(["glia", "other"]);
  });
  it("a broken config is left alone", () => {
    const plan = desktop("{ oops");
    expect(plan.kind).toBe("manual");
    expect((plan as { snippet: string }).snippet).toContain('"glia"');
  });
});

describe("registrationPlan: Claude Code", () => {
  const code = (current: string | null) => registrationPlan("claude-code", argv, current);
  const add = ["claude", "mcp", "add", "--scope", "user", "glia", "--", "/usr/bin/glia", "mcp"];
  it("adds the server user-wide", () => {
    expect(code(null)).toEqual({ kind: "commands", argv: [add] });
    expect(code("other: /x mcp - ✓ Connected")).toEqual({ kind: "commands", argv: [add] });
  });
  it("is ok when glia is listed", () => {
    expect(code("glia: /usr/bin/glia mcp - ✓ Connected\n").kind).toBe("ok");
  });
  it("a legacy brain entry is removed first", () => {
    expect(code("brain: /x/cli.js mcp - ✓ Connected")).toEqual({ kind: "commands", argv: [["claude", "mcp", "remove", "--scope", "user", "brain"], add] });
    expect(code("brain: /x mcp\nglia: /usr/bin/glia mcp")).toEqual({ kind: "commands", argv: [["claude", "mcp", "remove", "--scope", "user", "brain"]] });
  });
});
