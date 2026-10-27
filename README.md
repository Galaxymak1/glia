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

Installation is from source for now. A one-command install (`glia init` wizard, npm package `@galaxymak1/glia`, Claude Code plugin) is planned in the packaging phase of [the roadmap](SPEC.md#roadmap).

Requirements: Node 22 or later, and [Ollama](https://ollama.com) for meaning search. Without Ollama, search is keyword-only.

```sh
git clone https://github.com/Galaxymak1/ai_second_brain.git
cd ai_second_brain
npm ci
npm run build
ollama pull hf.co/gpustack/bge-m3-GGUF:Q8_0

node dist/cli.js init
node dist/cli.js ingest ~/.claude/projects ~/Downloads/claude-export.zip
node dist/cli.js index
node dist/cli.js search "which database did I pick"
```

`glia --help` lists every command and option. To skip projects you don't want stored, such as client repositories, list their folders in `~/.config/glia/config.json`:

```json
{ "claudeCode": { "exclude": ["-home-me-work-*"] } }
```

## Connect a client

```sh
claude mcp add --scope user glia -- node /path/to/ai_second_brain/dist/cli.js mcp
```

Zed and the details of both tools are in [docs/mcp.md](docs/mcp.md).

## License

Source-available under the [Elastic License 2.0](LICENSE). You may use, copy, modify and redistribute the software, for personal or work use. You may not provide it to third parties as a hosted or managed service. The author keeps the right to offer one.
