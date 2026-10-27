import { describe, expect, it } from "vitest";
import { installService, type Platform, serviceCommands, serviceFiles, uninstallService } from "../src/service.js";

const cli = ["/usr/bin/node-22", "/opt/glia/dist/cli.js"];
const home = "/home/me";

describe("serviceFiles", () => {
  it("linux: a systemd user unit that restarts on failure", () => {
    const [f, ...rest] = serviceFiles("linux", cli, home);
    expect(rest).toEqual([]);
    expect(f!.path).toBe("/home/me/.config/systemd/user/glia.service");
    expect(f!.content).toBe(
      "[Unit]\nDescription=glia: memory for Claude\n\n[Service]\nExecStart=/usr/bin/node-22 /opt/glia/dist/cli.js daemon\nRestart=on-failure\nRestartSec=30\n\n[Install]\nWantedBy=default.target\n",
    );
  });

  it("darwin: a launchd agent that runs at load and restarts after a failure", () => {
    const [f] = serviceFiles("darwin", cli, home);
    expect(f!.path).toBe("/home/me/Library/LaunchAgents/dev.galaxymak1.glia.plist");
    expect(f!.content).toContain("<key>Label</key><string>dev.galaxymak1.glia</string>");
    expect(f!.content).toContain("<array><string>/usr/bin/node-22</string><string>/opt/glia/dist/cli.js</string><string>daemon</string></array>");
    expect(f!.content).toContain("<key>RunAtLoad</key><true/>");
    expect(f!.content).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(f!.content).toContain("<key>StandardErrorPath</key><string>/home/me/Library/Logs/glia.log</string>");
  });

  it("darwin: XML special characters in paths are escaped", () => {
    const [f] = serviceFiles("darwin", ["/Users/a&b/node", "/x/<cli>.js"], home);
    expect(f!.content).toContain("<string>/Users/a&amp;b/node</string>");
    expect(f!.content).toContain("<string>/x/&lt;cli&gt;.js</string>");
  });

  it("windows: no file, a scheduled task instead", () => {
    expect(serviceFiles("win32", cli, home)).toEqual([]);
  });
});

describe("serviceCommands", () => {
  it("linux", () => {
    expect(serviceCommands("linux", "install", 1000, cli, home)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "glia.service"],
    ]);
    expect(serviceCommands("linux", "uninstall", 1000, cli, home)).toEqual([["systemctl", "--user", "disable", "--now", "glia.service"]]);
    expect(serviceCommands("linux", "status", 1000, cli, home)).toEqual([["systemctl", "--user", "is-active", "--quiet", "glia.service"]]);
  });

  it("darwin", () => {
    expect(serviceCommands("darwin", "install", 501, cli, home)).toEqual([["launchctl", "bootstrap", "gui/501", "/home/me/Library/LaunchAgents/dev.galaxymak1.glia.plist"]]);
    expect(serviceCommands("darwin", "uninstall", 501, cli, home)).toEqual([["launchctl", "bootout", "gui/501/dev.galaxymak1.glia"]]);
    expect(serviceCommands("darwin", "status", 501, cli, home)).toEqual([["launchctl", "print", "gui/501/dev.galaxymak1.glia"]]);
  });

  it("win32", () => {
    expect(serviceCommands("win32", "install", 0, cli, home)).toEqual([["schtasks", "/Create", "/F", "/SC", "ONLOGON", "/TN", "glia", "/TR", '"/usr/bin/node-22" "/opt/glia/dist/cli.js" daemon']]);
    expect(serviceCommands("win32", "uninstall", 0, cli, home)).toEqual([["schtasks", "/Delete", "/F", "/TN", "glia"]]);
    expect(serviceCommands("win32", "status", 0, cli, home)).toEqual([["schtasks", "/Query", "/TN", "glia"]]);
  });
});

function fakeDeps(platform: Platform, active = false) {
  const files = new Map<string, string>();
  const ran: string[][] = [];
  let isActive = active;
  return {
    files,
    ran,
    deps: {
      platform,
      cli,
      home,
      uid: 1000,
      read: (p: string) => files.get(p) ?? null,
      write: (p: string, c: string) => void files.set(p, c),
      remove: (p: string) => void files.delete(p),
      run: async (argv: string[]) => {
        ran.push(argv);
        if (argv.includes("is-active") || argv.includes("print") || argv.includes("/Query")) return isActive ? 0 : 1;
        if (argv.includes("enable") || argv.includes("bootstrap") || argv.includes("/Create")) isActive = true;
        if (argv.includes("disable") || argv.includes("bootout") || argv.includes("/Delete")) isActive = false;
        return 0;
      },
    },
  };
}

describe("installService", () => {
  it("is idempotent: the second call writes nothing and runs only the status check", async () => {
    const { files, ran, deps } = fakeDeps("linux");
    expect(await installService(deps)).toEqual({ changed: true });
    expect(files.size).toBe(1);
    ran.length = 0;
    expect(await installService(deps)).toEqual({ changed: false });
    expect(ran).toEqual([["systemctl", "--user", "is-active", "--quiet", "glia.service"]]);
  });

  it("a changed unit is rewritten and the manager reloaded", async () => {
    const { files, ran, deps } = fakeDeps("linux", true);
    files.set("/home/me/.config/systemd/user/glia.service", "old");
    expect(await installService(deps)).toEqual({ changed: true });
    expect(files.get("/home/me/.config/systemd/user/glia.service")).toContain("ExecStart=/usr/bin/node-22");
    expect(ran).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  });

  it("a stopped service with an identical unit is started", async () => {
    const { ran, deps } = fakeDeps("linux");
    await installService(deps);
    deps.run = async (argv) => (ran.push(argv), argv.includes("is-active") ? 1 : 0);
    ran.length = 0;
    expect(await installService(deps)).toEqual({ changed: true });
    expect(ran).toContainEqual(["systemctl", "--user", "enable", "--now", "glia.service"]);
  });

  it("windows creates the task unless it exists", async () => {
    const { ran, deps } = fakeDeps("win32");
    await installService(deps);
    expect(ran.map((a) => a[1])).toEqual(["/Query", "/Create", "/Run"]);
    ran.length = 0;
    await installService(deps);
    expect(ran).toEqual([["schtasks", "/Query", "/TN", "glia"]]);
  });
});

describe("uninstallService", () => {
  it("removes the files it wrote and stops the service", async () => {
    const { files, ran, deps } = fakeDeps("linux");
    await installService(deps);
    await uninstallService(deps);
    expect(files.size).toBe(0);
    expect(ran.at(-1)).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(ran).toContainEqual(["systemctl", "--user", "disable", "--now", "glia.service"]);
  });
});
