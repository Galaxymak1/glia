<p align="center"><img src="https://raw.githubusercontent.com/Galaxymak1/glia/master/assets/logo-wordmark.svg" alt="glia" width="320"></p>

# glia

**Claude that remembers.**

You decide something with Claude on Monday. On Friday, in a new session, it has no idea. glia fixes that. It quietly keeps what matters from your conversations and puts it back in front of Claude when it's needed, so you stop repeating yourself and start building on what you already worked out.

Your history lives on your machine, in one folder you own.

## Why you'll like it

- **Zero effort.** Install it once. It reads your Claude Code sessions in the background and keeps itself up to date. You never "save" anything.
- **Claude is the interface.** Ask Claude what you decided about the database, which approach you rejected, how you like your answers. It looks it up in your history and answers, with the date and the source.
- **Search that finds what you meant.** Keywords and meaning together, in French and English, over every Claude Code session and every claude.ai export at once.
- **Facts you can trust.** Beyond raw search, glia can distil your history into short, dated, sourced statements that you review with a single key. Anything Claude only suggested stays marked as a suggestion, and a newer decision replaces the older one without erasing it.
- **Private by design.** Secrets are scrubbed before anything is stored. Projects you exclude are never read. Put `#nobrain` on a line of its own in any session and that session is never kept.
- **Works where you work.** Claude Code and Claude Desktop out of the box, and any other MCP client (Zed, Cursor and more) with a three-line snippet.

## Install

You need Node 22 or later. Pick one.

**In a terminal**

```sh
npm i -g @galaxymak1/glia
glia init
```

**From Claude Code**

```
/plugin marketplace add Galaxymak1/glia
/plugin install glia@glia
/glia:setup
```

`glia init` asks which projects it must never store (press Enter for none), then asks once whether to go ahead. It sets up the database, search, your Claude clients and a small background job, then reads your history. When it finishes you can already search:

```sh
glia search "which database did I pick"
```

Meaning search finishes building in the background, and `glia doctor` shows how far along it is and the fix for anything that's off. Add an Anthropic API key to `~/.config/glia/env` and glia also distils your conversations into reviewable facts overnight; that is the one step that sends text to Anthropic, and it stays off until you add a key. More options, other clients and troubleshooting are in [docs/install.md](docs/install.md).

## Bring in your history

Claude Code sessions are picked up automatically, and kept up to date every 15 minutes. To add anything else, point glia at it:

```sh
glia ingest ~/Downloads/data-2026-10-20.zip   # a claude.ai export (Settings > Privacy > Export data)
glia ingest ~/old-backup/projects             # a folder of Claude Code sessions
```

It's safe to run again: what was already read is skipped.

## What Claude gets

glia gives Claude four read-only tools:

| Tool | What it does |
| --- | --- |
| `recall` | The reviewed facts about a topic, with dates and sources |
| `brief` | A short briefing on a project, loaded at the start of a session |
| `search_evidence` | Search the raw conversations |
| `open_evidence` | Read around any result |

In Claude Code the plugin also adds `/glia:recall`, `/glia:search`, `/glia:status` and `/glia:setup`. Details are in [docs/mcp.md](docs/mcp.md).

## You stay in charge

- **Local.** One database, one folder, one machine.
- **Honest.** glia measures itself against your own questions, so every layer has to beat plain search before it earns its place ([docs/eval.md](docs/eval.md)).
- **Reversible.** Exclude a project, opt a session out, or delete the folder. That's all it takes.

## License

Source-available under the [Elastic License 2.0](LICENSE). Use it, read it, change it and share it, for personal or work use. You just can't offer it to others as a hosted service.
