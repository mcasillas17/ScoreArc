# ESPN surface audit — what's left, and what it means

**Status:** Findings · 2026-08-17
**Scope:** Determines whether a second provider is optional or necessary.

## Why this exists

Before adding a data dependency, the question is whether we have exhausted the one
we already have.

> **Revised 2026-08-17 — the first version of this document was under-researched.**
> It concluded "ESPN is close to exhausted" from endpoints I *guessed at*. ESPN
> publishes a **WADL** — a machine-readable description of its own API — at
> `sports.core.api.espn.com/v2/application.wadl` (1.6 MB, **373 paths**) and
> `/v3/application.wadl`. Enumerating it found populated surfaces the guesswork
> missed, most importantly **per-team match statistics** carrying advanced
> defensive metrics and ratings we do not ingest at all.
>
> **Corrected conclusion:** ESPN is *not* exhausted for match statistics. It *is*
> exhausted for injuries, transfers, full-season game logs and history — those
> endpoints exist and return `count=0`, which is a stronger negative than a 404.

**Method matters here.** Probing paths you can think of tells you what you already
imagined. The WADL is authoritative. Any future "is there more?" question should
start there, not with a list of guesses.

## What we already consume

`scoreboard`, `standings`, `summary`, `statistics`, `news`, `teams`, `rosters`,
`athletes` + `/overview` + `/bio`, `plays` (touch-level, with coordinates),
`officials`, `odds`.

## Reachable and populated, not yet consumed

### The one that matters: per-team match statistics

```
/events/{event}/competitions/{competition}/competitors/{competitor}/statistics
```

Four categories — `defensive`, `general`, `goalKeeping`, `offensive` — carrying
metrics **we do not ingest anywhere**:

- **Defensive:** `effectiveTackles`, `inneffectiveTackles`, `tacklePct`,
  `effectiveClearance`, `totalClearance`, `interceptions`, `blockedShots`,
  **`possWonAtt3rd`**, **`possWonDef3rd`**
- **General:** `avgRatingFromCorrespondent`, `avgRatingFromDataFeed`,
  `avgRatingFromEditor`, `avgRatingFromUser` — **match ratings**, from four
  distinct sources
- Plus `goalKeeping` and `offensive` categories not yet enumerated in full

Possession won in the attacking and defensive thirds is genuinely analytical data
— it is the kind of thing paid providers charge for. The ratings are a fan-facing
feature on their own.

Sibling resources also returning 200 and unexplored: `/competitors/{id}/roster`,
`/leaders`, `/records`, `/score`, `/linescores`.

### Reference data — cheap, useful for correctness

| Endpoint | Count | Verdict |
|---|---|---|
| `/positions` | 42 | Position taxonomy. Would replace string-matching on abbreviations. |
| `/countries` | 238 | Country reference. Useful for nationality normalisation. |
| `/providers` | 42 | Odds provider registry — pairs with the odds we already ingest. |
| `/media` | 1,316 | Broadcast/media entries. Unassessed. |
| `/calendar` | 4 | **Worth taking.** Season and phase boundaries — currently the Leagues Cup phase dates are hardcoded in `competitions.ts` because we infer them. |
| `/venues` | 9,221 | **Low value as-is.** `fullName` and `address.country` only; `capacity`, `grass`, `indoor` all null. |
| `/franchises` | 20 | Marginal. |
| event `/status`, `/situation`, `/broadcasts`, `/notes` | 200 | Small. `situation` is useful only in-play. |

## Reachable but EMPTY for soccer — the confirmed gaps

These exist, return HTTP 200, and contain nothing. That is a stronger negative
result than a 404: the shape is there and unpopulated for this sport, so it will
not appear later by us looking harder.

| Endpoint | Count | Consequence |
|---|---|---|
| `/seasons/{y}/transactions` (league) | 0 | **No transfers.** |
| `/teams/{id}/transactions` | 0 | Same, confirmed at team level. |
| `/seasons/{y}/awards` | 0 | No honours data. |
| `/seasons/{y}/futures` | 0 | No futures markets. |
| `/seasons/{y}/corrections` | 0 | No provider errata feed. |
| athlete `/injuries` | 0 | **No injuries** — matches the empty arrays on the roster payload. Confirmed at the core API too, so this is not a host problem. |
| athlete `/eventlog` | self-referential `$ref` | **No full-season game log.** E5's last-five ceiling stands. |
| v3 athlete `/statisticslog` | 0 | No season-by-season history. (v2 404s; v3 exists and is empty.) |
| `/seasons/{y}/freeagents` | error | No free-agent/transfer feed. |
| `/seasons/{y}/draft` | error | No draft — including for MLS, which has one. |
| `/rankings` | 0 | Empty for soccer. |
| `/tournaments` | error | Not available for soccer. |

## Dead endpoints — do not call

`4xx`/`5xx` on soccer: athlete `/statistics`, `/statisticslog`, `/contracts`;
team `/statistics`, `/record`, `/injuries`, `/leaders`, `/depthcharts`;
event `/predictor`, `/powerindex`, `/probabilities`, `/leaders`, `/linescores`;
league `/seasons/{y}/leaders`, `/groups`, `/seasons/{y}/coaches`.

Each of these has been probed and should not be retried speculatively.

## What this means

**Four gaps are now confirmed structural, not unfound:**

1. **Historical depth.** ESPN prunes the touch tier by season. Our history starts
   2026-08-17. Nothing on ESPN's side changes this.
2. **Injuries / availability.** Empty at every level.
3. **Transfers, contracts, market values.** Empty at every level.
4. **Full-season player game logs.** `/overview` gives five matches; `/eventlog`
   is a dead end.

Gaps 1 and 4 are partly self-healing — we now accumulate our own history, and a
full game log is derivable from `appearance` rows once enough matches accrue. Gaps
2 and 3 are not: no amount of waiting produces injury or transfer data.

**Therefore:** a second provider is required for injuries and transfers, and
valuable for backfilling history we will otherwise never have. It is *not* needed
for xG, shot locations, odds, officials, play-by-play, or anything else we already
ingest.

## Recommended ESPN follow-ups

**1. Ingest per-team match statistics — the largest single win available.**
`competitors/{id}/statistics` gives tackles, clearances, interceptions,
possession won by third, and four rating sources, per team per match. This is
analytical data we currently have no equivalent of, and it costs one request per
competitor per match — the same match we already fetch a summary for.

**2. Explore the competitor siblings** — `/roster`, `/leaders`, `/records`,
`/score`, `/linescores` all return 200 and are unexamined.

**3. Consume `/calendar`** — season and phase boundaries currently have to be
inferred, which is why the Leagues Cup phase dates are hardcoded in
`competitions.ts`.

**4. Adopt `/positions` and `/countries`** as reference data, replacing string
matching on abbreviations.

**5. Skip** venues and franchises until they carry capacity or geography.

**6. Record the dead list** (above) so future agents stop re-probing — and start
any future exploration from the **WADL**, not from guesses.

## Out of scope

Which second provider to add — that is a separate research track
(`docs/research/2026-08-17-second-data-provider.md`).
