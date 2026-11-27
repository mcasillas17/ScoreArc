#!/bin/sh
# Keep a watchdog crash independent of the dashboards and log receivers.
set -eu
IFS= read -r FLY_MONITOR_TOKEN <&3
exec 3<&-
export FLY_MONITOR_TOKEN
# The entrypoint always supplies fd 4, with an empty line for anonymous reads.
IFS= read -r SCOREARC_READER_API_KEY <&4
if IFS= read -r _ <&4; then
  echo 'SCOREARC_READER_API_KEY must be a single line' >&2
  exit 1
fi
exec 4<&-
export SCOREARC_READER_API_KEY
child=
stop() {
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" || true; fi
  exit 0
}
trap stop TERM INT
while :; do
  nice -n 10 /opt/scorearc/node/bin/node --max-old-space-size=192 /opt/scorearc/scripts/fly-match-freshness.mjs run &
  child=$!
  wait "$child" || true
  echo 'Match watchdog exited; restarting in 30 seconds' >&2
  sleep 30 &
  child=$!
  wait "$child"
done
