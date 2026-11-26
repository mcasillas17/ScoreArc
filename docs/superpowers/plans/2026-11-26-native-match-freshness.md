# Native match freshness handoff

Implement the [design](../specs/2026-11-26-native-match-freshness.md) on a feature branch.

- [x] Extract the portable checkpoint logic. Run `npx vitest run scripts/match-freshness-monitor.test.ts scripts/match-freshness-workflow.test.ts`. Expect identical GitHub state and delivery behavior.
- [x] Add the D1 singleton and native tick handler. Run `npx vitest run infra/alert-receiver`. Cover duplicate ticks, overlapping ticks, retries, queue ordering, recipient failures and heartbeat gating.
- [x] Validate and import the final GitHub artifact. Run `npx vitest run scripts/cutover-match-freshness.test.ts`. Reject an active writer, a stale or failed run, an invalid checkpoint and a repeat import.
- [x] Exercise the receiver in local workerd with isolated D1. Run the repository checks and document operator commands for handoff, verification, pausing and recovery.
