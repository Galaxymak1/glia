# Evaluation (WP9, WP10, WP19)

The evaluation set and its runs decide whether the local tools beat claude.ai's own chat search (SPEC.md, "Evaluation"). `glia eval` runs the set, Claude judges each answer against its reference, and every run is stored dated in the database.

## Files

The questions quote your history, so they stay out of git, in `eval/` next to the database (`~/.local/share/glia/eval/` by default):

| File | What |
| --- | --- |
| `questions.jsonl` | The set, one question per line (format below). `glia eval run` reads this file. |
| `questions.draft.jsonl` | The first 50 drafts, written by Claude from your history. Review them, then copy to `questions.jsonl`. |
| `arm-a.jsonl` | Arm A answers, typed in by hand: `{"id": "q01", "answer": "..."}` per line. |

A question line:

```json
{"id": "q01", "category": "temporal", "question": "...", "reference": "...", "sources": [7654], "where": "cai", "note": "..."}
```

- `category`: one of `knowledge_update`, `temporal`, `abstention`, `provenance`, `cross_project`, `decision_recall`.
- `sources`: the turn ids holding the answer, as `open_evidence` shows them. Empty for `abstention`.
- `where`: `cai` (claude.ai), `cc` (Claude Code) or `both`.

## Arms

- **Arm A, claude.ai chat search, by hand.** Ask each `cai` or `both` question in a new claude.ai chat, so Claude searches past chats. Paste its answer into `arm-a.jsonl`. Claude Code questions have no arm A.
- **Arm B, `claude -p` with the glia tools.** It runs isolated:
  - its only tools are `search_evidence` and `open_evidence`;
  - no built-in tools, no other MCP server, no user settings or hooks, no CLAUDE.md;
  - no session file, so a run is never ingested back as evidence.
- **Arm C, `claude -p` with the claim tools.** The same isolation; its only tools are `recall` and `brief`, so it answers from reviewed claims alone (SPEC.md baseline 4). It has no retrieval score: it searches claims, not turns.

## Running

```sh
glia eval run                           # every question; arms B and C, and the judge, on sonnet
glia eval run --arms B                  # raw search only
glia eval run --only q01,q02 --model haiku
glia eval report                        # latest run: per category, hit@8, gate
glia eval report 3 --details            # every answer, reference and verdict
glia eval verify 3 q07 B incorrect      # a verdict checked by hand overrides Claude's
```

- **Retrieval hit@8:** a source turn is among the first 8 hits of any search arm B ran.
- **Errors:** a failed run or an unreadable verdict counts as wrong, and the report counts them.
- **Proxy:** `ANTHROPIC_BASE_URL`, if set, is recorded with the run. A proxy that compresses tool results changes what arm B sees.

## Gate (accepted on #10)

1. On the claude.ai subset, arm B gets more answers right than arm A.
2. Arm B scores no lower than arm A in any category, on the questions arm A answered.
3. On the Claude Code subset, arm B is right more than half of the time.

On the first run, check every verdict by hand (`glia eval report --details`, then `glia eval verify`).

## Phase 1 gate (#42)

The roadmap's gate: **write precision of 80% or more on a sampled audit, and zero AI-suggested claims auto-accepted.**

```sh
glia audit sample          # opens 50 audit items for auto-accepted claims never audited
glia review --audit        # a: right as written · e: right once reworded · r: wrong, retracts the claim
glia audit report          # precision = kept / judged; an edited claim does not count as kept
```

`audit report` also counts claims auto-accepted with an origin other than `user_stated` or `user_confirmed`; the gate needs zero. Next to it, `glia eval report` compares arm C with arm B per category, so the owner can see where claims beat raw search before deciding the gate.
