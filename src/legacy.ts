// The project was called ai_second_brain before glia. Its folders are moved to the glia paths the
// first time any glia command runs, so nothing is lost and nothing is kept twice.
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface LegacyEnv {
  home?: string;
  XDG_DATA_HOME?: string;
  XDG_CONFIG_HOME?: string;
  GLIA_DB?: string;
}

/**
 * Moves `<data>/ai_second_brain` and `<config>/ai_second_brain` to their glia names when the old
 * folder exists and the new one does not; the database file inside is renamed `glia.db`. When both
 * exist nothing is moved and the pair is returned for `glia doctor`. An explicit `GLIA_DB` is the
 * user's own path, so nothing is moved then. A second glia process starting at the same moment (an
 * MCP server and a hook, after an upgrade) may move the folder first: that is not an error.
 */
export function moveLegacyPaths(env: LegacyEnv = process.env, io: { log(s: string): void; rename?(from: string, to: string): void } = { log: (s) => console.error(s) }): { moved: string[]; conflict: [string, string][] } {
  const home = env.home ?? homedir();
  const moved: string[] = [];
  const conflict: [string, string][] = [];
  if (env.GLIA_DB) return { moved, conflict };
  const roots = [env.XDG_DATA_HOME || join(home, ".local", "share"), env.XDG_CONFIG_HOME || join(home, ".config")];
  for (const root of roots) {
    const from = join(root, "ai_second_brain");
    const to = join(root, "glia");
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      conflict.push([from, to]);
      continue;
    }
    const rename = io.rename ?? renameSync;
    try {
      rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") continue;
      throw err;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(join(to, `brain.db${suffix}`))) rename(join(to, `brain.db${suffix}`), join(to, `glia.db${suffix}`));
    }
    io.log(`glia: moved ${from} to ${to}`);
    moved.push(to);
  }
  return { moved, conflict };
}
