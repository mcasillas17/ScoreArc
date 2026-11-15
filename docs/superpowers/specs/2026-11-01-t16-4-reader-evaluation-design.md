# T16.4 reader evaluation design

The November 1 implementation request authorizes this evaluation runner and active
PR, not production activation. Base: `52572d6` (T16.3 merged). Migration 0028
already exists. No backend, watchdog, player-directory UI, production config,
source-selection or request-path changes are needed.

## Approach

Use an explicit CLI with a finite manifest, disabled without an explicit mode.
Construct `createReaderDataStore` directly and `createDataStore` explicitly for
ESPN, with fresh separate caches and separate evaluation budgets. Never pass a
selected/fallback store to comparison. Record every transport failure, including
optional failures the ESPN adapter catches. News is excluded and T16.6 stays open.
This reuses T16.3 decoding, resource policy, crosswalks and streaming budgets.

Request-path sampling was rejected: a CLI supplies the requested evidence without
primary-response latency, cache contamination, lifecycle races or traffic hooks.
A second adapter was rejected because it would test different mapping code.

## Manifest and bounds

Versioned JSON names configured competition/season scopes and explicit method or
joined-scenario samples with typed arguments. Maximum 32 samples, 4 distinct
scopes, 128 HTTP calls and 32 MiB per source per run, 4 MiB per response, four
in-flight requests per source, one paired sample at a time, zero retries,
120 seconds per run and 10 seconds per sample side. CLI input <=32 KiB; report
<=1 MiB. Over-limit input is rejected before network work. Exhaustion and skipped
attempts remain represented; no unrestricted discovery or per-player crawl.
These are engineering safety caps, not owner-approved soak sizes or SLOs.

Each sample uses the same resolved scope, explicit query and entity IDs on both
sides. Current-only ESPN endpoints cannot establish historical parity; classify
unsupported scope before fetching. Capture requested scope and any incomplete or
unverifiable provider scope. Live/implicit date windows must use equivalent
clocks/ranges; a day-boundary shift is not comparable. Offline fixtures use a
fixed clock and injected transport. No live evaluation is executed by this task.

## Semantic comparison and evidence

Named versioned normalizers may translate documented representation only:
validated identity is already translated by T16.3; kickoff/date instant precision;
set ordering where order has no contract meaning; reader evidence separated from
payload; explicitly documented held-data projections/qualified canonical refs.
Preserve absent, null, empty, zero and false unless a specific field projection
is documented. Never erase wrong entity, side, score, missing row, rank or link.

Report each sample as matched, mismatched, unavailable or error, with comparable
as matched+mismatched. All manifest samples count as attempted, including
unsupported, stale, partial, dormant without usable evidence, cancelled, timed
out and dependency-failed cases. Preserve mismatch categories even when timing
skew or incomplete evidence makes the result inconclusive. Timing skew does not
excuse entity/side contradictions or stable finished-score disagreements.

Each side retains request start/end/duration, body bytes/calls, typed failures,
reader resource observations/finalization/scope/status/availability/derivation,
and ESPN request windows (upstream observation unknown unless explicitly held).
No fabricated ESPN observation timestamp. Reports contain only validated scope,
argument IDs, bounded schema paths/categories and typed resource metadata, never
payload dumps, arbitrary error strings, SQL, credentials or full upstream URLs.
Output names omitted methods/scenarios and limits inference to sampled scopes.

## Coverage and acceptance

The delivery document supplies the eleven-method matrix and exact normalizer
rules. Joined samples exercise list -> addressed popup, player -> held game-log
-> popup, team schedule -> popup, both leaderboard links, derived MLS/Leagues Cup
standings and T7.3 form -> popup. Explicit target IDs are selected in the manifest;
absence is coverage failure, not permission to select a different target on each
side. Existing index and form helpers are reused with strict awaited calls;
source-selection helpers that swallow enrichment failures are not used.

Every method requires exact equality of its compared semantic contract and
complete/equivalent evidence to count as matched. Zero tolerance for wrong
entity, home/away, score/winner attribution or invalid navigation. Held subset
projections are disclosed and cannot establish complete career/log parity.
Unavailable/error samples never count as matches. No universal success percentage
or production-cutover verdict. Owner approval is still needed for live scope,
soak duration/sample volume, observation-skew tolerance and latency/cost SLOs.

## Delivery validation

TDD: false-success fallback, named normalizers, wrong entity/score/missing rows,
null/empty/zero/false, stale/partial/dormant/skew, cancellation, slow bodies,
oversized responses, parallel budget exhaustion, sanitized bounded reports and
unchanged defaults. Reproducible offline run uses recorded/synthetic fixtures;
sample report states synthetic limitations and measured costs. Full frontend
gates plus local default browser smoke; backend gates only if backend changes.
Knights Astra/Sol/Luna independently review implementation and final documented
state with the installed evaluator; active PR only after publicationReady.

## User followup: club popup identity

During the default local smoke, the user reported Chicago Fire rendered as
Chile and Cruz Azul as CAZ text. The shared popup ignored crests and used country
flags unconditionally. This explicit followup is in scope: thread each caller's
existing competition style to the shared popup, use held crests for clubs with
abbreviation fallback only, preserve national flags and verify the form popup
across mobile widths. No player-directory UI change.
