# Production release runbook

Scope: T21.1 delivery of source code to Fly reader/ingester and Vercel frontend.
The [decision](../decisions/2026-09-05-ci-production-gates.md) owns the invariant;
[CURRENT_STATE §10](../CURRENT_STATE.md#10-t211-delivery-controls) records what
is actually enabled. [Architecture §11](ARCHITECTURE.md#11-production-delivery)
shows the dependency graph. This runbook does not authorize a production change.

## Release contract

`CI` validates PRs, branch pushes, main pushes and manual dispatches. The stable
`test` job includes registry exports, frontend tests/typecheck/lint/build,
database migration apply/rollback, backend race tests and vet. It is never
conditionally skipped by a dispatch ref. A feature-branch dispatch can run tests,
but cannot release or access production environments.

Production requires `needs: test` and actual success in the **same main run**.
The reusable workflow is resolved from the caller's commit, not latest main.
Scripts additionally verify repository, event (`push` or `workflow_dispatch`),
branch, workflow path, run ID, attempt, SHA, and the successful completed `test`
job. Failed, skipped, neutral, cancelled, timed-out, missing and wrong-attempt
test results never qualify. No PR artifacts or caches are promoted.

GitHub's deployment API `required_contexts` field is deliberately empty because
it checks legacy commit statuses, not the Actions job. This is not an optional
test gate: `needs: test` and the run/job API validation are mandatory.

### Paths and ordering

Each target has its own `deploy-<service>` concurrency group:
`cancel-in-progress: false`, `queue: max` (up to 100 pending jobs).
An old completion cannot evict the newest pending job. Overflow/cancelled jobs
are not releases; dispatch CI on current main if a pending job was lost.

After taking the lock, compare the last actual successful service release's SHA
with this tested SHA using full Git history, with renames represented as deletion
and addition. Never diff `HEAD^` or check out the new tip in place of the tested
SHA. A failed/stale/skipped intermediate main run cannot hide changed paths.

| Changed paths | Automatic release targets |
|---|---|
| `backend/reader/**` | reader |
| `backend/ingester/**` | ingester |
| `backend/shared/**`, `backend/config/**`, `backend/migrations/**`, `backend/go.mod`, `backend/go.sum`, `backend/.dockerignore` | both Fly services |
| `ci.yml`, `deploy-production.yml`, `scripts/production-*` | all three |
| Frontend/root build inputs, such as `src/**`, `public/**`, package files, `vercel.json` | frontend |
| Markdown, `docs/**`, `infra/**` | none |

Markdown exclusions also apply within service directories. `backend/cmd/**` is
not imported by either deployed binary. Unrelated `.github/**` changes do not
redeploy the frontend. The executable policy is `scripts/production-policy.mjs`.

With **no managed ledger baseline**, bootstrap the selected service rather than
guessing what was deployed. Therefore the first main run of this change selects
all three targets; the ingester will restart. Subsequent docs-only changes skip
when the service tree is unchanged from its last actual release. A path skip
creates no successful deployment record. An explicitly requested redeploy
ignores path filtering only after the same full CI gate.

If main advances before publication, skip the old candidate without changing its
SHA. If it advances during an inert Vercel staged build, do not promote that
build. If publication already started, finish that tested SHA under the service
lock; only then may a newer same-service job start. Reader and ingester retain
the `backend` build context and context-relative Dockerfile/config paths.
The singleton ingester retains `--ha=false` and its non-cancelling queue.

## Activation order

1. Inspect live GitHub branch protection, all effective rules, environments and
   permissions. Preserve stronger controls; do not overwrite them with a weaker
   template. The existing required check is `test`, from GitHub Actions app
   `15368`, so no new unmerged check name is needed to bootstrap protection.
2. Require PR integration into main, strict/up-to-date `test`, enforcement for
   administrators, no bypass allowances, no force pushes and no deletion. The
   initial zero-approval count supports the solo owner while still requiring a
   PR; it is not permission for direct pushes.
3. Create the three main-only environments and scoped credentials in
   [SETUP §7.6](SETUP.md#76-cicd-and-permissions). Verify replacement Fly secret
   names exist, then remove repository/organization-wide copies. Audit/revoke
   retired provider tokens separately. Do not cancel a live deployment to do this.
4. On the existing Vercel project, turn **Auto-assign Custom Production Domains
   OFF** under its production environment settings. Verify
   `autoAssignCustomDomains=false` through the project API. Keep Git fork
   protection enabled and remove/audit deploy hooks (the release guard requires
   none). Confirm no pre-existing deployment/promotion is pending. This holds
   future automatic publication; it is not a rollback or a redeploy.
5. Provision `VERCEL_TOKEN` for a dedicated **non-owner, non-administrator**
   deployment identity, scoped to the intended team and with an expiry/rotation
   owner. Use the lowest deployment-capable role available on the team's plan;
   verify permission to read project/deployment/alias metadata, stage and promote.
   Pro has a Developer role; do not assume Enterprise project-level role controls
   exist on Pro. If identity creation, plan/seat cost, token or role approval is
   unavailable, stop activation and record the blocker. Never copy a local Owner
   token into Actions as a workaround. Set the existing project's
   `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` environment variables.
6. Audit all people, integrations and tokens capable of production deployments.
   No supported manual path is local `fly deploy`, a raw image rollback,
   `vercel --prod`, dashboard Redeploy/Force Promote/Instant Rollback or an
   external deploy hook. Use CI dispatch or a revert PR. Owners can change
   these controls; the repository cannot protect itself against an account
   owner deliberately bypassing them. Restrict and audit such privileges.
7. Review the PR and require all applicable checks. Do not merge while Vercel
   credentials/permissions or production operations remain unresolved unless
   the owner explicitly accepts a continued frontend release freeze. Do not
   enable auto-merge or deploy to test this setup before authorization.
8. After human merge, observe the **actual merged SHA's** CI and provider
   outcomes below. The merged `vercel.json` disables Git-triggered main
   deployments while keeping Git previews. Leave automatic domain assignment
   OFF permanently; only the tested CI promotion publishes production.

Read-only configuration evidence:

```bash
gh api repos/mcasillas17/ScoreArc/branches/main/protection
gh api repos/mcasillas17/ScoreArc/rules/branches/main
gh api repos/mcasillas17/ScoreArc/environments
gh api repos/mcasillas17/ScoreArc/environments/production-reader/deployment-branch-policies
gh secret list --repo mcasillas17/ScoreArc --env production-reader
vercel api /v9/projects/score-arc --scope elopenmike --raw |
  jq '{id,name,autoAssignCustomDomains,link:{productionBranch:.link.productionBranch,deployHooks:.link.deployHooks}}'
```

Repeat environment-policy/secret-name checks for ingester/frontend. Never dump
authentication files, token values or Vercel environment-variable values.

## Manual delivery and rollback

Use **Actions → CI → Run workflow**, branch `main`, and choose `changed`
(default), `reader`, `ingester`, `frontend`, or `all`. Equivalent:

```bash
gh workflow run ci.yml --repo mcasillas17/ScoreArc --ref main -f release=reader
```

Dispatch pins main at workflow creation and runs the complete suite. It does not
accept an arbitrary SHA, image, old CI run or old successful PR. If main advances
while waiting, that candidate skips safely; dispatch again on the new main.
Use **Re-run all jobs**, not **Re-run failed jobs**: the release gate requires
`test` in the current attempt. A partial rerun without that test fails closed.

Rollback means a new feature-branch **revert PR**, PR validation, human merge,
then full CI on the new main SHA. Preserve delivery-control files when reverting
product code. Do not revert this gate to recover an application regression.
Schema readiness/automatic migrations are not implemented here (T21.2); confirm
binary/schema compatibility before rollback and never drop a schema dependency
under a serving binary. Missing Vercel credentials block frontend rollback too:
restore the deployment identity, not a raw dashboard bypass.

## Failure diagnosis and intentional skips

| Outcome | Meaning and response |
|---|---|
| `test` failure/skipped/missing | No release is eligible. Fix the cause through a PR or rerun full CI; do not weaken the required check. |
| `stale-main` / `current=false` | Newer main superseded this run; nothing new was published by the skipped operation. The newer run uses cumulative paths. |
| `unchanged-paths` / `not-selected` | Intentional no-op, reported in the job summary. No actual-success ledger created. |
| Missing Fly/Vercel token or IDs | Explicit failure before creating a release ledger; configure the protected environment and rerun CI. It is not a success or path skip. |
| Vercel automatic domain assignment ON, unexpected repo link/hooks | Fail closed before publication. Restore the audited settings, then rerun CI. |
| Inert staged build fails or publishing steps both skipped | Ledger `inactive`; no publishing command started. The next eligible attempt does a full service deployment. |
| Fly deploy / Vercel promotion fails, times out, or is cancelled | May have continuing provider-side effects. Ledger remains unresolved and blocks all later releases for that target until reconciled. |
| Ledger/confirmation API failure | Inspect the record and actual provider state; never manufacture a success. A missing outcome remains unresolved. |

Vercel production is `--prod --skip-domain`, followed by revalidation and
`promote --timeout 10m`. A CLI timeout **does not stop remote promotion**. After
promotion, the workflow checks the exact deployment's project/SHA/READY status,
alias assignment and the `www.scorearc.futbol` mapping, retrying propagation
confirmation three times with five-second waits. Failed confirmation is not
assumed harmless.

Preview builds are separate from production eligibility. The ignored build step
uses Vercel's immutable last-success SHA and candidate SHA. Proven docs/backend-
only ranges skip; first previews or missing/divergent/shallow history build
conservatively, with a diagnostic. There is no unsafe `HEAD^` fallback. A skipped
Vercel preview is not evidence of a production deployment.

## Interrupted-release recovery

The managed ledger is GitHub deployment task `scorearc-release`, in
`production-<service>`. Environment-only jobs do not create automatic deployment
objects. Only the provider's actual success advances a diff baseline.

```bash
gh api 'repos/mcasillas17/ScoreArc/deployments?task=scorearc-release&environment=production-frontend&per_page=1'
gh api repos/mcasillas17/ScoreArc/deployments/DEPLOYMENT_ID/statuses
gh run view RUN_ID --repo mcasillas17/ScoreArc
vercel promote status score-arc --scope elopenmike
vercel list score-arc --scope elopenmike --meta scorearcRunId=RUN_ID
fly releases --app scorearc-reader
fly status --app scorearc-reader
```

Use the applicable provider only; substitute the actual IDs/service. A stopped
GitHub job is **not** proof that provider operations stopped. Wait for/cancel the
provider operation through an authorized operator and confirm its terminal
state, actual serving deployment, and absence of pending operations. If this
cannot be established, keep the ledger blocked and escalate to the provider.

Only after the GitHub run is terminal **and** the provider state is reconciled,
record an explicit acknowledgement with the incident/evidence reference:

```bash
gh api --method POST repos/mcasillas17/ScoreArc/deployments/DEPLOYMENT_ID/statuses \
  -f state=inactive \
  -f description='Operator confirmed no pending provider operation; incident REFERENCE' \
  -F auto_inactive=false
```

Do not mark an uncertain release `success`, delete its record, or acknowledge an
active run. `inactive` never authorizes old code: it forces a full deployment on
the next **current-main, fully tested** attempt. Known-inert workflow aborts can
record inactive automatically. Newest-first ledger reads are bounded to the
latest record/status; unknown ledger identity/schema fails loudly.

## Post-merge production acceptance

1. Record the actual main merge SHA and its completed `test` job. A green PR
   tests a different integration point and is insufficient.
2. Confirm the release jobs check out that exact SHA and report the expected
   per-target base/reason. Verify no direct Vercel Git main publication occurred.
3. For each selected target, inspect the provider log and successful managed
   ledger with that SHA. Vercel must confirm its deployed metadata and canonical
   domain. Fly logs must show deployment from the same checkout/config.
4. Check reader `/healthz`, serving behavior, and exactly one started ingester
   with no duplicate-lease errors. No schema-readiness claim follows from this
   gate. Observe a later docs-only skip and deterministic stale/failure test
   evidence; never introduce deliberately bad production code for testing.
5. Update CURRENT_STATE with these observations and any remaining owner action.
   Until all targets are accepted, T21.1 is implemented but not closed.

Primary references: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments),
[Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration),
[Vercel promote](https://vercel.com/docs/cli/promote),
[Vercel roles](https://vercel.com/docs/rbac/access-roles),
[Fly app-scoped tokens](https://fly.io/docs/launch/continuous-deployment-with-github-actions/).
