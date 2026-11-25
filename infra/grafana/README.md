# ScoreArc operations in Grafana

The **ScoreArc operations** dashboard (UID `scorearc-operations`) combines the sampled reader trial, resource age, ESPN feed changes, physical HTTP failures and p95 latency, and the ingester's poll, run and recovery records. A read-only Neon login supplies ingestion history and captured changes even while the comparison trial is off. Loki retains seven days of structured telemetry.

## Reading the readiness panels

- **Reader usability** counts each completed sampled logical read once. A usable result requires a successful reader return and zero reported reader dependency faults. A swallowed dependency failure counts as unavailable. Both usable and unavailable reads count when ESPN fails. Verify the count by endpoint in the adjacent panel. The disagreement rate still uses only comparable reads. Controls, news and events from before the reader-result field shipped contribute to neither the usability numerator nor its denominator. An empty interval has no rate.
- **Resource age** measures the oldest known observation at read time within each interval. Resource evidence includes checks on cached responses and stale required resources rejected by the reader policy. The evidence counts distinguish an unknown clock from a finalized resource. A resource with both clocks counts as finalized. A read that fails before producing valid metadata can contribute to the usability panel without an age sample.
- **ESPN feed changes** shows the latest 100 distinct changes first seen or last recorded in the selected window. Intermediate hourly sightings contribute to the count. Only the first and last times are retained. Inspection covers valid roster and player biography JSON up to 2 MiB. The ingester retains up to 32 findings per response, a 1 KiB representative fragment for each signature and 1,024 signatures per endpoint and change kind. Subsequent sightings advance the recorded time at most once per UTC hour. Check `fly logs -a scorearc-ingester` for queue drops and failed or capacity-limited writes if expected changes are absent.
- **Recorded replay coverage** links to CI and its roster and biography cases. Use the backend job for the commit under review to see its result. These checks run against Postgres and HTTP handlers independently of the live sample.

### Reviewing an ESPN change

Open the **ESPN feed changes** row to see the provider path, its first request competition and a bounded example. The biography sweep uses one ESPN competition namespace for players across all editions. For an added field or named statistic, check its meaning and units against examples from the relevant competitions. If ScoreArc should use it, add a recorded case and expected reader fields, update the mapper and persistence as needed, then replay it through Postgres and the HTTP reader. Mark an intentionally unused shape as reviewed in the detector baseline to stop recording new sightings. The first discovery remains available in its original time range.

For a missing required field, unexpected status or changed type, check the corresponding ingester run and the most recent accepted observation. Optional fields can vary across players and competitions. Use a replay that reproduces the provider change before updating the contract.

## Origin

Production uses one always-on Fly Machine in IAD. Grafana, Loki and both telemetry receivers bind to loopback. Cloudflare Tunnel provides the only public routes. The Fly log subscriptions run on the same Machine. The encrypted `operations_data` volume holds the Grafana database, Loki records and Vector buffer. A host outage interrupts collection until the Machine recovers.

For a local preview or a separate Docker Compose host, keep the deployment copy outside the checkout in an operator-owned directory. Keep its `.env` mode 0600 and parent directory mode 0700. On Colima, copy this directory into a path mounted in the VM. Back up the named volumes as needed. A sleeping host interrupts both the dashboard and log delivery.

1. In the existing ScoreArc database, apply [postgres.sql](postgres.sql) once as the owner. Create a dedicated login and grant it only `scorearc_grafana_read`. Use the TLS pooled endpoint and this login in Grafana. Keep the owner DSN out of the stack.
2. Supply the following values through Fly app secrets in production or in the local deployment directory's `.env`. Generate independent random secrets, for example with `openssl rand -hex 32` for each. Compose reads the receiver tokens through Docker secrets. Grafana's datasource passwords stay server-side.

| Key | Value |
| --- | --- |
| GRAFANA_ADMIN_PASSWORD, GRAFANA_SECRET_KEY | Local bootstrap admin password and stable Grafana encryption key |
| GRAFANA_PGHOST, GRAFANA_PGDATABASE, GRAFANA_PGUSER, GRAFANA_PGPASSWORD | Dedicated Neon login, pooled host with port, and database. PostgreSQL defaults to verify-full TLS. |
| VERCEL_PROJECT | ScoreArc's Vercel project ID |
| VERCEL_DRAIN_TOKEN, FLY_SHIPPER_TOKEN | Independent bearer tokens for each sender |
| GRAFANA_ROOT_URL | Production address `https://grafana.scorearc.futbol` |
| TUNNEL_TOKEN | Remotely managed tunnel connector token, added after creating the protected routes |

For local verification, use a local root URL or omit it and run `docker compose -f compose.yaml -f local.yaml up -d`. Open `http://127.0.0.1:3432/d/scorearc-operations` using the local Grafana login. Only loopback sockets are published. Local mode uses Grafana authentication.

### Deploy the dedicated Fly Machine

From `infra/grafana`, create app `scorearc-observability` in the same Fly organization and private network as the two Go services. Create a 10 GB encrypted `operations_data` volume in `iad`. Supply the credentials above with `fly secrets import --stage` through private stdin, including the encoded `SHIPPER_CREDENTIALS` described below. Run `fly deploy --ha=false --no-public-ips` using this directory as build context. The Docker build context contains only the dashboard, provisioning files and service configuration. Before the tunnel is active, use Fly SSH on the Machine to check `http://127.0.0.1:3000/api/health` and `http://127.0.0.1:3100/ready`. The Fly Machine defines no public service.

## Cloudflare Access

The files under [cloudflare](cloudflare/main.tf) manage a self-hosted Access application, an explicit email allowlist, a named tunnel and two proxied DNS records. Complete Zero Trust onboarding and use an identity provider that verifies the operator email. The production app uses Cloudflare account sign-in. Supply the account and zone IDs, the exact Zero Trust team name, and the operator email set in a private tfvars file. Supply a scoped Cloudflare API token through `CLOUDFLARE_API_TOKEN` with Access application/policy, Tunnel and zone DNS edit permissions. Use the following from a protected deployment copy of the cloudflare directory.

```sh
umask 077
tofu init
tofu plan -out=operations.tfplan
tofu apply operations.tfplan
```

For an existing deployment, import any resources originally created in the Cloudflare dashboard into the deployment state before applying. Import the reusable policy (`cloudflare_zero_trust_access_policy.operators`, `<account_id>/<policy_id>`), the application (`cloudflare_zero_trust_access_application.grafana`, `accounts/<account_id>/<app_id>`) and each `cloudflare_dns_record.operations["<hostname>"]` (`<zone_id>/<record_id>`). Use the provider's read/write token to refresh and review the resulting plan.

Review the proposed records against existing DNS and Access applications. Keep state, plans and operator addresses outside version control. For Fly, set the connector token as the `TUNNEL_TOKEN` secret on `scorearc-observability`. Its entrypoint enables Grafana proxy authentication only when the connector starts. For a Compose host, explicitly set `fly_origin = false` in the private tfvars and put the connector token in the origin's `.env`. From the Compose origin directory run:

```sh
docker compose -f compose.yaml -f tunnel.yaml --profile tunnel up -d
```

The Compose tunnel configuration publishes zero host ports. The tunnel verifies the signed Access audience before forwarding the authenticated email to Grafana. Grafana assigns first-time operators the Viewer role. Browser traffic to `grafana.scorearc.futbol` uses Access. On `telemetry.scorearc.futbol`, only the two exact collector paths reach Vector; each requires its own provider credential.

Check that a fresh browser is challenged, the allowed email sees the dashboard, an unlisted email is denied, and either telemetry endpoint rejects a request without its bearer. The base Compose configuration keeps Loki and its write API private.

## Live events

- **Vercel.** Create a production runtime log drain for the ScoreArc project. Use the **JSON** delivery format, 100% drain sampling, destination `https://telemetry.scorearc.futbol/vercel` and a custom `Authorization: Bearer <VERCEL_DRAIN_TOKEN>` header. The receiver checks the project and environment, deduplicates provider log IDs in Vector's bounded in-memory cache, and discards unrelated events. Select the runtime sources needed for the Node and Edge handlers. The dashboard measures observed application executions. Vercel CDN-only hits remain available separately through the [offline report](../../docs/backend/READER_DATASTORE.md#health-telemetry-and-dashboard-data).
- **Fly.** On the dedicated Machine, set the `SHIPPER_CREDENTIALS` secret as described below. The log subscriptions forward to the local receiver. For a Compose origin outside Fly, deploy [fly/fly.toml](fly/fly.toml) from its directory as a private, single-instance app in the same Fly organization and network as the reader and ingester. The two NATS subscriptions select only those services. Create an org read-only log token. Set the shipping app's `SHIPPER_CREDENTIALS` secret to the base64 encoding of a JSON object with keys `org`, `fly` (the log token) and `receiver` (the value of `FLY_SHIPPER_TOKEN`). Use a bounded token lifetime and rotate it before expiry. Vector reads the credentials from a private file. Only the standalone shipper deployment needs its own app.
- **Producers.** Set `SCOREARC_HTTP_TELEMETRY=1` for the Vercel production environment and the Go reader and ingester. The shipper also reads the existing Go reader access log, projecting known route templates, status and elapsed time. That format omits successful health probes. The instrumented reader emits a single event in place of that access log. Per-attempt Go dependency events require a release containing the HTTP instrumentation. In ESPN-only mode the website records requests and upstream latency and makes zero comparison calls. Enabling the frontend trial is a separate production traffic decision. Use the [trial settings](../../docs/backend/READER_DATASTORE.md#sampled-reader-trial) when approved. Check each service by filtering the dashboard, including a real sampled read. Collection outages and source sampling affect observed counts. Fly log streaming does not reconstruct missed history.

To close remote dashboard access on Fly, remove the Access allow policy or run `fly secrets unset TUNNEL_TOKEN -a scorearc-observability`. Removing the token restarts the Machine and closes both public hostnames. The private Fly log subscriptions resume after the restart. Stopping the connector process alone restarts the stack with the same token. On Compose, stop the tunnel service. To stop exports, disable the Vercel drain and the producer telemetry flags. Persistent volumes survive a normal Compose shutdown. Rotate source credentials at both ends together.

## Verification

Run `tests/smoke.sh` from a Docker-accessible checkout or deployment copy. The test starts disposable Loki and receiver containers, posts representative Vercel and Fly events, checks credential separation and field filtering, runs the dashboard's LogQL queries, and removes only its own containers and volumes. For Neon, use Grafana's datasource health check and the ingester and feed-change panels. Deploy migration 0031 before the updated dashboard. It grants access to the existing Grafana role. For a first-time install run the current `postgres.sql` after migrating. With the dedicated login, selecting the raw ingest error column must be denied.

[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app/) · [Fly log shipping](https://github.com/superfly/fly-log-shipper) · [Vercel drains](https://vercel.com/docs/drains/using-drains)
