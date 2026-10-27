// Claude Code hooks, served by the glia command. SessionStart briefs a new session on the
// project it opens in, from the local store, so Claude starts with what matters already in view.
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { scopeForSource } from "./projects.js";
import { brief, logRetrievals } from "./recall.js";

const BRIEF_TOKENS = 1500;

/**
 * The JSON a SessionStart hook prints: the briefing for the project of `input.cwd` (plus global
 * claims) as additional context. Empty when there are no claims or on any error: a session must
 * never fail to start because of the briefing.
 */
export function sessionStartHook(input: { cwd: string }, deps: { db: Database.Database; config: Config; gitRemote(cwd: string): string | null }): string {
  try {
    const scope = scopeForSource({ cwd: input.cwd, git_remote: deps.gitRemote(input.cwd), project_hint: null }, deps.config) ?? undefined;
    const { text, claimIds } = brief(deps.db, { scope, budget_tokens: BRIEF_TOKENS });
    if (!claimIds.length) return "";
    logRetrievals(deps.db, claimIds, "hook:session-start");
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
  } catch {
    return "";
  }
}
