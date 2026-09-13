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
The `production` matrix in `ci.yml` runs ordinary jobs, each directly bound to
`production-${{ matrix.service }}`. There is no reusable release workflow.
Every job checks out `github.sha`, not latest main, and resolves only its selected
service's credential. Secrets stay in their existing protected environments.
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
| `ci.yml`, `scripts/production-*`, historical removal of `deploy-production.yml` | all three |
| Frontend/root build inputs, such as `src/**`, `public/**`, package files, `vercel.json` | frontend |
| Markdown, `docs/**`, `infra/**` | none |

Markdown exclusions also apply within service directories. `backend/cmd/**` is
not imported by either deployed binary. Unrelated `.github/**` changes do not
redeploy the frontend. The executable policy is `scripts/production-policy.mjs`.

With **no managed ledger baseline**, bootstrap the selected service rather than
guessing what was deployed. The September 13 read found successful reader and
ingester entries at `0f75102`, and unresolved frontend entry `6404319208`.
Recheck these records before activation; do not erase the frontend failure.
Changing `ci.yml` or `scripts/production-*` selects all three
against an older baseline. Subsequent docs-only changes skip
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
3. Inspect the three main-only environments and scoped credentials in
   [SETUP §7.6](SETUP.md#76-cicd-and-permissions); preserve existing protections.
   Secret names are not proof that nonempty values reach a job. Use the
   [non-deploying preflight](#non-deploying-credential-preflight) to diagnose
   access before replacing tokens. Credential creation/replacement and removal
   of repository/organization-wide copies require explicit owner authorization.
   Audit/revoke retired provider tokens separately. Do not cancel a live
   deployment to do this.
4. On the existing Vercel project, turn **Auto-assign Custom Production Domains
   OFF** under its production environment settings. Verify
   `autoAssignCustomDomains=false` through the project API. Keep Git fork
   protection enabled and remove/audit deploy hooks (the release guard requires
   none). Confirm no pre-existing deployment/promotion is pending. This holds
   future automatic publication; it is not a rollback or a redeploy.
5. `VERCEL_TOKEN` **was supplied on 2026-09-11** to `production-frontend` for
   team Spider (`elopenmike`), project `score-arc`. Do not provision it again
   merely because the old reusable path could not see it. Verify the supplied
   identity is **non-owner, non-administrator**, scoped to the intended team,
   with an expiry/rotation owner. Use the lowest deployment-capable role available on the team's plan;
   verify permission to read project/deployment/alias metadata, stage and promote.
   This is a **project-scoped token**: keep that scope. Promotion uses the
   project-specific API, not the CLI's account-level user lookup.
   Pro has a Developer role, but that alone does not establish permission for
   production CLI staging or promotion. Verify a supported non-admin grant for
   those operations on the actual plan; see [SETUP](SETUP.md#vercel-deployment-identity).
   Do not assume Enterprise project-level role controls exist on Pro.
   If permissions or identity cannot be confirmed, stop activation and record
   the blocker; changes need separate approval. Never copy a local Owner token
   into Actions as a workaround. The existing project's `VERCEL_ORG_ID` and
   `VERCEL_PROJECT_ID` were also present in the ordinary-job report.
6. Audit all people, integrations and tokens capable of production deployments.
   No supported manual path is local `fly deploy`, a raw image rollback,
   `vercel --prod`, dashboard Redeploy/Force Promote/Instant Rollback or an
   external deploy hook. Use CI dispatch or a revert PR. Owners can change
   these controls; the repository cannot protect itself against an account
   owner deliberately bypassing them. Restrict and audit such privileges.
7. Review the PR and require all applicable checks. Before merge, explain and
   obtain authorization for any releases its main CI may select, including a
   possible ingester restart. A diagnostic-only change can still select all
   targets (`scripts/production-*`, or no managed baseline). Missing credentials
   are a failure, not an approval mechanism; a blocked frontend does not hold
   the Fly jobs. Leave the PR unmerged without this authorization. Unresolved
   credential/provider operations and a continued release freeze must be
   explicitly accepted by the owner, never mistaken for completed activation.
   Do not enable auto-merge or deploy merely to test setup.
8. After human merge, observe the **actual merged SHA's** CI and provider
   outcomes below. The merged `vercel.json` disables Git-triggered main
   deployments while keeping Git previews. Leave automatic domain assignment
   OFF permanently; only the tested CI promotion publishes production.

**Publication requires authorization or a hold arranged BEFORE merge.** Merging
this correction starts full main CI and can automatically publish all three
services; the separate diagnostic does not pause those jobs. If presence
acceptance must happen first, the owner must confirm a protected-environment
approval hold for **all three release jobs**, approve only the diagnostic jobs,
and leave publication awaiting separate authorization. Do not weaken protections,
disable required CI, rely on absent credentials, or assume a frontend failure
holds Fly. If a suitable hold is not already available, leave the PR unmerged
until the owner authorizes an activation plan and any necessary protection
configuration. Do not recommend merge before this decision. A queued release
is not permission to recover the suspended ingester or destroy its standby.

**September 13 activation baseline:** the three environments had main-only
branch policies but **no required-reviewer approval holds**. PR #161 already
proved credential delivery in the ordinary production jobs. This follow-up
changes `ci.yml` and `scripts/production-*`, so reader and ingester releases
are selected against their `0f75102` baselines; frontend preparation remains
blocked by ledger `6404319208` until separately reconciled. A frontend failure
does not hold either Fly job. Leave this PR unmerged until the owner authorizes
those automatic releases or approves and verifies suitable holds on all three
jobs. Do not change credentials or protections as an implicit part of merging.

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

## Eligibility rejection diagnostics

The first `assertReleaseContext` guard retains all fourteen requirements and
reports only the **names** of checks that failed, for example:

```text
Release requires this repository's active main CI run and exact tested SHA; failed checks: runStatus
```

These are constant labels, not raw process context, API response values or
credentials. All checks must pass; naming a failure does not make it retryable
or optional.

| Failed check names | Required condition |
|---|---|
| `contextRepository`, `contextRef`, `contextEvent`, `workflowRef` | This repository's main `CI` push/dispatch context and caller workflow. |
| `runRepository`, `headRepository`, `runId`, `runAttempt`, `runEvent`, `runBranch`, `runSha`, `runWorkflow` | API run identity matches that context, including the exact main SHA and current attempt. |
| `runStatus`, `runConclusion` | The API run is `in_progress` with a null conclusion. Queued, waiting, pending, completed or cancelled candidates are not accepted. |

Malformed SHA syntax still fails its earlier validation. The separate
`Required test job is not successful in this attempt` error checks the unique,
completed successful `test` job's run, attempt and SHA; do not conflate it with
the first guard.

For a rejection, preserve the failed labels with the run ID, attempt, selected
service, step and timestamp already shown by Actions. Correlate that evidence
without dumping tokens or complete contexts. A terminal API read after the job
ends cannot reconstruct what the earlier request returned. In particular,
`runStatus` alone does not prove a transient scheduling/cache race. No refetch,
automatic retry or eligibility relaxation is implemented here; cancelled,
wrong-SHA and wrong-attempt runs continue to fail closed.

Run `34077227730` predates these labels: both Fly jobs failed this first guard,
while frontend passed it later and then failed credentials. Its historical
rejecting predicate remains unknown. The new diagnostics repair that ambiguity,
not the production failure itself. See
[CURRENT_STATE §10](../CURRENT_STATE.md#10-t211-delivery-controls) for evidence
and the separately authorized main-runtime confirmation still required.

## Non-deploying credential preflight

`production-credentials.yml` is a separate, manually dispatched workflow. Its
single ordinary `probe` matrix job binds the selected `production-<service>`
environment with `deployment: false`, matching production's job type, matrix,
environment binding and service-specific credential selection. It uses pinned
actions, read-only permissions and the exact dispatched SHA, with no secret
inheritance, provider commands or managed deployment records.
`production-credential-probe.yml` and `deploy-production.yml` are removed;
`ci.yml` is the only production mechanism. This diagnostic does **not** run,
replace or authorize the full release CI gate. It intentionally omits release
permissions, the service publication queue and provider steps: none is needed
to measure environment-secret presence.

### Why the topology changed

The old comparison ran both ordinary and matrix-to-reusable jobs against
`5a31554402c2f406e3c7d6b6e77d0e7dc9eb14cd` with the same saved credentials:

| Service / report | Ordinary job | Reusable job |
|---|---|---|
| Reader [34100370795](https://github.com/mcasillas17/ScoreArc/actions/runs/34100370795) | `token_present=true` | `token_present=false` |
| Ingester [34100370559](https://github.com/mcasillas17/ScoreArc/actions/runs/34100370559) | `token_present=true` | `token_present=false` |
| Frontend [34576989906](https://github.com/mcasillas17/ScoreArc/actions/runs/34576989906) | token, org ID and project ID all present | token absent; both IDs present |

The reusable failures emitted valid boolean JSON; they did not fail before
measurement. The frontend comparison followed the user's September 11 token
provisioning. This establishes a **workflow-context access difference**, not an
empty saved token, a provider authorization failure, or the underlying GitHub
platform cause. GitHub documents environment secrets on both ordinary and
reusable environment-bound jobs, including `deployment: false`; missing
`secrets: inherit` is not evidence of the cause. The correction uses the measured
working ordinary-job structure, without moving, replacing or broadly inheriting
credentials. **PR #161's run `34663184517` subsequently accepted credential
delivery in all three ordinary production jobs.** Actual frontend promotion,
ingester recovery and fresh-data acceptance remain outstanding.

### Conditional access diagnostics on main

Only this repository's `workflow_dispatch` on branch `main` is allowed.
Feature branches, tags, PRs, forks and other callers are rejected before the
protected job runs. Do not weaken environment rules to try an unmerged probe.
Local tests cover the script and wiring, not GitHub's live secret injection.
The diagnostic is already merged. Use these retained non-deploying commands
only when access is in doubt and dispatch is explicitly authorized; they are
not another mandatory acceptance step for PR #161. Any future diagnostic change
still requires the [pre-merge activation decision](#activation-order) before
merging, because release selection is independent:

```bash
gh workflow run production-credentials.yml --repo mcasillas17/ScoreArc \
  --ref main -f service=reader
gh workflow run production-credentials.yml --repo mcasillas17/ScoreArc \
  --ref main -f service=ingester
gh workflow run production-credentials.yml --repo mcasillas17/ScoreArc \
  --ref main -f service=frontend
gh run list --repo mcasillas17/ScoreArc --workflow production-credentials.yml \
  --branch main --event workflow_dispatch --limit 3
gh run view RUN_ID --repo mcasillas17/ScoreArc --log
```

Record each actual run ID, attempt, service and `headSha`; verify that it contains
this correction (dispatch pins main when the run is created). Inspect the
`probe (reader)`, `probe (ingester)` or `probe (frontend)` job's actual JSON, not
just its conclusion. Do not edit secrets during acceptance. Each prints only booleans:
`token_present`, `control_present`, `org_id_present`, `project_id_present`.
Step expressions pass the Node probe only presence booleans for these fields,
not raw credential or identifier values. This is a probe-process/logging
boundary, **not a secret-free runner**: the environment-bound Actions runner
evaluates the expressions with its secrets context, and the referenced actions
remain trusted with secret material. Keep the main-only guards and pinned actions.
For Fly, only the selected app token is required; frontend requires its token
and both identifiers. These booleans prove neither token validity/expiry nor
provider authorization.

A red job **with JSON plus `Required credentials absent; no deployment attempted`**
is an expected measured absence/inaccessibility, not a successful release or a
path skip. A guard/tool failure without JSON is not a measurement. A green job
means required values were present; it still did not publish anything.

If the job reports an absent token, an owner may separately authorize an
optional, known-nonempty **non-sensitive** `CREDENTIAL_PREFLIGHT_CONTROL` value
in that exact production environment. Choose a distinctive, whitespace-free
marker: `scorearc-preflight-` followed by a newly generated UUID. Never use
`true`, `false`, a report field name or a short/common word: Actions masks secret
values in logs, which can obscure the booleans or keys being measured. If a
report contains masked `***` tokens, it is unusable evidence, not an absent
credential; investigate setup with the owner rather than disabling masking or
printing secret values.

Use the environment's Secrets UI, not repository/organization storage, and
verify no same-named broader-scope secret can contaminate the control. Never use
a real credential as the control. No control is provisioned by this workflow.
Without verified control setup, `control_present=false` is inconclusive.

| New-topology observation | Interpretation and next action |
|---|---|
| Required values present | New ordinary matrix job received them. This is not proof of validity, expiry, provider permissions, successful release, or ingester recovery. |
| Token absent, verified environment control present | General environment-secret access works; investigate the selected secret's name, scope and value delivery. Do not replace credentials speculatively. |
| Token and control absent | Inconclusive without verified control setup; inspect protections, scope and context. Do not label the stored token empty. |
| Frontend token present, either identifier absent | Restore the exact existing project's environment variables after authorization; do not create a new project. |

Keep activation blocked if required values are absent; escalate with run IDs and
boolean reports only. Do not move tokens to repository/organization scope or
inherit all secrets. Any replacement needs separate consent. A successful
presence check still leaves provider permission acceptance and any ingester
recovery for separately authorized operations. Record results in
[CURRENT_STATE §10](../CURRENT_STATE.md#10-t211-delivery-controls).

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
| `Release requires ...; failed checks: ...` | Run/context eligibility failed before credential validation or publication. Follow the [named-check diagnosis](#eligibility-rejection-diagnostics); do not weaken guards or treat this as a missing-token failure. |
| `test` failure/skipped/missing | No release is eligible. Fix the cause through a PR or rerun full CI; do not weaken the required check. |
| `stale-main` / `current=false` | Newer main superseded this run; nothing new was published by the skipped operation. The newer run uses cumulative paths. |
| `unchanged-paths` / `not-selected` | Intentional no-op, reported in the job summary. No actual-success ledger created. |
| Fly token absent at the release step | Explicit failure before the ledger. Use the [ordinary-job preflight](#non-deploying-credential-preflight) and inspect selected service/environment; neither name metadata nor a negative output proves empty storage. Do not replace the token speculatively. |
| Vercel token or IDs absent | Explicit failure before the ledger. A known-missing identity/token follows [SETUP](SETUP.md#vercel-deployment-identity) after owner consent; verify identifiers against the existing project. A name that exists but delivers no value requires preflight diagnosis. Neither outcome is a success or path skip. |
| Vercel automatic domain assignment ON, unexpected repo link/hooks | Fail closed before publication. Restore the audited settings, then rerun CI. |
| Inert staged build fails or publishing steps both skipped | Ledger `inactive`; no publishing command started. The next eligible attempt does a full service deployment. |
| Fly deploy / Vercel promotion fails, times out, or is cancelled | May have continuing provider-side effects. Ledger remains unresolved and blocks all later releases for that target until reconciled. |
| Ledger/confirmation API failure | Inspect the record and actual provider state; never manufacture a success. A missing outcome remains unresolved. |
| `Unrecognized production ledger entry` | Provenance/schema did not match. Do not erase records or mark them inactive to bypass validation. Older code incorrectly required optional app metadata; see the Actions-creator contract below and main run `34741032755`. |

### Project-scoped Vercel promotion

Staging still uses pinned CLI `59.11.7` with `--prod --skip-domain`. After
the exact-SHA revalidation step, `production-release.mjs promote-vercel`:

1. Reads the configured project and resolves the staged hostname through the
   fixed `https://api.vercel.com` origin. Requires the expected project/team,
   automatic domain assignment OFF, a validated deployment ID, production
   target, `READY`, and matching SHA/run ID/attempt metadata.
2. Sends **one** `POST /v10/projects/{projectId}/promote/{deploymentId}` with
   `{}`. The documented responses are `201` and `202`, with no required JSON
   body. `202` means accepted/queued, not deployed.
3. Reads the project with `rollbackInfo=true` both before POST and while polling
   `lastAliasRequest`, requiring a new `promote` record for
   that immutable deployment. `pending`/`in-progress` wait; `failed`, `skipped`
   and unknown matching-job states fail. An older/different job never proves
   success. The overall deadline is ten minutes, with at most 120 polls,
   five-second waits and individual requests bounded to 30 seconds.
4. After `succeeded`, checks the same immutable deployment's readiness and
   tested metadata, successful alias assignment, and the exact
   `www.scorearc.futbol` project/deployment mapping. Propagation confirmation
   gets three attempts with five-second waits, still under the overall deadline.

The project endpoint returns `lastAliasRequest: null` without
`rollbackInfo=true`, even after a successful promotion. Always retain this
query parameter alongside `teamId`; a null value from the default project read
does not establish that no promotion is pending. This is also the parameter
used by CLI 59.11.7's promotion-status lookup.

Tokens remain in environment variables and authorization headers, never command
arguments. No `/v2/user`, team-resource lookup, response-provided callback URL,
redirect, or broader credential fallback is used. Project tokens support their
own project's reads/writes; a real `401`/`403` still blocks publication.

The earlier CLI `User not found. (404)` is consistent with its account-level
`getScope`/`getUser` path being incompatible with project tokens. Source/mock
evidence establishes that path, **not a historical HTTP trace of the failed
provider request**. Adding `--scope` is not the correction.

**A timeout does not cancel remote promotion.** There is no automatic POST retry.
Any uncertain API/confirmation outcome leaves the release unresolved for operator
reconciliation; neither `201`/`202` nor job success alone advances the ledger.

Preview builds are separate from production eligibility. The ignored build step
uses Vercel's immutable last-success SHA and candidate SHA. Proven docs/backend-
only ranges skip; first previews or missing/divergent/shallow history build
conservatively, with a diagnostic. There is no unsafe `HEAD^` fallback. A skipped
Vercel preview is not evidence of a production deployment.

## Interrupted-release recovery

The managed ledger is GitHub deployment task `scorearc-release`, in
`production-<service>`. Environment-only jobs do not create automatic deployment
objects. Only the provider's actual success advances a diff baseline.

Validate server-owned deployment creator `github-actions[bot]`, numeric ID
`41898282`, type `Bot`, as well as task/environment/payload version/service and
full SHA. Real Actions-created records can have null or absent
`performed_via_github_app`; if supplied, its ID must still be `15368`.
A `success` status must also be authored by that Actions bot. These are identity
checks, not a fallback to trusting a payload's claimed author.
Unknown authors/schema or conflicting app metadata remain blocked.
Operator-authored `inactive` retains the explicit reconciliation path below;
it is never a successful publication.

Main run `34741032755` (`4b972c2`, the dependency-only PR #153) exposed the old
optional-app-field assumption and stopped all three jobs before publication.
The corrected reader recognizes the existing Fly successes without modifying
them, while the frontend failure remains unresolved. Do not use this historical
bug as a release hold: once the correction merges, normal target selection
applies and the owner must have approved activation or arranged real holds.

```bash
gh api 'repos/mcasillas17/ScoreArc/deployments?task=scorearc-release&environment=production-frontend&per_page=1'
gh api repos/mcasillas17/ScoreArc/deployments/DEPLOYMENT_ID/statuses
gh run view RUN_ID --repo mcasillas17/ScoreArc
fly releases --app scorearc-reader
fly status --app scorearc-reader
```

Use the applicable provider only; substitute the actual IDs/service. A stopped
GitHub job is **not** proof that provider operations stopped. Wait for/cancel the
provider operation through an authorized operator and confirm its terminal
state, actual serving deployment, and absence of pending operations. If this
cannot be established, keep the ledger blocked and escalate to the provider.

For Vercel, use an authenticated dashboard read or project-specific API reads
with the existing token available securely in the environment. Do **not** use
`vercel promote status`, which can take the same incompatible user-lookup path.
Inspect the configured project's `lastAliasRequest`, any active rolling release
and queued promotion, deployment metadata for the failed run, and both domain
assignments/redirects. Relevant fixed-origin GETs are
`/v9/projects/{projectId}?rollbackInfo=true`, `/v1/projects/{projectId}/rolling-release`,
`/v7/deployments?projectId={projectId}`, `/v13/deployments/{deploymentId}`,
and `/v4/aliases/www.scorearc.futbol`; scope them to the configured team.
For the first URL, append `&teamId=...`, not a second `?`. Requesting promotion
metadata is mandatory before interpreting `lastAliasRequest`.
Never follow a response-provided URL with credentials or print complete responses
that may contain environment values.

The retained `confirm-vercel` command is **read-only incident verification**:
it reads `$RUNNER_TEMP/production-url.txt`, validates `GITHUB_SHA`,
`GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` and the three `VERCEL_*` environment
values, and checks the canonical alias for that exact deployment. Set
`RELEASE_SERVICE=frontend`. It neither promotes nor writes the ledger. Its
success does **not** prove absence of pending promotions/rolling releases;
that separate provider-state inspection is still required. Prefer owner
sign-in for readback over exposing or replacing the stored Actions token.

**September 13 recovery:** the owner authorized website recovery and latest-main
publication. Incident `6404319208` was acknowledged `inactive`, then frontend-only
run [34744420797](https://github.com/mcasillas17/ScoreArc/actions/runs/34744420797)
published `c8faba2` to both production domains. The promotion succeeded, but CI
timed out because its project reads omitted `rollbackInfo=true`. Authenticated
readback with the parameter proved the exact promotion `succeeded`, no rolling
release, and the canonical domain on `dpl_GkNQFyCMMYpVRPZi6nvpVtfCPbzg`.
The repository's read-only verifier and English/Spanish browser checks also
passed. After the run was terminal, record `6418795270` was acknowledged
`inactive` at 07:25:52 UTC with the actual publication and confirmation defect
in its description. No successful Actions status was manufactured.

Land the metadata-query correction before another release; do not repeat the
promotion POST merely because this run is red. The website is already live.
The next eligible release still needs full current-main CI and an
Actions-authored actual-success ledger. Historical evidence does not authorize
reconciling a different future incident without fresh provider checks.

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

PR #161's run already demonstrated ordinary-job credential presence. Re-run the
non-deploying diagnostic only if access is in doubt, with authorization; do not
ask for another token as a routine step. Separately authorize the selected
releases. Inspect current provider state and resolve any suspended
ingester/invalid standby or unresolved release operation through its own
authorized recovery procedure. A credential change is not authorization to
restart the ingester. Do not run a raw deploy to test credentials.

1. Record the actual main merge SHA and its completed `test` job. A green PR
   tests a different integration point and is insufficient.
2. Confirm the release jobs check out that exact SHA and report the expected
   per-target base/reason. Verify no direct Vercel Git main publication occurred.
3. For each selected target, inspect the provider log and successful managed
   ledger with that SHA. Vercel must confirm its deployed metadata and canonical
   domain. Fly logs must show deployment from the same checkout/config.
4. Check reader `/healthz` and América's team profile. Recover the ingester only
   under the separate [same-machine recovery plan](SETUP.md#74-first-deploy).
   Require exactly one ordinary started worker, an app that is not suspended,
   successful cycles with `failures: 0`, no duplicate/lost-lease errors, and
   advancing match data including Greece. A green Fly command/ledger is not
   ingestion acceptance. No schema-readiness claim follows from this gate.
   Observe a later docs-only skip and deterministic stale/failure test
   evidence; never introduce deliberately bad production code for testing.
5. Update CURRENT_STATE with these observations and any remaining owner action.
   Until all targets are accepted, T21.1 is implemented but not closed.

Primary references: [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[environment secrets without deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments#using-environments-without-deployments),
[runner step-environment evaluation](https://github.com/actions/runner/blob/main/src/Runner.Worker/StepsRunner.cs),
[concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments),
[Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration),
[Vercel promote](https://vercel.com/docs/cli/promote),
[project promotion API](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment),
[project-scoped tokens](https://vercel.com/docs/accounts/access-tokens),
[machine-readable API contract](https://openapi.vercel.sh/),
[Vercel CLI environment-token authentication](https://vercel.com/docs/cli/global-options#token),
[Vercel roles](https://vercel.com/docs/rbac/access-roles),
[Fly app-scoped tokens](https://fly.io/docs/launch/continuous-deployment-with-github-actions/).
