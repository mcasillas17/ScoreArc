#!/usr/bin/env bash
set -euo pipefail
umask 077
# Only the watchdog should inherit these credentials, not even the setup helpers.
export -n FLY_MONITOR_TOKEN SCOREARC_READER_API_KEY
# The volume is root-owned on first boot. Run the services without root privileges.
for dir in /data/grafana /data/loki /data/vector /run/secrets; do
  install -d -o 472 -g 472 -m 0700 "$dir"
done
printf '%s' "${VERCEL_DRAIN_TOKEN:?}" > /run/secrets/vercel_token
printf '%s' "${FLY_SHIPPER_TOKEN:?}" > /run/secrets/fly_token
printf '%s' "${SHIPPER_CREDENTIALS:?}" | base64 -d > /etc/vector-shipper.json
chown 472:472 /run/secrets/{vercel,fly}_token /etc/vector-shipper.json
unset VERCEL_DRAIN_TOKEN FLY_SHIPPER_TOKEN SHIPPER_CREDENTIALS
children=()
watchdog_pid=
# Invoked by the EXIT trap for signals and daemon failures.
# shellcheck disable=SC2329
stop() {
  trap - TERM INT
  if [[ -n "$watchdog_pid" ]]; then kill -TERM "$watchdog_pid" 2>/dev/null || true; fi
  if (( ${#children[@]} )); then
    kill -TERM "${children[@]}" 2>/dev/null || true
    wait || true
  fi
}
trap stop EXIT
trap 'exit 0' TERM INT
if [[ -n "${FLY_MONITOR_TOKEN:-}" ]]; then
  # A separate UID and an empty environment keep Grafana, Neon and shipper
  # credentials out of the watchdog. Tokens travel through fds 3 and 4.
  env -i PATH="$PATH" LD_LIBRARY_PATH=/opt/scorearc/node/lib su-exec 65532:65532 \
    sh /opt/scorearc/supervise-watchdog.sh 3<<< "$FLY_MONITOR_TOKEN" 4<<< "${SCOREARC_READER_API_KEY:-}" &
  watchdog_pid=$!
fi
unset FLY_MONITOR_TOKEN SCOREARC_READER_API_KEY
if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  export GF_AUTH_PROXY_ENABLED=true GF_AUTH_PROXY_HEADER_NAME=Cf-Access-Authenticated-User-Email
  export GF_AUTH_PROXY_HEADER_PROPERTY=email GF_AUTH_PROXY_AUTO_SIGN_UP=true GF_AUTH_PROXY_WHITELIST=127.0.0.1
  export GF_USERS_AUTO_ASSIGN_ORG_ROLE=Viewer GF_AUTH_DISABLE_LOGIN_FORM=true
  env -i PATH="$PATH" TUNNEL_TOKEN="$TUNNEL_TOKEN" su-exec 472:472 cloudflared tunnel --no-autoupdate run &
  children+=($!)
fi
unset TUNNEL_TOKEN
env -i PATH="$PATH" su-exec 472:472 loki -config.file=/etc/scorearc/loki.yaml &
children+=($!)
env -i PATH="$PATH" VERCEL_PROJECT="${VERCEL_PROJECT:?}" su-exec 472:472 vector \
  --config /etc/scorearc/vector.yaml --config /etc/scorearc/shipper.yaml &
children+=($!)
export GF_SECURITY_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:?}" GF_SECURITY_SECRET_KEY="${GRAFANA_SECRET_KEY:?}"
export PGHOST="${GRAFANA_PGHOST:?}" PGDATABASE="${GRAFANA_PGDATABASE:?}" PGUSER="${GRAFANA_PGUSER:?}" PGPASSWORD="${GRAFANA_PGPASSWORD:?}"
su-exec 472:472 /run.sh &
children+=($!)
# Fly restarts the stack when any required daemon exits.
wait -n "${children[@]}" || true
exit 1
