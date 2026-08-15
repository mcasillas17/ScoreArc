# AI recaps & digest — design

**Status:** Design approved, **plan deferred until E1 lands** · 2026-08-15
**Epic:** E8 (`docs/PRODUCT_ROADMAP.md`)
**Gate:** T8.1 needs E1's box score. T8.2 needs E7's T7.1 snapshots.

## Why this spec has no implementation plan yet

The prompt design depends on the exact shape of the box score E1 produces. Writing
prompts against a data structure that does not exist yet would mean rewriting them
the day it does.

## Goal

Use AI where it has an actual advantage over a template: turning our own
structured data into prose, and noticing things in it that nobody thought to
query.

## The principle: push, not pull

The reflexive AI feature is a chatbot. It is the wrong first move here.

A chatbot's ceiling is the data behind it, and it requires the user to know what
to ask. Recaps and a digest require nothing — they arrive. They also fail
*visibly*: a wrong recap is obviously wrong and gets fixed, where a chatbot that
confidently answers a question our data cannot support fails silently, once per
user, invisibly.

So: **generate, don't converse.** Revisit Q&A after E7, when there is enough
underneath it to be worth asking.

## T8.1 — Auto-generated match recaps

**Depends on:** E1's `PlayerMatchStats`.

A short recap per finished match, generated once at full time and cached against
the match id — never per request. The generation cost per match is fixed and
small; per request it is unbounded.

**Grounded, strictly.** The model is given our own structured data — score,
scorers with minutes, cards, per-player box score, team stats — and writes prose
from it. It is not asked to recall the match, and it does not get to introduce a
fact that is not in the payload.

This is the whole reason recaps are the best-value AI feature here: every claim in
the output is checkable against a field we hold.

**Non-negotiables:**
- Never invent a scorer, a minute or a statistic.
- Own goals are described as own goals. E0 makes that distinction available;
  a recap that credits the beneficiary's "goalscorer" reintroduces the bug in
  prose, where it is harder to spot.
- A stat we do not have is not mentioned. No "dominated possession" where
  possession is null.
- The recap is labelled as automatically generated. Not buried — labelled.

**Model choice:** the smallest model that produces acceptable prose from
structured input, since the task is transformation rather than reasoning. Check
`claude-api` reference material for current model ids before wiring anything;
do not hardcode a model id from memory.

## T8.2 — Anomaly digest

**Depends on:** E7's T7.1 snapshots. Without a time series there is no anomaly,
only a value.

A short daily or weekly digest of what is unusual: a player outperforming their
shot volume, a club's biggest table climb, a run of clean sheets, a form
collapse.

The interesting design constraint is that **most anomaly detection here is not an
AI problem** — it is a query over the snapshot series. AI writes the sentence; SQL
finds the fact. Building it the other way round produces a system that
hallucinates trends, which is the worst possible failure mode for a stats
platform.

## T8.3 — Match previews

**Depends on:** E7's T7.3 form. `H2HMeeting` already exists in
`src/server/data/types.ts` and `mapSummaryH2H` already populates it, so the
head-to-head half is available today; the form half is not.

Same grounding rules as T8.1. A preview states form, head-to-head and absences we
actually know about — **not** a prediction, unless and until the model behind it
publishes a Brier score (see E7).

## Explicitly not building

- **A chatbot**, for the reasons above. Revisit after E7.
- **AI-generated "insights" that restate a table.** "Arsenal are 2nd with 34
  points" is not an insight; it is the table with more words.
- **Anything that presents a generated number as a measured one.** If a figure
  came out of a model, the page says so.

## Verification

- Every claim in a generated recap is traceable to a field in the match payload.
- A match with a null stat produces a recap that omits it rather than guessing.
- An own goal is described as an own goal.
- Recaps are generated once per match and served from cache — verified by
  request count, not by inspection.
- The generated-content label is visible without scrolling.
