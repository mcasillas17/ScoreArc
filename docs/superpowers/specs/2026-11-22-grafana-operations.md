# ScoreArc operations dashboard

Operators need one read-only dashboard to decide whether ScoreArc agrees with ESPN and to distinguish stale ingestion, reader failures and upstream outages. Use Grafana, Loki for structured events from Vercel and Fly, and PostgreSQL for the existing ingester audit and last-poll state. The database login can select only the columns the panels query. The dashboard must distinguish comparable, inconclusive and failed reads from HTTP requests and cancellations. A period with no comparable reads has no mismatch rate.

Publish the dashboard through a named Cloudflare Tunnel and Access policy with explicitly approved individual emails. Keep the origin private. Only the telemetry receiver accepts authenticated machine traffic and it accepts only the supported structured event fields. Hosting configuration, telemetry flags and production experiment activation are distinct operations.
