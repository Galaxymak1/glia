# Installing glia

glia needs Node 22 or later. It runs on Linux and macOS; Windows is best effort.

## The two ways in

### In a terminal

```sh
npm i -g @galaxymak1/glia
glia init
```

`glia init` can be run again at any time: it only does what is missing, and says so when everything is set up. It asks at most two questions:

1. Which Claude Code projects glia must never store (client or employer work). Enter for none.
2. One confirmation of the whole plan: the files and commands it will touch.

`glia init --yes` asks nothing. `glia init --dry-run` prints the plan and changes nothing. `--exclude <pattern>` (repeatable, `*` is a wildcard) names projects to leave out without being asked, and `--no-service` skips the background job.

What it sets up, in order:

1. The database, under `~/.local/share/glia/`.
2. Meaning search. By default the embedding model (634 MB) is downloaded once and runs inside glia; no other program is needed. If that is not possible it uses [Ollama](https://ollama.com) when it is running; with neither, search is keyword-only and `glia doctor` says how to turn meaning search on.
3. The config, `~/.config/glia/config.json`.
4. Claude Code and Claude Desktop, when found: glia is added as an MCP server. A server registered under the old name `brain` is replaced.
5. The first ingest of `~/.claude/projects`. Keyword search works as soon as it ends.
6. The background job, `glia daemon`, started at login (a systemd user unit on Linux, a launchd agent on macOS, a scheduled task on Windows). It re-reads your sessions every 15 minutes, builds the meaning index, and, with an API key, extracts claims every night at 02:00 (Europe/Paris) and collects the results.

### From Claude Code

```
/plugin marketplace add Galaxymak1/glia
/plugin install glia@glia
/glia:setup
```

The plugin gives Claude the glia tools, a briefing at the start of each session, and the commands `/glia:setup`, `/glia:recall`, `/glia:search` and `/glia:status`. It does not contain glia itself: `/glia:setup` has Claude install the npm package and run `glia init` with you. Until then, each session starts with a line telling you to run it.

When `glia` is not already on your PATH, the plugin installs it for you alone, in its data folder (`~/.claude/plugins/data/glia-glia/`): no `sudo`, and npm's settings are left as they are. That copy is the plugin's version of glia and is removed when you uninstall the plugin; your database and config, under `~/.local/share/glia/` and `~/.config/glia/`, stay. A `glia` you installed yourself with `npm i -g` is used instead when there is one.

## Adding history

`glia init` reads your Claude Code sessions (`~/.claude/projects`, or `%USERPROFILE%\.claude\projects` on Windows) and the daemon keeps them current. Anything else goes through `glia ingest`, which takes any mix of files and folders:

- a claude.ai export: in claude.ai, Settings > Privacy > Export data, then `glia ingest <the downloaded .zip>`. Conversations, projects and memory are read; the ZIP is not unpacked on disk.
- a copied Claude Code folder, from another machine or a backup: `glia ingest <folder>`.

Secrets are scrubbed before anything is stored, projects you excluded stay out, and running it twice does no harm. To have the daemon watch another folder, add it under `daemon.paths` in `~/.config/glia/config.json`.

## Checking and fixing

`glia doctor` checks every step above and prints the fix for whatever is broken. It exits with 1 when a check fails. A meaning index that is still being built is not a failure.

| Symptom | Fix |
| --- | --- |
| `glia: command not found` after `npm i -g` | Add the npm global folder (`npm config get prefix`, then `bin/`) to your PATH. |
| `EACCES` from `npm i -g` | npm's global folder belongs to root. Install from Claude Code instead (`/glia:setup` installs in a folder you own), or point npm at one: `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to your PATH. Never `sudo npm`. |
| Keyword search only | Run `glia init`. If the model download is blocked, install Ollama and run `glia init` again. |
| Claims never appear | Add `ANTHROPIC_API_KEY=sk-ant-…` to `~/.config/glia/env`. |
| `glia daemon is already running` | One daemon per machine is intended. `glia daemon status` shows it. |

## Other MCP clients (Zed, Cursor, …)

glia does not edit other clients' settings. Add this server by hand, with the absolute path of the `glia` command (`which glia`):

```json
{
  "context_servers": {
    "glia": { "command": "/absolute/path/to/glia", "args": ["mcp"], "env": {} }
  }
}
```

That is Zed's `settings.json`, whose own key is `context_servers`. Clients that use the `mcpServers` form take `{ "mcpServers": { "glia": { "command": "/absolute/path/to/glia", "args": ["mcp"] } } }`. The tools are described in [mcp.md](mcp.md).

## Moving from an earlier install

glia was called AI Second Brain, with the command `brain`. The first `glia` command moves `~/.local/share/ai_second_brain/` and `~/.config/ai_second_brain/` to `~/.local/share/glia/` and `~/.config/glia/`, with the history and the evidence intact. If both an old and a new folder exist, nothing is moved and `glia doctor` names them: keep one.

## From a checkout

```sh
git clone https://github.com/Galaxymak1/glia.git
cd glia
npm ci
npm run build
node dist/cli.js init
```

## Without the background job

`glia init --no-service` skips it. Then run `glia ingest ~/.claude/projects` and `glia index` yourself when you want to catch up, or `glia daemon` in a terminal.
