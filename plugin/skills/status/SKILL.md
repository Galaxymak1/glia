---
name: status
description: Check that glia is installed and healthy, and say what to fix. Use when memory seems empty, stale or broken.
allowed-tools: Bash(glia doctor)
---

# glia status

Run `node "${CLAUDE_PLUGIN_ROOT}/bin-check.mjs" --data "${CLAUDE_PLUGIN_DATA}" doctor` (it runs `glia doctor`, wherever glia was installed). Summarise it in a few lines: what is working, what is off, and the exact fix it printed for each failure. A line for the meaning index that says it is still building is normal and not a failure. If it says glia is not installed yet, run `/glia:setup` instead.
