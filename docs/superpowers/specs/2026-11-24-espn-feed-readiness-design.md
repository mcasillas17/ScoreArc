# ESPN feed changes and reader readiness

Operators need to know when ESPN changes roster and player biography payloads, including new statistics the current mapper ignores. Inspect responses the ingester already fetches. Compare the observed structure against a reviewed baseline from committed ESPN recordings. Preserve a bounded representative JSON fragment for each distinct change, with its endpoint, field path, kind, time and competition. Use a table with a unique key so restarts and repeated polls preserve the first example. Optional absences and ordinary new IDs or values are expected. A failed required contract must preserve previous accepted data. An unavailable diagnostics store must leave the existing ingestion validations in charge.

Grafana should show what changed and when, reader usability and freshness separately from the existing 1% live comparison. Use recorded ESPN input with a real Postgres writer and the HTTP reader in CI to verify storage and projection. Present the coverage honestly. Reuse the production Access allowlist and dashboard reader role. Migrations and deployment require the normal release process.

## Approaches

An offline shape comparison can miss short-lived data. A check limited to names and types cannot reproduce new statistics. The selected approach observes the normal fetch, stores one bounded example for review, and introduces new ScoreArc fields through the usual mapper, migration and replay workflow.
