# Expected goals (xG) — design

**Status:** Design approved, **plan deferred behind T9.1** · 2026-08-15
**Epic:** E9 (`docs/PRODUCT_ROADMAP.md`)
**Gate:** T7.12 + T7.13 (the play stream must be persisted) → T9.1 (training-set
probe) must complete before any model is fitted.

## Why this epic exists at all, and why it did not until today

Until 2026-08-15 this roadmap rejected xG outright, on the stated grounds that
shot coordinates are "not in the ESPN payload and not anywhere in `src/`". That
was wrong. It was true of the `site.api.espn.com` host every existing mapper uses,
and false of `sports.core.api.espn.com`, which serves a per-match play stream
carrying pitch coordinates on almost every event.

The rejection is worth recording rather than deleting, because it explains the
shape of everything around it: E6 was named "Shot log — *not* an xG model" and
scoped to parsing zones out of English prose **because of this error**. The
constraint is lifted. What remains is not a data problem.

> **The blocker was never modelling. It is now.** That is a genuinely better
> position to be in, and also a more dangerous one: there is nothing left to stop
> us shipping a number, which means the only thing protecting us from shipping a
> *bad* number is the discipline in this document.

## Goal

Compute and publish **ScoreArc's own expected-goals model** — a per-shot
probability, aggregated per player and per team — trained on shot geometry we
persist ourselves, validated in public, and rendered only where the underlying
data supports it.

## What we actually have

Verified against live responses on 2026-08-15. Every figure below was measured,
not assumed.

### Shot geometry

| Field | Meaning | Coverage on current-season shots |
|---|---|---|
| `fieldPositionX` / `fieldPositionY` | where the shot was struck, 0–100 per axis | ~100% |
| `fieldPosition2X` / `fieldPosition2Y` | where the ball ended up | high, not universal |
| `goalPositionY` / `goalPositionZ` | placement within the goal mouth | **~55–75%** |

Goal-mouth placement is missing on roughly a quarter to a half of shots, and the
pattern is not random: a blocked shot never reaches the goal line, so it has no
placement. **That is informative, not missing-at-random**, and a model must treat
"blocked, therefore no placement" as a feature rather than imputing a value.

Measured coverage, current-season finished matches:

| Competition | Shot-type plays | With goal-mouth placement | With field position |
|---|---|---|---|
| Liga MX (`401877018`) | 64 | 53 | 64 |
| Leagues Cup (`401863625`) | 21 | 16 | 21 |
| MLS (`761721`) | 31 | 17 | 31 |

### Shot outcomes, already typed

Shots arrive **pre-classified** — `Goal`, `Shot On Target`, `Shot Off Target`,
`Shot Blocked`, `Save`, `Penalty` — so the training label does not have to be
inferred from prose. This is the single largest reason this is tractable: the
hard part of building an xG training set is usually labelling, and it is done.

### Athlete attribution

Every shot carries a `participants[].athlete` `$ref`. The id is **parsed from the
URL, never fetched** (T7.12's rule; a match has ~1,500 plays with 2–3 refs each).
Because T7.7 already resolves the squad from the match summary before the plays
are fetched, shot athletes resolve against `player_external_ref` with **one query
per match**.

### Context in the prose

The play `text` carries body part and situation: *"Attempt blocked. Luis
Calzadilla (Atlante) right footed shot from outside the box is blocked."*,
*"header"*, *"Assisted by X with a cross"*. These are real features — body part
and assist type are standard xG inputs — but they are **English prose**, they vary
by competition, and E6's T6.1 exists precisely to measure how reliably they parse.

**Feature priority follows that reliability.** Geometry is structured and
near-universal; prose is neither. A first model uses geometry and outcome type
alone. Prose-derived features are added only where T6.1 shows the yield supports
them, and never as a silent default.

## The crux: is the training set big enough?

**This is the question the epic turns on, and it is unmeasured.** T9.1 exists to
answer it before a line of modelling code is written.

Two facts make it genuinely uncertain:

**1. The usable window is one season.** ESPN keeps the full stream for the current
season only. Measured 2026-08-15:

| Match | Plays | Passes | Scale | Goal-mouth |
|---|---|---|---|---|
| Liga MX, 2026-07-17 (this season) | 1,297 | 486 | 0–100 | present |
| Liga MX, 2026-05-10 (last season) | 199 | 0 | **0–1** | **all zero** |
| Premier League, 2026-04-18 | 189 | 0 | **0–1** | **all zero** |
| MLS, 2025-08-09 | 198 | 0 | **0–1** | **all zero** |

The boundary is the **season**, not an age — a 30-day-old current-season match is
intact while a four-month-old previous-season match is not.

**2. Historical geometry is in a different frame, and is not a rescale.** Prior
seasons *do* retain pitch coordinates for shots, which initially looks like a free
backfill. It is not:

- The scale is **0–1**, not 0–100.
- `goalPositionY/Z` are **zero on every historical match sampled** (n=194 on
  `740685`, zero non-zero values). Goal-mouth placement does not survive at all.
- The frame appears **inverted**: historical shots cluster at low x (0.02–0.49)
  while current-season shots cluster high (69–95 on 0–100). A `×100` would place
  every historical shot in the wrong half.

So a naive historical backfill would train the model on shots located in the wrong
place, with a quarter of the feature set silently absent. **Reconciling the two
frames is a measurement, and it is part of T9.1** — not an implementation detail
to be discovered during T9.3.

### T9.1 — Training-set probe (blocking)

Answer, with numbers, before modelling:

1. **How many shots do we hold?** Count `match_play` rows of shot type, per
   competition, with and without each geometry field.
2. **What is the goal rate?** The base rate the model must beat, per competition.
   A model that cannot beat "every shot is worth the league average" is not a
   model.
3. **Is one season enough?** Nine competitions × ~2,500 matches × ~25 shots is an
   order-of-magnitude estimate of ~50–60k shots. That is a plausible sample for a
   geometry-only model and a thin one for a richly-featured one — but it is an
   *estimate*, and T9.1 replaces it with a count.
4. **Can historical shots be reconciled?** Take matches where we hold both a
   current-season-format record and, later, its pruned form; or reconcile against
   known-position events (penalties are always taken from the same spot, which is
   a natural calibration anchor). Report whether the historical frame is
   recoverable, and **if it is not, say so and drop it** rather than using it
   anyway.
5. **Per-competition adequacy.** Which competitions have enough shots to support a
   model *of their own*, and which must borrow a pooled one, and which have too
   few for either.

Output: a table, per competition, of shot counts, feature coverage and base rates,
plus a go/no-go on historical reconciliation. **If the answer is "not enough
yet", the correct outcome is to keep ingesting and re-run the probe next season.**
That is a real possible result and shipping a thin model instead is the failure
mode this task exists to prevent.

## Design

### T9.2 — Feature extraction

A pure function from `match_play` shot rows to a feature vector. Lives in the
backend, computed once, stored — not recomputed per request.

Features, in the order their reliability supports:

- **Distance and angle to goal**, derived from `fieldPositionX/Y`. These are the
  two features that carry most of the signal in every public xG model, and both
  come from the most reliable field we have.
- **Shot type** (`Shot Blocked` / `On Target` / `Off Target`) as context, with the
  care noted below.
- **Penalty flag** — `penaltyKick` is already a boolean on the play. Penalties
  have a known, stable conversion rate and are conventionally modelled separately;
  folding them into a general model distorts both.
- **Body part and assist type**, from prose, **only if T6.1 shows the yield
  supports it**, and expressed as "unknown" rather than a default when absent.

> **A trap worth naming.** Shot outcome type is *partly downstream of the shot's
> quality*, so a model that uses "was it on target" to predict "was it a goal" is
> leaking the label. The honest framing is that xG estimates the chance a shot
> becomes a goal **given the situation at the moment it is struck** — so
> pre-shot features (location, angle, body part, assist) are legitimate and
> post-shot features (placement in the goal mouth, whether it was blocked) are
> not, for the headline number. `goalPositionY/Z` belongs to a *post-shot* model
> (on-target shot quality), which is a genuinely interesting second metric and
> must never be labelled "xG".

### T9.3 — Model fit and calibration

Deliberately unspecified in method. Logistic regression on distance and angle is
the honest baseline and may well be the shipped model; gradient boosting is the
usual improvement. **The plan is written from T9.1's output**, because the sample
size determines which is defensible — a boosted model on 8,000 shots is a
memorised training set with a confident face on it.

Non-negotiable regardless of method:

- **Train and validate on disjoint matches**, not disjoint shots. Two shots from
  the same match are not independent observations.
- **Calibration is the target, not accuracy.** An xG model's job is that shots it
  calls 0.2 go in about 20% of the time. A model with better log-loss and worse
  calibration is worse for this product.
- **Per-competition base rates differ.** Verify whether one pooled model
  calibrates across all nine, or whether competitions need their own intercepts.

### T9.4 — Published validation

**This is a shipping requirement, not a nice-to-have**, and it is the same
standard `docs/superpowers/specs/2026-08-15-history-and-trends-design.md` sets for
match simulation. The two should share one validation story rather than inventing
two.

On the page, visible to a user, not buried in a repo:

- **Brier score**, against the naive base-rate baseline so the number means
  something.
- **A reliability curve** — predicted probability against observed frequency,
  binned. This is the chart that shows whether the model is honest.
- **The sample it was trained on**: how many shots, which competitions, which
  season.

> Until we can publish those, an xG number is a toy that will be screenshotted and
> held against us. Once we can, it is the strongest differentiator on the roadmap
> — because almost nobody publishes their calibration, and the ones who do are the
> ones worth trusting.

### T9.5 — Gating and framing

**Per-competition capability check, exactly as E6 requires.** A competition whose
shot sample is below the T9.1 threshold renders **no xG at all** — not a greyed
number, not a zero, not a silently empty panel. The code expresses this as a
per-competition capability, never a global feature flag.

**Framing rules, which are product requirements and not copy suggestions:**

- It is labelled **ScoreArc xG**, never bare "xG".
- The page says what it was trained on and how well it calibrates, with a link to
  T9.4's validation.
- It is **never presented as interchangeable with the xG a viewer saw on
  television**. Opta's model, StatsBomb's and ours will disagree on the same shot,
  and a user comparing them deserves to know why rather than concluding one of us
  is broken.
- Aggregations state their shot count. "1.4 xG from 3 shots" is a different claim
  from "1.4 xG from 19 shots" and the UI must not flatten them.

## Relationship to E6 — one pipeline, two consumers

**E6 renders shots. E9 scores them. Neither ingests them** — T7.12 does.

| Concern | Owner |
|---|---|
| Fetching and persisting the play stream | **T7.12/T7.13** |
| Extracting typed shots + reconciling against `rosters[].totalShots` | **E6** (T6.2/T6.3) |
| Rendering the shot map | **E6** (T6.4) |
| Turning a shot row into features, fitting, calibrating, publishing | **E9** |

The extraction and the reconciliation are written **once**, in E6, and E9 reads
the same rows. If E9 finds itself re-parsing shots, the boundary has been drawn
wrong and the fix is to widen E6's output, not to duplicate it.

The dependency runs E6 → E9 for the *extraction*, but the two can proceed in
parallel after that: T9.1's probe counts rows that T7.12 writes, and does not need
E6's renderer.

## What this does not do

- **No shot map.** That is E6's T6.4, and it ships first.
- **No heat maps.** Still rejected — now on product grounds rather than on the
  false claim that coordinates do not exist. See the roadmap's rejection table.
- **No paid provider.** The original rejection's escape hatch ("revisit as a
  paid-provider decision with a named budget") is moot. If a paid provider is ever
  wanted it will be for *validation* — checking our model against a commercial one
  — not for the raw geometry.
- **No goalkeeper or defender-pressure features.** Nothing in the payload locates
  other players at the moment of the shot. Their absence is the main reason our
  model will be less good than a commercial one, and T9.4's published calibration
  is how we stay honest about that instead of hiding it.

## Verification

- T9.1's shot-count and coverage table is published **before** any model is fitted.
- A stated per-competition threshold exists, and competitions below it render
  nothing.
- Train/validate splits are by match, not by shot, and there is a test that fails
  if a match appears in both.
- Penalties are modelled separately from open play.
- The headline model uses **pre-shot features only**; any use of `goalPositionY/Z`
  is a separately named post-shot metric.
- Brier score, reliability curve and training-sample description are rendered on
  the page, not just computed.
- The label reads "ScoreArc xG" everywhere it appears.
- `go build ./...`, `go test -race ./...` and `go vet ./...` clean (Docker running
  for the testcontainers packages).
