#!/usr/bin/env bash
# The packaging gate in CI: a stranger's install on an empty machine. Packs this checkout, installs
# the tarball like `npm i -g`, runs `glia init` over synthetic sessions, and must reach a working
# search well inside 15 minutes. HOME is an empty temp folder, so nothing of the runner's is used.
set -euo pipefail

start=$(date +%s)
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
export HOME="$work/home"
unset XDG_DATA_HOME XDG_CONFIG_HOME GLIA_DB GLIA_CONFIG
mkdir -p "$HOME/.claude/projects"
cp -R "$root/test/fixtures/claude-projects/." "$HOME/.claude/projects/"

cd "$root"
npm pack --silent --pack-destination "$work" >/dev/null
npm i -g --prefix "$work/prefix" --no-audit --no-fund "$work"/galaxymak1-glia-*.tgz >/dev/null
export PATH="$work/prefix/bin:$PATH"

glia --version >/dev/null 2>&1 || glia --help >/dev/null
glia init --yes --no-service

hits=$(glia search "orderbook SQLite" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')
if [ "$hits" -lt 1 ]; then
  echo "fresh install: search found nothing" >&2
  exit 1
fi

# The meaning index, in-process: this is what the daemon does in the background.
glia index

# Every check must pass but the service, which CI does not install.
doctor=$(glia doctor || true)
echo "$doctor"
if echo "$doctor" | grep '^FAIL' | grep -v ' service:' >/dev/null; then
  echo "fresh install: glia doctor reports a failure" >&2
  exit 1
fi

elapsed=$(( $(date +%s) - start ))
if [ "$elapsed" -ge 900 ]; then
  echo "fresh install: took ${elapsed} s, the gate is 900 s" >&2
  exit 1
fi
echo "fresh install: searchable in ${elapsed} s"
