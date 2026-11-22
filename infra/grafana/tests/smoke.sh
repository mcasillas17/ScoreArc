#!/bin/sh
set -eu
run_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
printf '%s\n' 'services:' '  loki:' '    ports: ["127.0.0.1::3100"]' '  receiver:' '    ports: ["127.0.0.1::8080", "127.0.0.1::8081"]' > "$work/ports.yaml"
export GRAFANA_ADMIN_PASSWORD=test GRAFANA_SECRET_KEY=test GRAFANA_PGHOST=unused GRAFANA_PGDATABASE=test GRAFANA_PGUSER=test GRAFANA_PGPASSWORD=test
export VERCEL_PROJECT=test-project VERCEL_DRAIN_TOKEN=test-vercel FLY_SHIPPER_TOKEN=test-fly
project="scorearc-grafana-smoke-$$"
dc() { docker compose -p "$project" --project-directory "$run_dir" -f "$run_dir/compose.yaml" -f "$work/ports.yaml" "$@"; }
trap 'dc down -v >/dev/null 2>&1; rm -f "$work/ports.yaml"; rmdir "$work"' EXIT
dc up -d loki receiver
loki="http://$(dc port loki 3100)"
for n in $(seq 1 60); do if curl -fsS "$loki/ready" >/dev/null 2>&1; then break; fi; sleep 1; done
TEST_LOKI_URL="$loki" TEST_VERCEL_URL="http://$(dc port receiver 8080)/vercel" TEST_FLY_URL="http://$(dc port receiver 8081)/fly" node "$run_dir/tests/receiver.mjs" || { dc logs receiver | tail -12; exit 1; }
TEST_LOKI_URL="$loki" node "$run_dir/tests/dashboard.mjs"
