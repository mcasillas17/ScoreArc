# ScoreArc operations in Grafana

The **ScoreArc operations** dashboard (UID `scorearc-operations`) combines the sampled reader trial, physical HTTP failures and p95 latency, and the ingester's poll, run and recovery records. A read-only Neon login supplies ingestion history even while the comparison trial is off. Loki stores seven days of structured request and comparison events on its persistent volume. The experiment's mismatch rate uses only comparable reads. A missing denominator displays no value.

## Origin

Run Docker Compose on an always-on host. Keep the deployment copy outside the checkout in an operator-owned directory. Keep its `.env` mode 0600 and parent directory mode 0700. On Colima, copy this directory into a path mounted in the VM. Back up the named volumes as needed. A sleeping host interrupts both the dashboard and log delivery.

1. In the existing ScoreArc database, apply [postgres.sql](postgres.sql) once as the owner. Create a dedicated login and grant it only `scorearc_grafana_read`. Use the TLS pooled endpoint and this login in Grafana. Keep the owner DSN out of the stack.
2. Supply the following values in the deployment directory's `.env`. Generate independent random secrets, for example with `openssl rand -hex 32` for each. Compose reads the receiver tokens through Docker secrets. Grafana's datasource passwords stay server-side.

| Key | Value |
| --- | --- |
| GRAFANA_ADMIN_PASSWORD, GRAFANA_SECRET_KEY | Local bootstrap admin password and stable Grafana encryption key |
| GRAFANA_PGHOST, GRAFANA_PGDATABASE, GRAFANA_PGUSER, GRAFANA_PGPASSWORD | Dedicated Neon login, pooled host with port, and database. PostgreSQL defaults to verify-full TLS. |
| VERCEL_PROJECT | ScoreArc's Vercel project ID |
| VERCEL_DRAIN_TOKEN, FLY_SHIPPER_TOKEN | Independent bearer tokens for each sender |
| GRAFANA_ROOT_URL | Production address `https://grafana.scorearc.futbol` |
| TUNNEL_TOKEN | Remotely managed tunnel connector token, added after creating the protected routes |

For local verification, use a local root URL or omit it and run `docker compose -f compose.yaml -f local.yaml up -d`. Open `http://127.0.0.1:3432/d/scorearc-operations` using the local Grafana login. Only loopback sockets are published. Local mode uses Grafana authentication.

## Cloudflare Access

The files under [cloudflare](cloudflare/main.tf) manage a self-hosted Access application, an explicit email allowlist, a named tunnel and two proxied DNS records. Complete Zero Trust onboarding and enable an email-capable login method (one-time PIN or an existing identity provider). Supply the account and zone IDs, the exact Zero Trust team name, and the operator email set in a private tfvars file. Supply a scoped Cloudflare API token through `CLOUDFLARE_API_TOKEN` with Access application/policy, Tunnel and zone DNS edit permissions. Use the following from a protected deployment copy of the cloudflare directory.

```sh
umask 077
tofu init
tofu plan -out=operations.tfplan
tofu apply operations.tfplan
```

Review the proposed records against existing DNS and Access applications. Keep state, plans and operator addresses outside version control. From the tunnel's connector setup, put the connector token in the origin's `.env`. From the origin directory run:

```sh
docker compose -f compose.yaml -f tunnel.yaml --profile tunnel up -d
```

Use only the two files in that command for the public deployment. The production configuration publishes zero host ports. The tunnel verifies the signed Access audience before forwarding the authenticated email to Grafana. Grafana assigns first-time operators the Viewer role. Browser traffic to `grafana.scorearc.futbol` uses Access. On `telemetry.scorearc.futbol`, only the two exact collector paths reach Vector; each requires its own provider credential.

Check that a fresh browser is challenged, the allowed email sees the dashboard, an unlisted email is denied, and either telemetry endpoint rejects a request without its bearer. The base Compose configuration keeps Loki and its write API private.

## Live events

- **Vercel.** Create a production runtime log drain for the ScoreArc project. Use the **JSON** delivery format, 100% drain sampling, destination `https://telemetry.scorearc.futbol/vercel` and a custom `Authorization: Bearer <VERCEL_DRAIN_TOKEN>` header. The receiver checks the project and environment, deduplicates provider log IDs in Vector's bounded in-memory cache, and discards unrelated events. Select the runtime sources needed for the Node and Edge handlers. The dashboard measures observed application executions. Vercel CDN-only hits remain available separately through the [offline report](../../docs/backend/READER_DATASTORE.md#health-telemetry-and-dashboard-data).
- **Fly.** Deploy [fly/fly.toml](fly/fly.toml) from its directory as a private, single-instance app in the same Fly organization and network as the reader and ingester. The two NATS subscriptions select only those services. Create an org read-only log token. Set the new shipper app's `SHIPPER_CREDENTIALS` secret to the base64 encoding of a JSON object with keys `org`, `fly` (the log token) and `receiver` (the value of `FLY_SHIPPER_TOKEN`). Fly materializes this secret as a private file for Vector. Deploy with `fly deploy --ha=false`. The shipper needs no public IP or service.
- **Producers.** Set `SCOREARC_HTTP_TELEMETRY=1` on participating Go services to generate per-attempt health events. Enabling the frontend trial is a separate production traffic decision. Use the [trial settings](../../docs/backend/READER_DATASTORE.md#sampled-reader-trial) when approved. Check each service by filtering the dashboard, including a real sampled read. Collection outages and source sampling affect observed counts. Fly log streaming does not reconstruct missed history.

To close remote access, stop the tunnel connector. To stop exports, disable the Vercel drain and stop the dedicated fly shipper. Persistent volumes survive a normal Compose shutdown. Rotate source credentials at both ends together.

## Verification

Run `tests/smoke.sh` from a Docker-accessible checkout or deployment copy. The test starts disposable Loki and receiver containers, posts representative Vercel and Fly events, checks credential separation and field filtering, runs the dashboard's LogQL queries, and removes only its own containers and volumes. For Neon, use Grafana's datasource health check and the three ingester panels. With the dedicated login, selecting the raw ingest error column must be denied.

[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app/) · [Fly log shipping](https://github.com/superfly/fly-log-shipper) · [Vercel drains](https://vercel.com/docs/drains/using-drains)
