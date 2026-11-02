#!/bin/sh
# One simulated teammate machine: replays a fixture as a live Claude Code
# session, and runs a daemon that forwards it to the team server.
#
# The daemon runs in a restart loop with its pid in /data/daemon.pid, so the
# chaos test can `kill -9` it mid-stream and watch it come back, as a crashed
# daemon would after a supervisor restarts it. The replay keeps writing
# meanwhile.
#
# Env: BATON_TOKEN, BATON_SERVER, NAME, FIXTURE, SPEED, MAX_GAP.
set -eu
cd /app
baton() { node packages/daemon/dist/index.js "$@"; }

mkdir -p /data/projects
rm -f /data/replay.done

(
  baton replay "packages/core/test/fixtures/$FIXTURE" \
    --projects-dir /data/projects --as "$NAME" --seed "$NAME" \
    --speed "${SPEED:-20}" --max-gap "${MAX_GAP:-2}" --log-level warn
  touch /data/replay.done
) &

while true; do
  baton start --server "$BATON_SERVER" --name "$NAME" \
    --projects-dir /data/projects --state-file /data/state.json \
    --log-level "${LOG_LEVEL:-info}" &
  echo $! > /data/daemon.pid
  wait $! || echo "daemon exited with $?, restarting" >&2
  sleep 1
done
