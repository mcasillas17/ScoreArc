#!/bin/sh
# Keep a watchdog crash independent of the dashboards and log receivers.
set -eu
IFS= read -r FLY_MONITOR_TOKEN <&3
exec 3<&-
export FLY_MONITOR_TOKEN
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
