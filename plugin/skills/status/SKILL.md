---
name: status
description: Check that glia is installed and healthy, and say what to fix. Use when memory seems empty, stale or broken.
allowed-tools: Bash(glia doctor)
---

# glia status

Run `glia doctor`. Summarise it in a few lines: what is working, what is off, and the exact fix it printed for each failure. A line for the meaning index that says it is still building is normal and not a failure. If the `glia` command is not found, run `/glia:setup` instead.
