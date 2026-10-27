import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { selectForExtraction } from "../src/extractInput.js";
import { EXTRACT_PROMPT_VERSION, renderSource, EXTRACT_SYSTEM } from "../src/extractPrompt.js";
import { migrate } from "../src/migrations.js";
import { projectSlug, scopeForSource } from "../src/projects.js";
import { writeSource } from "../src/sources.js";

const config: Config = { claudeCode: { exclude: [] }, projects: { "ai-brain": ["/home/me/dev/ai_second_brain", "github.com/me/brain-old"] } };

describe("projectSlug", () => {
  it.each([
    ["ai_second_brain", "ai-second-brain"],
    ["My App (v2)", "my-app-v2"],
    ["--x--", "x"],
  ])("projectSlug(%s) is %s", (a, b) => expect(projectSlug(a)).toBe(b));
});

describe("scopeForSource", () => {
  it("prefers the config mapping, then the git remote, then the cwd", () => {
    expect(scopeForSource({ cwd: "/home/me/dev/ai_second_brain/src", git_remote: null, project_hint: null }, config)).toBe("project:ai-brain");
    expect(scopeForSource({ cwd: "/x", git_remote: "git@github.com:me/brain-old.git", project_hint: null }, config)).toBe("project:ai-brain");
    expect(scopeForSource({ cwd: "/x/y", git_remote: "https://github.com/me/Other_Repo.git", project_hint: null }, config)).toBe("project:other-repo");
    expect(scopeForSource({ cwd: "/x/y", git_remote: null, project_hint: null }, config)).toBe("project:y");
    expect(scopeForSource({ cwd: null, git_remote: null, project_hint: null }, config)).toBeNull();
  });

  it("a folder that only starts with a mapped path is not that project", () => {
    expect(scopeForSource({ cwd: "/home/me/dev/ai_second_brain_old", git_remote: null, project_hint: null }, config)).toBe("project:ai-second-brain-old");
  });

  it("a root cwd or an empty slug gives no scope", () => {
    expect(scopeForSource({ cwd: "/", git_remote: null, project_hint: null }, config)).toBeNull();
    expect(scopeForSource({ cwd: "/---", git_remote: null, project_hint: null }, config)).toBeNull();
  });
});

describe("extract@v3", () => {
  it("is the prompt version and tells the model to use the scope on <source>", () => {
    expect(EXTRACT_PROMPT_VERSION).toBe("extract@v3");
    expect(EXTRACT_SYSTEM).toContain("When <source> carries a scope, use the scope given on <source> for facts about that project, never another slug for it.");
  });

  it("renders the scope on <source> only when there is one", () => {
    expect(renderSource({ kind: "cc", title: "t", created_at: null, scope: "project:ai-brain" }, [])).toContain('<source kind="cc" title="t" created="" scope="project:ai-brain">');
    expect(renderSource({ kind: "cai", title: "t", created_at: null }, [])).toBe('<source kind="cai" title="t" created="">\n</source>');
  });

  it("selects sources with the scope of their folder", () => {
    const db = openDb(":memory:");
    migrate(db);
    writeSource(
      db,
      { kind: "cc", external_id: "s1", title: "t", project_hint: null, cwd: "/home/me/dev/ai_second_brain", created_at: null, updated_at: null, raw_path: "r", raw_sha256: "a", parser_version: "t" },
      [{ externalUuid: "u1", parentUuid: null, role: "user", ts: "2026-10-20T10:00:01Z", text: "on part sur SQLite", isSidechain: false, isInjected: false }],
    );
    expect(selectForExtraction(db, { config })[0]!.source.scope).toBe("project:ai-brain");
    expect(selectForExtraction(db)[0]!.source.scope).toBe("project:ai-second-brain");
  });
});
