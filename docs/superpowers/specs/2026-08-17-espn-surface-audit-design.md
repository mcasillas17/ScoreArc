# ESPN surface audit — what's left, and what it means

**Status:** Findings · 2026-08-17
**Scope:** Determines whether a second provider is optional or necessary.

## Why this exists

Before adding a data dependency, the question is whether we have exhausted the one
we already have. This audit probed every reachable ESPN surface across all three
hosts and records what is left.

**Conclusion: ESPN is close to exhausted.** What remains unconsumed is thin, and
the gaps we care about are **structurally absent** rather than merely unfound —
the endpoints exist and return `count=0`. That converts "should we add a second
provider" from a preference into a requirement for any feature depending on
injuries, transfers, or history.

## What we already consume

`scoreboard`, `standings`, `summary`, `statistics`, `news`, `teams`, `rosters`,
`athletes` + `/overview` + `/bio`, `plays` (touch-level, with coordinates),
`officials`, `odds`.

## Reachable and populated, not yet consumed

| Endpoint | Count | Verdict |
|---|---|---|
| `/calendar` | 4 | **Worth taking.** Season phase boundaries — when a season, a group stage or a knockout actually starts and ends. |
| `/venues` | 9,221 | **Low value as-is.** `fullName` and `address.country` only; `capacity`, `grass`, `indoor` all null. |
| `/franchises` | 20 | Marginal. Club franchise records. |
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

## Recommended ESPN follow-ups (small)

- **Consume `/calendar`** — season and phase boundaries currently have to be
  inferred from fixtures, which is why the Leagues Cup phase dates are hardcoded
  in `competitions.ts`.
- **Skip venues and franchises** until they carry capacity or geography.
- **Record the dead list** (above) so future agents stop re-probing.

## Out of scope

Which second provider to add — that is a separate research track
(`docs/research/2026-08-17-second-data-provider.md`).
