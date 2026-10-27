// One scope per project: the folder a Claude Code session ran in names the project its facts
// belong to, so the extractor does not have to guess a slug from the conversation.
import { basename } from "node:path";
import type { Config } from "./config.js";

/** A short lowercase slug: letters and digits, single dashes. */
export function projectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `git@github.com:me/app.git`, `https://github.com/me/app.git` and `github.com/me/app` all become `github.com/me/app`. */
export function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d+\/)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * The scope of a source: a project named in `config.projects` that lists its folder or remote,
 * else the repo name of its git remote, else the name of its folder, else null.
 */
export function scopeForSource(s: { cwd: string | null; git_remote: string | null; project_hint: string | null }, config: Config): string | null {
  const remote = s.git_remote ? normalizeRemote(s.git_remote) : null;
  for (const [slug, entries] of Object.entries(config.projects ?? {})) {
    for (const entry of entries) {
      const isFolder = entry.startsWith("/");
      const hit = isFolder ? s.cwd !== null && (s.cwd === entry || s.cwd.startsWith(`${entry.replace(/\/+$/, "")}/`)) : remote !== null && remote === normalizeRemote(entry);
      if (hit) return `project:${projectSlug(slug)}`;
    }
  }
  const name = remote ? basename(remote) : s.cwd ? basename(s.cwd) : "";
  const slug = projectSlug(name);
  return slug ? `project:${slug}` : null;
}
