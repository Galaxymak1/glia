// Starts `glia daemon` at login through the platform's own service manager: a systemd user unit,
// a launchd agent, or a Windows scheduled task. Nothing here runs with elevated rights.
// The unit and the plist are only ever read on Linux and macOS: their paths are POSIX paths.
import { posix } from "node:path";

const { join } = posix;

export type Platform = "linux" | "darwin" | "win32";
export type ServiceAction = "install" | "uninstall" | "status";

const LABEL = "dev.galaxymak1.glia";
const UNIT = "glia.service";
const TASK = "glia";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const plistPath = (home: string) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = (home: string) => join(home, ".config", "systemd", "user", UNIT);

/** The files the service manager reads; Windows keeps its task in the Task Scheduler, not a file. */
export function serviceFiles(p: Platform, cli: string[], home: string): { path: string; content: string }[] {
  if (p === "linux") {
    return [
      {
        path: unitPath(home),
        content: `[Unit]\nDescription=glia: memory for Claude\n\n[Service]\nExecStart=${[...cli, "daemon"].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\nRestart=on-failure\nRestartSec=30\n\n[Install]\nWantedBy=default.target\n`,
      },
    ];
  }
  if (p === "darwin") {
    const args = [...cli, "daemon"].map((a) => `<string>${xml(a)}</string>`).join("");
    return [
      {
        path: plistPath(home),
        content:
          `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n` +
          `  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key><array>${args}</array>\n  <key>RunAtLoad</key><true/>\n` +
          `  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>StandardErrorPath</key><string>${xml(join(home, "Library", "Logs", "glia.log"))}</string>\n</dict>\n</plist>\n`,
      },
    ];
  }
  return [];
}

/** The commands that act on the service. `cli` and `home` name the program and the plist. */
export function serviceCommands(p: Platform, action: ServiceAction, uid: number, cli: string[], home: string): string[][] {
  if (p === "linux") {
    if (action === "install") return [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", UNIT]];
    if (action === "uninstall") return [["systemctl", "--user", "disable", "--now", UNIT]];
    return [["systemctl", "--user", "is-active", "--quiet", UNIT]];
  }
  if (p === "darwin") {
    if (action === "install") return [["launchctl", "bootstrap", `gui/${uid}`, plistPath(home)]];
    if (action === "uninstall") return [["launchctl", "bootout", `gui/${uid}/${LABEL}`]];
    return [["launchctl", "print", `gui/${uid}/${LABEL}`]];
  }
  if (action === "install") return [["schtasks", "/Create", "/F", "/SC", "ONLOGON", "/TN", TASK, "/TR", [...cli, "daemon"].map((a, i) => (i < cli.length ? `"${a}"` : a)).join(" ")]];
  if (action === "uninstall") return [["schtasks", "/Delete", "/F", "/TN", TASK]];
  return [["schtasks", "/Query", "/TN", TASK]];
}

export interface ServiceDeps {
  platform: Platform;
  cli: string[];
  home: string;
  uid: number;
  read(path: string): string | null;
  write(path: string, content: string): void;
  remove(path: string): void;
  run(argv: string[]): Promise<number>;
}

const commands = (d: ServiceDeps, action: ServiceAction) => serviceCommands(d.platform, action, d.uid, d.cli, d.home);

/** Whether the service is loaded and running. */
export async function serviceActive(d: ServiceDeps): Promise<boolean> {
  return (await d.run(commands(d, "status")[0]!)) === 0;
}

/**
 * Writes the unit when its content differs and starts the service when it is not running. A second
 * call on a working install writes nothing and runs only the status check.
 */
export async function installService(d: ServiceDeps): Promise<{ changed: boolean }> {
  let changed = false;
  for (const f of serviceFiles(d.platform, d.cli, d.home)) {
    if (d.read(f.path) !== f.content) {
      d.write(f.path, f.content);
      changed = true;
    }
  }
  const active = await serviceActive(d);
  if (active && !changed) return { changed: false };
  if (active && d.platform === "darwin") await d.run(commands(d, "uninstall")[0]!);
  if (active && d.platform === "linux") await d.run(["systemctl", "--user", "daemon-reload"]);
  if (!active || d.platform !== "linux") {
    for (const argv of commands(d, "install")) await d.run(argv);
  } else {
    await d.run(["systemctl", "--user", "restart", UNIT]);
  }
  // A logon task would otherwise wait for the next login.
  if (d.platform === "win32") await d.run(["schtasks", "/Run", "/TN", TASK]);
  return { changed: true };
}

/** Stops the service and removes the files installService wrote. */
export async function uninstallService(d: ServiceDeps): Promise<void> {
  for (const argv of commands(d, "uninstall")) await d.run(argv);
  for (const f of serviceFiles(d.platform, d.cli, d.home)) d.remove(f.path);
  if (d.platform === "linux") await d.run(["systemctl", "--user", "daemon-reload"]);
}
