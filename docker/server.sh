#!/bin/sh
# The team server in docker-compose.test.yml. On a fresh volume it starts from
# the state files Baton 0.0.0 wrote (scripts/multi/legacy-state), so every run
# also checks that an upgrade keeps notes, handoffs and canvas positions.
set -eu
state="${XDG_STATE_HOME:-$HOME/.local/state}/baton"
mkdir -p "$state"
for f in /seed/*.json; do
  [ -e "$state/$(basename "$f")" ] || cp "$f" "$state/"
done
exec node /app/packages/daemon/dist/index.js serve "$@"
