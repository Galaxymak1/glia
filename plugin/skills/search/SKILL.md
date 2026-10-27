---
name: search
description: Search the raw text of the user's past Claude conversations with glia. Use when the user wants to find what was actually said, or recall found nothing.
argument-hint: "<words>"
---

# Search the evidence

Call the `search_evidence` tool of the glia MCP server with `query` set to "$ARGUMENTS". It searches Claude Code sessions and claude.ai exports at once, by keywords and by meaning, in French and English.

Show the best hits with their source, date and the matching passage. To read around a hit, call `open_evidence` with its id. Quote what was said and say where it was said; do not summarise from memory. If nothing comes back, say so.
