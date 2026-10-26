# Local MCP server (WP8, WP18)

`brain mcp` serves the evidence layer and the claims to an MCP client over stdio. It offers four read-only tools, `search_evidence` and `open_evidence` over raw turns, `recall` and `brief` over reviewed claims, over the same database as the CLI (`--db`, else `$BRAIN_DB`, else `~/.local/share/ai_second_brain/brain.db`). Meaning search needs Ollama with the index model. Without it, results are keyword-only and the tool says so.

The remote endpoint with OAuth comes in Phase 2. This local server is for Claude Code and Zed on the laptop.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_evidence` | `query`; `source_kind` (`cc`, `cai`, `cap`, `cad`, `caa`, `mem`); `from`, `to` (ISO date or datetime, `to` inclusive of its day); `limit` (1–50, default 10) | One line per hit: turn id, kind, source title, time and role, then a snippet. Notes follow when meaning search is down or turns are not indexed yet |
| `open_evidence` | `id` (a turn id from `search_evidence`); `window` (0–20, default 6) | The source line, then the cited turn with up to `window` turns before it (its parents) and after it (the earliest child at each step). Injected turns are passed over |
| `recall` | `query`; `scope` (`global`, `project:<slug>`, `context:<tag>`; global claims are always included); `as_of` (ISO date: what was true then); `include_superseded` (default false); `limit` (1–20, default 8) | One block per claim: id, kind, scope, origin, the date it holds from (`as of`), the statement, and the evidence turns to open with `open_evidence`. Superseded claims are hidden unless `include_superseded` or `as_of` asks |
| `brief` | `scope`; `budget_tokens` (200–4000, default 1500) | A briefing: profile and preferences, open decisions, then the scope's facts, newest first, each with its `as of` date, cut at the budget |

Size: the cited turn is cut at 24,000 characters and each neighbour at 2,000. The whole result stays under 50,000 characters, about 18k tokens. Neighbours nearest the cited turn are kept first, and the result says how many were left out.

`recall` and `brief` wrap their result in `<brain-claims>` and log each claim served in the `retrievals` table. The next ingest flags that text as injected wherever a transcript holds it, and extraction leaves out any statement served, so a claim is never extracted again from its own echo.

## Claude Code

Replace `/path/to/ai_second_brain` with the absolute path of your checkout, and run `npm run build` there first. With a wrong path, `node` exits at once. Zed then waits 60 s for an answer and reports a request timeout, and Claude Code reports "Connection closed".

```sh
npm run build
claude mcp add --scope user brain -- node /path/to/ai_second_brain/dist/cli.js mcp
```

The server reads the default database. For another one, add `--db /path/to/brain.db` after `mcp`. A path where no database exists is created empty, and every search then finds nothing.

To check the command by hand, it should print one JSON line and exit:

```sh
echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  | node /path/to/ai_second_brain/dist/cli.js mcp
```

Without a build, use `npx tsx src/cli.ts mcp` as the command instead (slower start).

## Zed

In `settings.json` (or Settings → AI → MCP Servers → Add Local Server), with the same absolute path:

```json
{
  "context_servers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/ai_second_brain/dist/cli.js", "mcp"],
      "env": {}
    }
  }
}
```

A green dot next to `brain` in the Agent panel's settings means the server is running.
