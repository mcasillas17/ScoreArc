# Fly watchdog handoff

Implement the [design](../specs/2026-11-26-fly-match-freshness.md) on a feature branch.

- [x] Verify machine, disk, memory, deployment access and a complete season scan from the actual Fly machine as the watchdog UID.
- [x] Share reader and checkpoint logic with GitHub and run the five-minute scheduler on Fly. Replay a failure and recovery, including both emails and the heartbeat, against real SQLite.
- [x] Implement receiver lease fencing and the GitHub handoff in both directions. Cover overlapping claims, pending and final writes, FIFO retries, stale receipts, failed restore and invalid artifact provenance.
- [x] Package the runtime with the existing monitoring services, verify its image and document deployment and rollback. Validate with Vitest, TypeScript, ESLint, actionlint and a local Worker bundle.
