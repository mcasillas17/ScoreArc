# Grafana dashboard split implementation plan

**Goal** Give operators a compact home and four focused investigations with a shared time window.

- [x] In the dashboard smoke test, discover the provisioned files, assert the expected panel ownership and navigation, then exercise every LogQL target using the existing denominator cases. Point the feed-change database test at its new dashboard.
- [x] Partition the existing panels into five files under `infra/grafana/dashboards`. Keep the original overview UID and place panels at the top of each dashboard. Use a shared, suite-specific tag for Grafana links.
- [x] Update the operations guide and archive verification links. Run the structural, Loki and database checks. Open the local Grafana overview, follow its links with a fixed time range, and verify the resulting panels.
