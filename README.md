# glia

Memory for Claude: a personal, self-hosted evidence ledger over your Claude conversations. (Glia are the brain's support cells: Claude does the thinking, glia keeps what it needs within reach.) It keeps every Claude Code session and every claude.ai export as immutable evidence, searches all of them at once in French and English, and serves the results to any MCP client: Claude Code, Zed, and later claude.ai through a remote connector.

The design is in [SPEC.md](SPEC.md). Phase 0, cross-silo search with an evaluation harness, is done. Phase 1, reviewed claims extracted from the evidence, is in progress.

## What it does today

- **Ingests** Claude Code transcripts and memory from `~/.claude/projects`, and claude.ai export ZIPs (chats, projects, memories). Secrets are scrubbed before anything is stored, and a session containing a line with only `#nobrain` is never stored.
- **Searches** turns with keyword (FTS5) and meaning (BGE-M3) search, fused with reciprocal rank fusion.
- **Serves** four read-only MCP tools over stdio: `search_evidence` and `open_evidence` over raw turns, `recall` and `brief` over reviewed claims.
- **Evaluates** itself against your own questions, so each layer has to beat raw search before it ships ([docs/eval.md](docs/eval.md)).

Everything stays on your machine: the database lives in `~/.local/share/glia/` and the config in `~/.config/glia/`.

## Install

You need Node 22 or later. Pick one:

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

`glia init` asks which projects it must never store (Enter for none) and then once whether to go ahead. It sets up the database, the meaning search, your Claude clients and a background job that keeps glia up to date, then ingests your Claude Code history. When it ends, keyword search already works:

```sh
glia search "which database did I pick"
```

Meaning search is built in the background (`glia doctor` shows how far it is), and claims are extracted at night once you add `ANTHROPIC_API_KEY` to `~/.config/glia/env`. Everything else, including Zed and other clients, a manual setup and the Ollama alternative, is in [docs/install.md](docs/install.md). `glia --help` lists every command.

## License

Source-available under the [Elastic License 2.0](LICENSE). You may use, copy, modify and redistribute the software, for personal or work use. You may not provide it to third parties as a hosted or managed service. The author keeps the right to offer one.
