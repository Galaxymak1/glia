---
name: setup
description: Install and set up glia, the memory for Claude, on this machine. Use when the user asks to set up, install or repair glia, or when a session says glia is not installed yet.
---

# Set up glia

glia keeps what matters from the user's Claude conversations and brings it back in later sessions. The plugin only connects Claude to the `glia` command; this skill installs that command and sets it up.

1. Run `glia --version`. If it prints a version, skip to step 3.
2. If the command is missing, run `npm i -g @galaxymak1/glia`. This needs Node 22 or later (`node --version`); if Node is older or absent, tell the user to install Node 22 from https://nodejs.org and stop. If npm fails on permissions, tell the user what it printed. Do not use `sudo`.
3. Run `glia init --dry-run`. Show the user, in plain words, what it says it will do and which Claude Code projects it found.
4. Ask the user which projects glia must never store (client or employer work). None is a fine answer.
5. Run `glia init --yes` with one `--exclude <project folder name>` for each project the user named. If the user wants no background service, add `--no-service`.
6. Run `glia doctor` and tell the user the result in a few lines: what works, what is off and the fix glia printed for it. Keyword search works at once; the meaning search is built in the background and `glia doctor` shows its progress.
7. Finish by suggesting `/glia:recall <a topic>` and `/glia:search <words>`.

Never edit the user's Claude settings yourself: `glia init` does it, and says so.
