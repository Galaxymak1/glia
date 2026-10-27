import { beforeEach, describe, expect, it } from "vitest";
import { syncClaimRows } from "../src/claimIndex.js";
import type { Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { sessionStartHook } from "../src/hooks.js";
import { migrate } from "../src/migrations.js";
import { Vault } from "../src/vault.js";
import { claimFixture, tmpDir } from "./helpers.js";

const config: Config = { claudeCode: { exclude: [] }, projects: { "ai-brain": ["/home/me/dev/ai_second_brain"] } };
let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});
const seed = (...claims: ReturnType<typeof claimFixture>[]) => {
  const vault = new Vault(tmpDir("glia-hook-"));
  for (const c of claims) vault.writeClaim(c, c.id);
  syncClaimRows(db, vault);
};
const run = (cwd: string, over = {}) => sessionStartHook({ cwd }, { db, config, gitRemote: () => null, ...over });

describe("sessionStartHook", () => {
  it("briefs the session's project from the local store, tagged, within budget", () => {
    seed(claimFixture({ id: "clm_A" }), claimFixture({ id: "clm_O", scope: "project:other", statement: "L'utilisateur utilise Redis ailleurs." }));
    const out = JSON.parse(run("/home/me/dev/ai_second_brain/src"));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(text.startsWith("<glia-claims>")).toBe(true);
    expect(text).toContain("SQLite");
    expect(text).not.toContain("Redis");
    expect(text.length).toBeLessThanOrEqual(1500 * 2.25 + 40);
    expect(db.prepare("SELECT claim_id, client FROM retrievals").all()).toEqual([{ claim_id: "clm_A", client: "hook:session-start" }]);
  });

  it("an empty store gives no output and logs nothing", () => {
    expect(run("/x")).toBe("");
    expect(db.prepare("SELECT count(*) AS n FROM retrievals").get()).toEqual({ n: 0 });
  });

  it("an error gives no output", () => {
    seed(claimFixture({ id: "clm_A" }));
    expect(run("/x", { gitRemote: () => { throw new Error("git missing"); } })).toBe("");
  });
});
