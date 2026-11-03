#!/bin/sh
# One simulated teammate machine: replays a fixture as a live Claude Code or
# Codex session (replay tells them apart by the fixture's contents), and runs a daemon that forwards it to the team server.
#
# The daemon runs in a restart loop with its pid in /data/daemon.pid, so the
# chaos test can `kill -9` it mid-stream and watch it come back, as a crashed
# daemon would after a supervisor restarts it. The replay keeps writing
# meanwhile.
#
# What's shared: with REPO set, the session runs in a git checkout of
# github.com/acme/$REPO and that repo is shared (machines with the same REPO
# are grouped and linked on the canvas). Otherwise the folder SHARE (default /)
# is shared; SHARE=/data/elsewhere shares nothing this machine does.
#
# Env: BATON_TOKEN, BATON_SERVER, NAME, FIXTURE, SPEED, MAX_GAP, REPO, SHARE.
set -eu
cd /app
baton() { node packages/daemon/dist/index.js "$@"; }

mkdir -p /data/projects /data/codex /data/elsewhere
rm -f /data/replay.done

if [ -n "${REPO:-}" ]; then
  work="/work/$REPO"
  mkdir -p "$work"
  if [ ! -d "$work/.git" ]; then
    git -C "$work" init -q -b main
    git -C "$work" remote add origin "https://github.com/acme/$REPO.git"
  fi
  baton share "$work" --state-file /data/state.json
  set -- --cwd "$work"
else
  baton share "${SHARE:-/}" --state-file /data/state.json
  set --
fi

(
  baton replay "packages/core/test/fixtures/$FIXTURE" \
    --projects-dir /data/projects --codex-dir /data/codex --as "$NAME" --seed "$NAME" "$@" \
    --speed "${SPEED:-20}" --max-gap "${MAX_GAP:-2}" --log-level warn
  touch /data/replay.done
) &

while true; do
  # node directly, not the baton function: backgrounding a function forks a
  # subshell, so $! would be that subshell and kill -9 would orphan the daemon.
  node packages/daemon/dist/index.js start --server "$BATON_SERVER" --name "$NAME" \
    --projects-dir /data/projects --codex-dir /data/codex --state-file /data/state.json \
    --log-level "${LOG_LEVEL:-info}" &
  echo $! > /data/daemon.pid
  wait $! || echo "daemon exited with $?, restarting" >&2
  sleep 1
done
