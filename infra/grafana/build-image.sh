#!/usr/bin/env bash
# Build the exact committed monitor and dashboard configuration with a local daemon.
set -euo pipefail
if (( $# < 1 || $# > 2 )); then
  echo "Usage: $0 IMAGE_TAG [EXISTING_OPERATIONS_IMAGE]" >&2
  exit 2
fi
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
args=(--platform linux/amd64 --tag "$1" --file infra/grafana/Dockerfile)
if (( $# == 2 )); then args+=(--build-arg "OPERATIONS_IMAGE=$2"); fi
# An explicit archive limits the Docker context even on clients that do not
# honor a per-Dockerfile ignore file. No local .env or Terraform state enters it.
git archive HEAD -- infra/grafana/Dockerfile infra/grafana/fly-entrypoint.sh infra/grafana/supervise-watchdog.sh \
  infra/grafana/dashboards infra/grafana/provisioning infra/grafana/loki.yaml infra/grafana/vector.yaml \
  infra/grafana/fly/shipper.yaml scripts/fly-match-freshness.mjs scripts/match-freshness-checkpoint.mjs \
  scripts/match-freshness-fly.mjs scripts/match-freshness-policy.mjs scripts/match-freshness-reader.mjs \
  backend/config/competitions.json src/lib/matchFreshness.ts | docker buildx build --load "${args[@]}" -
