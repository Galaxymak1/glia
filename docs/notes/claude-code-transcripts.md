# Claude Code transcripts: what the parser will meet

Inventory of `~/.claude/projects/*/*.jsonl` on the dev machine, 2026-10-22 (Claude Code 2.1.293–2.1.303). Counts only; no content was read. Input for #4 (Claude Code parser).

## Line types (#12)

22 types. Only `user` and `assistant` carry conversation turns.

| Type | Lines | Parser |
| --- | ---: | --- |
| `assistant` | 4812 | Turn (`message.role` = `assistant`) |
| `user` | 2419 | Turn (`message.role` = `user`); tool results arrive here too (`toolUseResult`) |
| `attachment` | 4698 | Injected context, not a turn. `attachment.type` includes `hook_additional_context`, `environment`, `edited_text_file`, `total_tokens_reminder`: keep as `is_injected` or skip, never extract |
| `system` | 294 | Metadata, not a turn: `subtype` = `stop_hook_summary`, `turn_duration`, `api_error`, `local_command`, `compact_boundary`, … |
| `api-request-blob` | 568 | Copies of request content (system prompt, reminders): skip, or every injected block is indexed twice |
| `last-prompt`, `atis-latch`, `ai-title`, `mode`, `queue-operation`, `api-request`, `permission-mode`, `pr-link`, `file-history-snapshot`, `file-history-delta`, `cost-state`, `agent-name`, `bridge-session`, `api-request-shape`, `frame-link`, `artifact-autoreact-ledger`, `artifact-comment-monitor` | 6383 together | Metadata: skip and count (unknown types are skipped, never fatal) |

Turn lines share `uuid`, `parentUuid`, `sessionId`, `timestamp`, `isSidechain`, `cwd`, `gitBranch`, `entrypoint` and `version`: enough to rebuild the message tree and resolve the project.

## Entrypoints (#13)

| `entrypoint` | Lines | Client |
| --- | ---: | --- |
| `sdk-cli` | 5546 | Claude Code driven through the SDK CLI |
| `cli` | 4161 | Claude Code in a terminal |
| `sdk-ts` | 2516 | Agent SDK (TypeScript) clients |

Observed: sessions from SDK-based clients (`sdk-ts`, `sdk-cli`) are written to `~/.claude/projects/<project>/<session>.jsonl` in the same format as terminal sessions, so one sweep captures them all. Not observed directly: a session started from Zed. Zed runs Claude Code through the `claude-agent-acp` adapter (SPEC.md, Clients), which is an SDK client, so its sessions are expected to land here as `sdk-ts`.
