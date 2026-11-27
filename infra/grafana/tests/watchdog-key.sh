#!/usr/bin/env bash
# Exercise the packaged entrypoint and UID switch without starting services or contacting production.
set -eu
docker run --rm -i --pull=never --network none --entrypoint bash "${1:?Pass a local operations image tag}" -seu <<'CHECK'
mkdir /tmp/services
install -d -m 1777 /tmp/results
vendor_install=$(command -v install)
SCOREARC_READER_API_KEY=$(cat /proc/sys/kernel/random/uuid)
FLY_MONITOR_TOKEN=$(cat /proc/sys/kernel/random/uuid)
export SCOREARC_READER_API_KEY FLY_MONITOR_TOKEN
export VERCEL_PROJECT=test VERCEL_DRAIN_TOKEN=test FLY_SHIPPER_TOKEN=test SHIPPER_CREDENTIALS=e30= TUNNEL_TOKEN=test
export GRAFANA_ADMIN_PASSWORD=test GRAFANA_SECRET_KEY=test GRAFANA_PGHOST=test GRAFANA_PGUSER=test GRAFANA_PGDATABASE=test GRAFANA_PGPASSWORD=test
printf %s "$SCOREARC_READER_API_KEY" | sha256sum | cut -d' ' -f1 > /tmp/expected-digest
cat > /tmp/services/install <<'SH'
#!/bin/sh
if [ "${SCOREARC_READER_API_KEY+x}${FLY_MONITOR_TOKEN+x}" ]; then state=leaked; else state=isolated; fi
echo "$state" > /tmp/results/install
exec "$VENDOR_INSTALL" "$@"
SH
export VENDOR_INSTALL="$vendor_install"
cat > /tmp/services/su-exec <<'SH'
#!/bin/sh
if [ "$1" = 65532:65532 ]; then exec /sbin/su-exec "$@"; fi
if [ "${SCOREARC_READER_API_KEY+x}${FLY_MONITOR_TOKEN+x}" ]; then state=leaked; else state=isolated; fi
echo "$state" > "/tmp/results/${2##*/}"
exec sleep 30
SH
chmod 755 /tmp/services/install /tmp/services/su-exec
export PATH="/tmp/services:$PATH"

# Substitute a single season observation for the leased scheduler. Use the image's real reader client.
cat > /opt/scorearc/scripts/fly-match-freshness.mjs <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkScope } from './match-freshness-reader.mjs';
const digest = readFileSync('/tmp/expected-digest', 'utf8').trim();
const reader = createServer((req, res) => {
  const key = req.headers['x-scorearc-client-key'] ?? '';
  if (req.url !== '/v1/competitions/world-cup/2026/matches?scope=season&detail=summary' ||
      createHash('sha256').update(key).digest('hex') !== digest) return res.writeHead(403).end();
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-ScoreArc-Freshness': 'empty',
    'X-ScoreArc-Poll-Status': 'ok', 'X-ScoreArc-Observed-At': new Date().toISOString(),
    'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0' }).end('[]');
});
reader.listen(0, '127.0.0.1');
await once(reader, 'listening');
const result = await checkScope({ baseURL: `http://127.0.0.1:${reader.address().port}`, competition: 'world-cup', season: '2026' });
reader.close();
console.log(result.context);
console.error('watchdog diagnostics available');
writeFileSync('/tmp/results/watchdog', process.getuid() === 65532 && process.env.FLY_MONITOR_TOKEN &&
  !process.env.GRAFANA_PGPASSWORD && result.ok ? 'authorized\n' : 'failed\n');
JS
/usr/local/bin/start-operations > /tmp/startup.log 2>&1 &
launcher=$!
trap 'kill -TERM "$launcher" 2>/dev/null || true; wait "$launcher" || true' EXIT
for ((i=0; i<100; i++)); do
  [[ -s /tmp/results/watchdog && -s /tmp/results/run.sh && -s /tmp/results/loki &&
     -s /tmp/results/vector && -s /tmp/results/cloudflared ]] && break
  sleep .1
done
for service in install run.sh loki vector cloudflared; do
  grep -qx isolated "/tmp/results/$service" || { echo "Credential isolation failed: $service" >&2; exit 1; }
done
grep -qx authorized /tmp/results/watchdog || { echo 'Protected season read failed' >&2; exit 1; }
grep -qx 'watchdog diagnostics available' /tmp/startup.log || { echo 'Watchdog stderr was discarded' >&2; exit 1; }
[[ "$(< /tmp/startup.log)" != *"$SCOREARC_READER_API_KEY"* && "$(< /tmp/startup.log)" != *"$FLY_MONITOR_TOKEN"* ]]
echo 'Protected season read passed; sibling services and logs contained neither credential.'
CHECK
