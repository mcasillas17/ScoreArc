# Decision: exact-commit production delivery

- **Date:** 2026-09-05
- **Scope:** T21.1 source-code releases to Fly reader/ingester and Vercel frontend
- **Activation status:** [CURRENT_STATE §10](../CURRENT_STATE.md#10-t211-delivery-controls)

## Required gate

Every supported production release must follow successful full CI on the exact
main commit being deployed. A green PR, another commit's green run, a skipped
job, a path skip, a missing credential, or an operator's retry is not evidence
that code passed the gate.

Main requires PR-based integration, strict `test` checks from GitHub Actions,
admin enforcement and no force pushes/deletion. The approval-count policy is
separate: the initial setting requires a PR but not another person's approval.
Preserve any stronger policy subsequently adopted.

## Mechanism

Use `needs: test` in one workflow rather than a privileged `workflow_run`
handoff. The reusable release workflow comes from that same commit. It validates
repository, event, branch, run, attempt, SHA and actual successful `test` job.
Each target has main-only environment credentials and a non-cancelling queue.

Deploy only the immutable tested SHA, and only while it is still main when
publication starts. A newer main commit does not change an in-flight checkout.
Out-of-order old jobs skip; cumulative path filtering starts at the last actual
successful deployment, not the preceding push. Unknown provider-side effects
block further releases until reconciled; known-inert aborts do not.

Vercel's Git production deployment and live automatic domain assignment stay
disabled. CI stages without domains, revalidates and promotes, then verifies
the deployment and canonical production alias. Native Vercel checks alone were
not selected because they permit force promotion and do not supply the shared
service ordering/ledger contract.

## Supported operations and trust boundary

Manual delivery dispatches full CI on main. Rollback is a revert PR followed by
new main CI, not an old SHA/image/promotion override. Never grant owner/admin
credentials to the workflow. Provider account owners can change settings or
deploy outside the system; access control and token governance remain an owner
responsibility, not a protection this repository can enforce against its owner.

Migrations/schema readiness (T21.2), data-provider changes, and ingestion fixes
are outside this decision. Do not roll back schema underneath a dependent binary.
See the [architecture](../backend/ARCHITECTURE.md#11-production-delivery) and
[operator runbook](../backend/RELEASES.md) for the implementation and recovery path.
