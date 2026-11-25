# ESPN feed readiness implementation plan

**Goal** Detect additions and contract failures in the roster and biography feeds and show them alongside independent reader readiness evidence.

**Architecture** Observe raw ESPN responses before mapping. Compare against reviewed recorded shapes and named statistics. Store distinct findings through the ingester role and query the operator data from the provisioned Grafana dashboard.

**Tech stack** Go, Postgres, TypeScript, Loki and Grafana.

**Spec** [ESPN feed changes and reader readiness](../specs/2026-11-24-espn-feed-readiness-design.md)

## Tasks

- [x] Add bounded shape inspection under backend/shared/feeddrift. Cover optional fields, array paths, new statistics, breaking contracts, example limits and known ESPN recording baselines with Go tests.
- [x] Add migration 0031, a writer and integration tests for deduplication, retry safety, first evidence and restricted read access. Connect the source and the production ingester. Confirm an observation failure does not break a valid poll.
- [x] Add drift and reader readiness panels, including request-time usability and data age. Retain the existing live disagreement denominator. Trace recorded roster and biography responses through writer and reader paths in CI.
- [x] Run backend build, race tests and vet, website tests and typecheck, and Grafana checks. Inspect the served dashboard, document the release procedure and prepare the release PR.
