# Second data provider for ScoreArc — research findings

**Research date: 2026-08-17.** Every price, limit and quote below is what the cited page said on
that date. These vendors change pricing and coverage often; re-check before signing anything.

Claims that could not be confirmed against a primary source are marked **unverified**. Several
vendor and stats sites refuse automated fetches — see [§6](#6-legal--tos-risk-assessment).

**Our nine:** Premier League · LaLiga · Serie A · Bundesliga · Ligue 1 · **Liga MX** · **MLS** ·
**Leagues Cup** · **CONCACAF Champions Cup**

---

## 1. Executive summary

**Buy Sportmonks (~€45/month) as the licensed second provider. Backfill MLS shot-level history
from the American Soccer Analysis API (free) now. Use openfootball, Wyscout-figshare and Wikidata
as the licence-clean history spine.**

Only four providers verifiably carry all nine competitions: **API-Football** ($19/mo),
**Sportmonks** (~€45/mo), **TheSportsDB** ($9/mo), and the enterprise vendors. Leagues Cup is the
wall — six mid-market vendors publish complete league lists and none contains it.

API-Football is cheaper and its coverage matrix is the most complete thing found. Sportmonks wins
anyway on the one criterion that matters for a public site that stores data: its terms *explicitly*
permit storage, distribution and commercial use, where API-Football states it grants **no**
publication licence and pushes rights clearance onto us.

**American Soccer Analysis is the find of this research** — a keyless public API returning
MLS **shot-level data with pitch coordinates**, xG and post-shot xG, **back to 2013**. It closes
the MLS half of our historical-events gap for €0.

Four things to know before acting. **StatsBomb's open-data licence forbids commercial use and
redistribution** (§3.6) — the permissive README everyone quotes is not the licence. **FBref lost
all Opta advanced stats in January 2026** (§3.8). **Our current ESPN ingestion is squarely
prohibited by Disney's Terms of Use** (§6), which reframes this from redundancy to migration. And
**FotMob's keyless API serves Liga MX shot coordinates and xG today** — while prohibiting it in
four separate ToS clauses and naming `/api/*` in robots.txt (§4). It is the sharpest trap in the
landscape precisely because nothing stops you.

**No source at any price we would pay sells historical Liga MX event data with coordinates**, and
there is a structural reason: **Genius Sports holds Liga MX exclusively**, MLS routes through
Sportec/Deltatre → IMG Arena → Sportradar, and Opta collects both independently. There is no
one-stop vendor for our two core leagues.

---

## 2. Comparison table

### Commercial APIs

| Provider | All 9? | Cheapest tier for all 9 | History | Pitch x/y | Live | Injuries / Transfers / Mkt values / Predicted XI | Free tier | Storage + commercial? | Stability | Auth |
|---|---|---|---|---|---|---|---|---|---|---|
| **API-Football** | ✅ **9/9 verified** | **$19/mo** (Pro) | per-competition, unpublished | ❌ **none** | 15 s | ✅ / ✅ / ❌ / ❌ | 100 req/day, 10/min | ⚠️ storage OK, **"we do not provide a license"** | v3.9.3, changelog | `x-apisports-key` |
| **Sportmonks** | ✅ 9/9 present, **but LC + CCC are thin** (no lineups/player stats) | **€45/mo** (€29 + 4×€4) | current + 3 seasons; older = **€29 one-time** | ⚠️ yes — **but not for Liga MX/MLS/LC/CCC** | 15 s | ✅ `sidelined` / ✅ / ❌ / €199/mo add-on | 2 leagues (DK, SCO) | ✅ **explicitly allowed** (per-domain) | v3, versioned path | API token |
| **TheSportsDB** | ✅ **9/9 verified** | **$9/mo** | results deep; events only ~2019+ | ❌ | 120 s | ❌ / ⚠️ / ❌ / ❌ | key `123`, 30/min, row-capped | ✅ **attribution required** | V1 legacy, V2 current | key / `X-API-KEY` |
| **football-data.org** | ❌ **7/9** — no LC, no CCC | **impossible at any price** | Liga MX 10 seasons, MLS 7 | ❌ | delayed on free | ❌ / ❌ / ❌ / ❌ | 12 comps, 10/min | ⚠️ **must stop using data after cancellation** | v4 | `X-Auth-Token` |
| SportsData.io | ❌ 8/9 (no CCC) | sales only | — | ❌ (formation grid) | — | ✅ / — / — / — | trial = scrambled fake data | ⚠️ nothing granted | v4 | subscription key |
| Highlightly | ❓ 7/9 verified | $9.49/mo | — | ❌ | 60 s | ✅ / ✅ w/ fees / **✅ time series** / ❌ | 100 req/day | ✅ **best-worded terms** | ❌ **unversioned** | key |
| **RotoWire** (injuries only) | ❌ 7/9 — no LC, no CCC | sales only | **2 weeks** | ❌ | real-time | ✅ **richest fields, MLS + Liga MX** / ❌ / ❌ / ✅ | none | ✅ docs tell you to persist | documented | key |
| Goalserve | ❌ no LC | ~$300/mo | 2006 results, 2016 stats | ❌ | 3–5 s | ❌ **no soccer injuries endpoint** / — / — / ✅ | 30-day trial | ⚠️ **no data licence published** | — | key |
| **Biwenger** (free, Liga MX injuries) | ❌ Liga MX + LaLiga/SerA/L1 | free | rolling `fitness` array | ❌ | daily | ✅ / ❌ / ❌ / ❌ | keyless | ⚠️ **terms unreadable** | undocumented | none |
| SoccerDataAPI | ❌ 7/9 | impossible | — | ❌ | — | — | — | ❌ **ToS bans commercial + your ingester** | HTTP 200 on errors | key |
| Sportradar / Stats Perform | ✅ | sales only (~$500–1,000+/mo, unverified) | 2007+ (varies) | ✅ **real event x/y** | 10 s | ✅ | — | enterprise contract | documented | key |

### Open / bulk datasets

| Source | Our-nine coverage | Granularity | Commercial | Store | Redistribute | Attribution | 2026 status |
|---|---|---|---|---|---|---|---|
| **ASA API** | **MLS 2013→now** (no Liga MX) | **Shot x/y + xG + PSxG + g+ + salaries** | ⚠️ **no published terms** | ⚠️ | ⚠️ | none stated | ✅ live |
| **openfootball** | Liga MX 10/11–24/25, MLS 05–25, **CCC 10/11–25**, big-5 →26/27 | Results + HT scores | ✅ **CC0** | ✅ | ✅ | **none** | ⚠️ N. America stale since May 2025 |
| **transfermarkt-datasets** | big-5 2012→; **Liga MX 241 games, MLS 727 — 2025 only** | Results, lineups, appearances, transfers, market values | ⛔ CC0 badge **invalid as applied** | ⚠️ | ⚠️ | none | 🚩 **scraper failing since 2026-07-14** |
| **Wyscout figshare** | Big-5 2017/18 + WC18 + Euro16 | **Event stream + x/y** | ✅ | ✅ | ✅ | **mandatory** (CC BY 4.0) | frozen 2019, live |
| **RSSSF** | **Liga MX 1902→2026** | Results + **goalscorers w/ minutes** | ⚠️ not addressed | ✅ | ⚠️ | **mandatory** | ✅ Mar 2026 |
| **Wikidata** | seasons/squads incl. Liga MX + MLS | **~no match data** | ✅ CC0 | ✅ | ✅ | none | ✅ |
| **DFL/IDSSE** | 7 Bundesliga matches | **Tracking 25 Hz + events** | ✅ | ✅ | ✅ | mandatory | frozen 2025 |
| **Football-Data.co.uk** | **Liga MX 12/13→26/27, MLS 12→26** | Goals + odds only for MX/USA | ⚠️ **"match prediction only"** | ⚠️ | ⛔ | — | ✅ Aug 2026 |
| **StatsBomb open data** | big-5 subsets; **MLS = 6 matches**; no Mexico | Event + x/y + 360 | ⛔ **BANNED** | ⚠️ | ⛔ **BANNED** | logo mandatory | ✅ May 2026 |
| **Understat** | big-5 + RFPL 2014–2025 | Shot x/y + xG | ⛔ `Disallow: /` | ⛔ | ⛔ | — | live |
| **FBref** | Liga MX, MLS 1996→, LC 23–25, CCC | **basic only since Jan 2026** | ⛔ ToS 5(i) | ⛔ | ⛔ | credit requested | gutted |
| **Wikipedia** | everything incl. Leagues Cup | results tables | ⚠️ CC BY-SA | ⚠️ | ⚠️ **ShareAlike** | mandatory | ✅ |
| **Metrica / SoccerStatsUS** | anonymised / Liga MX 1902–2016 | tracking / results+scorers | ⛔ **no licence** | ⛔ | ⛔ | — | dormant |

\* CC0 declared by a scraper-author over a third party's data — clean between us and the uploader,
silent as to the upstream site's terms.

---

## 3. Per-provider detail

### 3.1 American Soccer Analysis (ASA) — the headline finding

API root `https://app.americansocceranalysis.com/api/v1/`; docs
<https://app.americansocceranalysis.com/api/v1/__docs__/>; machine-readable spec (undocumented but
live) at `https://app.americansocceranalysis.com/api/v1/openapi.json` — 128 paths.

**Leagues (enumerated from the spec):** `mls`, `mlsnp`, `nwsl`, `uslc`, `usl1`, `usls`, `nasl`.
🚨 **No Liga MX.** `/api/v1/ligamx/games` and `/api/v1/ligamx/teams` both return **HTTP 404**,
while `/api/v1/mlsnp/games` returns valid records — so the 404 is a real "unknown league".

**History** (from each league's `season_name` parameter description): **MLS from 2013**, NWSL 2016,
NASL 2016, USL Championship 2017, USL League One 2019, MLS Next Pro 2022, USL Super League 2024-25.
Verified live: 2013 → 338 games, 2024 → 522, 2025 → 540, 2026 → 284 so far.

**Shot-level data with coordinates**, verified live:

```json
{"game_id":"7VqGZd8W5v","period_id":1,"expanded_minute":4,"game_minute":3,
 "shooter_player_name":"Paulo Nagamura","assist_player_name":"Graham Zusi",
 "shot_location_x":86.5,"shot_location_y":37,
 "shot_end_location_x":100,"shot_end_location_y":65.6,
 "distance_from_goal":18.7417,"distance_from_goal_yds":18.6865,
 "blocked":0,"blocked_x":0,"blocked_y":0,"goal":0,"own_goal":0,
 "shot_xg":0.0698,"shot_psxg":0,"head":0,
 "assist_through_ball":0,"assist_cross":1,"pattern_of_play":"Regular","shot_order":69}
```

Shot origin **and** end location, xG, post-shot xG, body part, assist type, pattern of play — for
every MLS shot since 2013, free and keyless.

**Other endpoints:** `/games`, `/games/xgoals`, `/games/game-flow`, `/games/periods`, `/players` (+
`xgoals`, `xpass`, `goals-added`, **`salaries`** — MLS only: `base_salary`,
`guaranteed_compensation`, `mlspa_release`), `/goalkeepers/*`, `/teams/*`, `/managers`,
`/referees`, `/stadia`. **goals added (g+)** decomposes every on-ball action into Dribbling,
Fouling, Interrupting, Passing, Receiving, Shooting
(<https://www.americansocceranalysis.com/what-are-goals-added>).

**Bulk access:** shots are per-match — `?season_name=2015` without a `game_id` returns HTTP 500.
Backfill ≈ 1 request per game: ~500/season × 13 seasons ≈ **7,000 requests**. Trivial.

**Scope limits:** `stage_name` for MLS accepts only Regular Season / Playoffs / MLS is Back.
`?stage_name=Leagues Cup` returns `[]`. **No Leagues Cup, no CCC, no Liga MX, no Europe.** Also no
raw pass/tackle/take-on stream — the models are exposed, not the underlying touch data.

**🚩 Two risks, and they are the reason this is Tier 2 not Tier 1:**

1. **No published licence or terms of any kind.** Not in the docs, not in `openapi.json`'s `info`
   block, not in either client repo, not on the site. The MIT licence on `itscalledsoccer`
   (<https://github.com/American-Soccer-Analysis/itscalledsoccer>, actively maintained, last push
   2026-08-01) covers *the client code*, not the data. No documented rate limit either;
   `app.americansocceranalysis.com/robots.txt` returns 404.
2. **Provenance.** ASA's own archive states verbatim *"We get our data from Opta"*
   (<https://www.americansocceranalysis.com/home/category/Data+Sources/>, 2013-05-10), and MLS/US
   Soccer named Stats Perform their exclusive data provider
   (<https://www.statsperform.com/news/mls-and-u-s-soccer-combine-forces-with-stats-perform-to-collect-and-leverage-match-data/>).
   **That is the same company that terminated FBref's feed in January 2026.** ASA's xG and g+
   *models* are their own IP; the shot events are Opta-derived.

**Action: email ASA for written permission before shipping commercially — and mirror what we need
now regardless.** A single upstream decision could remove this exactly as it removed FBref's.

### 3.2 Sportmonks — recommended commercial provider

Docs <https://docs.sportmonks.com/football> · pricing
<https://www.sportmonks.com/football-api/plans-pricing/> · coverage
<https://www.sportmonks.com/football-api/coverage/> · terms
<https://www.sportmonks.com/terms-of-service/>

**Coverage — 9/9, confirmed with league IDs** from their coverage page: **Liga MX `#743`**,
**Major League Soccer `#779`**, **Leagues Cup `#3211`**, **CONCACAF Champions League `#1111`**,
Premier League `#8`, La Liga `#564`. Their MLS page states North American coverage is *"end to end
alongside MLS, including the U.S. Open Cup, **Leagues Cup**, Canadian Championship, USL
Championship, MLS Next Pro, NWSL, and **Liga MX**"*
(<https://www.sportmonks.com/football-api/mls-api/>).

**The per-league feature matrix — parsed directly from the coverage page (73 MB of HTML).** This is
the detail that changes the picture:

| Competition | ID | Standings | Odds | Fixtures | Adv. player stats | Std stats + **Lineups** | Livescores & events | Match stats | Live standings | Topscorers | Historical |
|---|---|---|---|---|---|---|---|---|---|---|
| Big five | 8/564/384/82/301 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Liga MX** | **743** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **MLS** | **779** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Leagues Cup** | **3211** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| **CONCACAF CL** | **1111** | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |

🚩 **Liga MX and MLS are first-class; Leagues Cup and the CONCACAF Champions Cup are thin.** Neither
gets player stats or lineups, Leagues Cup gets no match statistics, and CCC gets no standings. So
Sportmonks would replace ESPN for seven of our nine competitions and only partially for two — and
those two are precisely where ScoreArc's arc-bracket identity lives. Budget accordingly: this is a
cross-validation and redundancy purchase, not a like-for-like ESPN replacement.

**Pricing** (seen 2026-08-17, EUR/month):

| Plan | Monthly | Yearly (−20%) | Leagues | Rate limit |
|---|---|---|---|---|
| Starter | **€29** | €24 | any **5** | 2,000 calls/entity/hour |
| Growth | **€99** | €79 | any **30** | 2,500/entity/hour |
| Pro | **€249** | €199 | any **120** | 3,000/entity/hour |
| Enterprise | custom | — | all 2,300+ | 5,000/entity/hour |

Rate limits are **per entity per hour**, not per endpoint — 2,000 fixture calls *and* 2,000 team
calls *and* 2,000 player calls coexist (<https://docs.sportmonks.com/football/api/rate-limit>).

**Add-ons** (monthly / yearly-equivalent): extra leagues **€4/mo each** · **Historical data €29
one-time** · xG & Pressure Index **€29 / €24** · Odds & Predictions **€24 / €15** · extra API calls
€29 · News €99 · Transfer rumours €99 · Premium Odds €129 · **Premium Expected Lineups €199 / €159**
(Growth+ only). *(An earlier reading had the xG add-on at €24 — that is the yearly-billing rate.)*

**→ Nine competitions = nine league slots: €29 + 4 × €4 = €45/month, or €40/month annual.**

⚠️ **Verify the €4 before budgeting.** The pricing page lists "Extra leagues — €4/month", but
<https://www.sportmonks.com/glossary/extra-leagues/> says *"Contact the Sportmonks team for pricing
per additional league slot."* Two of their own pages disagree. Fallback is **Growth €99/mo**.

**History:** base subscription = **current season + last 3 seasons**. Deeper requires the
**Historical data add-on, €29 one-time**, reportedly reaching back to 2000 for select competitions
(<https://www.sportmonks.com/glossary/historical-football-data/> — **the 2000 figure is unverified
for the CONCACAF competitions**). Note their MLS marketing page claims *"Every MLS fixture, every
season, historical and current"* with records back to 1996 — that is marketing copy about top
scorers/standings/champions, not a statement about the base plan's match archive. Trust the
3-seasons number.

**Pitch coordinates — the important nuance.** Sportmonks is the only self-serve vendor with genuine
x/y. The `ballCoordinates` include
(<https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/includes/ballcoordinates>) returns
normalised X 0.01–1.01 and Y −0.02–1.02, ~568 entries per match (~6.3/min); passing events carry
`location_x`, `location_y`, `pass_end_x`, `pass_end_y`. **But availability is listed as Premier
League, La Liga, Serie A, Bundesliga, Ligue 1, UCL, UEL, World Cup, Euros only**, and *"Not all
fixtures have ball coordinate data available. The availability depends on the stadium's tracking
technology and data partnerships."* **Liga MX, MLS, Leagues Cup and CCC are not on that list.**

**Live latency:** ~15 s, and the `Latest Updated Livescores` endpoint returns everything changed in
the last 10 seconds — the right polling primitive for an ingester
(<https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/livescores-and-fixtures/livescores>).

**Injuries ✅ · suspensions ✅ · transfers ✅ (rumours €99/mo add-on) · confirmed lineups ✅ with
formations, shirt numbers, photos · predicted lineups ✅ (€199/mo) · xG + xPts ✅ (€24/mo) ·
Pressure Index ✅ · predictions across 20+ markets ✅ · market values — not found, unverified.**

**Resolved:** the docs sitemap has no injuries page because *there isn't one* — Sportmonks confirms
*"There isn't a standalone injuries or sidelined endpoint"*. Injury data is exposed as a
**`sidelined` include** on Fixtures, Teams and Players
(`?include=sidelined.sideline;sidelined.player`), **available on all plans, including the Free
Plan.** The Sidelined entity carries `player_id, team_id, season_id, type_id, category,
**start_date**, **end_date**, **games_missed**, **completed**` — i.e. genuine injury *history*, not
just a current snapshot. That is better than FPL (snapshot only) and better than RotoWire (2-week
lookback). A 2025-11-10 changelog entry added `sidelined.player` and `sidelined.type` includes; the
`type` object returns e.g. `{"name":"Groin Injury","model_type":"injury_suspension"}` — so
suspensions and injuries share one model. Their plans page lists *"injury and suspension updates"*
under "included in all plans".

⚠️ **But per-league injury coverage is undeclared.** Grepping the 73 MB coverage document for
`sidelined`, `injur` and `market value` returns **zero occurrences each** — there is no injuries
column in the matrix at all, and the Liga MX product page never mentions injuries. The changelog
also warns `sidelined.sideline` may be null when dates are unavailable. **Test `sidelined` against
`#743` and `#779` in the trial before counting on it.**

**Free plan:** Danish Superliga + Scottish Premiership only, but with full data features and 3,000
calls/entity/hour, no expiry, no card
(<https://www.sportmonks.com/football-api/free-plan/>). Plus a **14-day trial of any paid plan**.

**Terms — the best of the self-serve vendors** (<https://www.sportmonks.com/terms-of-service/>):

> *"Distribution, transfer, and storage of data provided by our services is allowed, but reselling
> the product is forbidden without our consent."*
> *"If you use our data to create something based on our data and start earning money from your
> creation, everything is fine."*
> *"Reselling Sportmonks' data without approval is not allowed. This means that you cannot directly
> sell the data we provide."*
> *"All logos and profile photos are copyrighted by their legal owner. To display these types of
> content in your app or website, you have to arrange proof of intellectual property yourself."*

Commercial use ✅ · public redistribution ✅ · **caching in our own Postgres ✅ (explicitly)** ·
**no attribution required** for the data · reselling ❌ · account sharing ❌.

🚩 **One clause that affects architecture, and it is easy to miss:**
> *"**Our data is exclusively available per domain**, and the prices listed on our website apply.
> It's important to note that the **pricing will be adjusted accordingly for multiple domains.**"*

scorearc.futbol is one domain. A second domain, or a separate app property, is a repricing event —
worth knowing before the roadmap sprouts a second surface. Their terms also disclaim completeness:
*"Coverage gaps may exist across certain leagues or competitions."*

**Market values: definitively not sold.** Grepping their complete documentation
(<https://docs.sportmonks.com/v3/llms-full.txt>, 893,110 bytes) returns **zero** occurrences of
`market_value`, `market value`, `valuation` or `transfermarkt`. This is settled, not inferred.
Note also that the Transfer entity's `amount` field has **no accompanying `currency`** (only
TransferRumour has one) — a real data-modelling gotcha.

**Stability:** API 3.0, version in the path (`/v3/`), v2 deprecated, per-endpoint docs. Their docs
explicitly warn *"Always rely on dynamic endpoints and MySportmonks as the source of truth, rather
than hardcoding static lists"* — our ingester should query `my/leagues` and `my/data-features`
rather than hardcode IDs.

### 3.3 API-Football — the coverage winner, the licensing loser

<https://www.api-football.com> · docs <https://www.api-football.com/documentation-v3> · coverage
<https://www.api-football.com/coverage> · pricing <https://www.api-football.com/pricing> · terms
<https://www.api-football.com/terms>

> *Method note: every api-football.com and api-sports.io URL returns HTTP 403 (Cloudflare managed
> challenge) to plain fetchers, curl and archive.org. The pages below were read by rendering them
> in a real browser engine. The coverage page is stamped `[Last-Update 2026-08-17]`; the docs read
> `API-FOOTBALL (3.9.3)`.*

**Coverage — 9/9, read off the per-league matrix.** Header: *"1239 Leagues & Cups"* and
*"All competitions are included in all our plans."*

| Competition | Events | Lineups | Fix. stats | Player stats | Predictions | Odds | Season stats | Top scorers | Standings |
|---|---|---|---|---|---|---|---|---|---|
| Big 5 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Liga MX** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **MLS** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Leagues Cup** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **CONCACAF Champions League** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |

Also present: MLS All-Star, MLS Next Pro, Liga MX Femenil, Liga de Expansión MX, Campeón de
Campeones, US Open Cup, Canadian Championship, CONCACAF Central American Cup, Gold Cup, Nations
League. Two notes for us: they still use the pre-2024 name *"CONCACAF Champions League"*, and
**neither Leagues Cup nor CCC exposes standings** — we would keep computing Leagues Cup phase
tables ourselves, exactly as commit `468b667` already does.

**No coordinates.** Zero occurrences of "coordinat" in the entire rendered v3 documentation. The
`fixtures/events` object is `{time, team, player, assist, type, detail, comments}` with types
Goal / Card / Subst / Var. The thing that looks like coordinates and isn't:
`fixtures/lineups` returns *"Players' positions on the grid — X = row and Y = column (X:Y)"* — a
formation-diagram slot, not pitch space. **No shot maps, no xG, no x/y.** VAR events exist from
2020-21 onward.

**History:** per-competition, exposed via `/leagues?id=X`'s `coverage` object and seasons list.
**The per-league season column is commented out of the coverage page HTML — unverified for Liga MX,
MLS and Leagues Cup specifically.** The pricing page states *"(Free plans are limited in terms of
available seasons)"* without saying how limited (**unverified**). Paid plans differ only in volume:
*"All our plans include all competitions and endpoints."*

**Live:** *"This endpoint is updated every 15 seconds"*, recommended polling 1 call/min per in-play
fixture. Some competitions have no livescore and only settle a final result — *"this can take up to
48 hours, depending on the competition."*

**Injuries ✅** (`/injuries` current + `/sidelined` per-player historical injuries and suspensions)
· **Transfers ✅** · **Market values ❌** · **Confirmed lineups ✅** · **Predicted lineups ❌**
(docs warn lineups are sometimes only available *after* the match). Extras: `/predictions`,
`/coachs`, `/trophies`, `/odds` + `/odds/live`, top scorers/assists/cards, `/venues`,
`/fixtures/headtohead`.

**Pricing** (seen 2026-08-17, USD/month): Free **$0** (100 req/day, 10/min) · **Pro $19**
(7,500/day, 300/min) · Ultra **$29** (75,000/day, 450/min) · Mega **$39** (150,000/day, 900/min) ·
Custom (up to 1.5M/day). Per-minute figures from
<https://www.api-football.com/news/post/how-ratelimit-works> (posted 2026-06-12). Prepaid,
**no auto-renewal**, up to −30% for longer commitments, no overage billing — the API just stops.

**⚠️ Architecture landmine.** That same article: rate limiting is applied **per API key *and* per
source IP**, and *"it is not recommended to call the API from environments where outbound IPs are
shared among many different users… such as Cloudflare Workers, AWS Lambda, Google Cloud Run,
Google Cloud Functions, Firebase Functions, **Vercel Functions**, Netlify Functions."* They
recommend a dedicated static IP. **Our Fly.io ingester can have one; calling this from Vercel
functions would invite firewall blocks.**

**ToS — the real problem** (French law):

> *"We do not provide a 'license' for the use and publication of the data provided by our services
> on applications, websites or any other products made by the user. Any license or permission to
> publish the data must be requested by the user from the competent authorities."*
> *"Some sports data provided through our services may be subject to intellectual property rights
> or commercial restrictions imposed by third parties, including leagues, federations, or event
> organizers. It is the responsibility of the user to verify and obtain any necessary
> authorizations… We does not grant any commercial rights on such competitions."*
> *"In case of a formal complaint or legal notice from a recognized rights holder… we reserve the
> right to immediately suspend or terminate the client's access to the API, without refund."*

Building a product is permitted; **no rights are granted**. Caching and storage are **not addressed
anywhere in the terms (unverified)**, though their rate-limit article actively recommends
*"Use server-side caching whenever possible."* Reselling is prohibited. Attribution not required.

**Auth:** `x-apisports-key` header against `https://v3.football.api-sports.io/`, or RapidAPI
headers. **GET only**, and *"if you… add headers that are not in the list, you will receive an
error"* — a real gotcha with JS HTTP clients that inject headers.

### 3.4 TheSportsDB — 9/9 at $9/mo, but a metadata DB not a match feed

<https://www.thesportsdb.com/documentation> · <https://www.thesportsdb.com/pricing> ·
<https://www.thesportsdb.com/docs_terms_of_use.php>

**All nine confirmed by direct API calls, with league IDs:** **Leagues Cup `5281`** (2022→2026,
`dateFirstEvent 2022-08-04`, live — the 2026-08-14 Portland 3–1 Tijuana result and the 2026-08-26
Monterrey v Chicago fixture both returned), **CONCACAF Champions Cup `4721`** (2020→2026), MLS
`4346` (2013→2026), Liga MX `4350` (2016-17→2026-27), EPL `4328` (1992-93→2026-27), LaLiga `4335`,
Serie A `4332`, Bundesliga `4331`, Ligue 1 `4334`. Also verified directly: their league search
returns Liga MX, Liga de Expansión MX, Liga MX Femenil and Campeón de Campeones for Mexico.

**History thins sharply going back.** Sampled: EPL 2010-11 and 2015-16 return scores with **0
lineup rows and 0 timeline rows**. Lineups and timelines appear from ~2019 (Europe) and 2023
(Leagues Cup).

**No coordinates.** Timeline gives `strTimeline`, `strTimelineDetail`, `intTime`, player/assist/
team. **Live: ~120 seconds**, premium only — the free tier has no livescore endpoint at all.
**Injuries ❌ · transfers ⚠️** (former teams/contracts at year granularity, no fees) **· market
values ❌ · predicted lineups ❌ · confirmed lineups ✅** (no formation) **· odds ❌.** Artwork
(badges, kits, cutouts) is the genuine differentiator.

**Free tier:** key is the literal string `123` (or `3` on V1), 30 req/min, all leagues — but
crippled row caps: `all_leagues.php` returns 10, `eventsseason.php` returns **15 of a ~380-match
season**, lineups/timelines return 5. Not viable for backfill.

**Pricing:** Single Developer **$9/mo** ($90/yr, $295 lifetime) — 2-min livescores, V2, 100 req/min.
Small Business **$20/mo** ($200/yr, $999 lifetime) — no row limits, 120/min, private key.
⚠️ Their Patreon charges **$11.50/mo for the same tier** — buy via the site.

**ToS (updated 01/07/2025) — unusually permissive and unusually clear:**
> *"You can scrape, copy and modify any content returned from the API, as long as you use the
> official end points."* · *"Please do not scrape our website."* · *"You cannot publish apps to an
> appstore unless you are a paid subscriber."* · *"You cannot resell our API in any way without
> specific permission."* · *"You can use our custom artwork in your projects but must mention us as
> the source of the data."* · *"We comply with any DMCA requests within 24hrs"* — don't hard-depend
> on their artwork CDN.

**Weakness: crowd-sourced.** A poor choice for cross-validation, which is precisely where accuracy
is the whole point. Good for artwork and long-tail metadata; not a truth source. Note **V2 has no
standings endpoint** — league tables are V1-only, and V1 is legacy.

### 3.5 football-data.org — disqualified, provably

Querying the live API unauthenticated, `GET https://api.football-data.org/v4/competitions` returned
**`count: 189`**. Enumerating all 189:

- **Liga MX** → code `LMX`, TIER_THREE, `numberOfAvailableSeasons: 10`, lastUpdated 2026-07-17
- **MLS** → code `MLS`, TIER_TWO, `numberOfAvailableSeasons: 7`
- **Leagues Cup → absent. CONCACAF Champions Cup → absent.** The only CONCACAF entry in the entire
  catalogue is `WC Qualification CONCACAF`.

**No plan at any price gets us Leagues Cup or CCC. It's out.**

For completeness: free tier = the 12 TIER_ONE competitions at 10 calls/min with **delayed scores**
(live starts at €12/mo). Pricing: Free €0 · Free w/ Livescores €12 · ML Pack Light €29 · Free +
Deep Data €29 (adds lineups, subs, scorers, cards, squads) · Standard €49 (30 comps) · Advanced €99
(50) · Pro €199 (100). Liga MX needs Advanced €99; MLS needs Standard €49 — and both still leave us
two competitions short. ⚠️ Rate-limit numbers **conflict between their own pages**
(<https://docs.football-data.org/general/v4/policies.html> vs the pricing page).

**Terms** (<https://www.football-data.org/about>, §7 and §9): attribution **required** —
*"Football data provided by the Football-Data.org API"*; and *"After cancellation of the
subscription… the Customer is not permitted to reference the football data obtained through the
Football-Data API on their own site or service"* — **our cached data would have to come down if we
stopped paying.** A poor fit for a permanent archive even if coverage were adequate.

### 3.6 StatsBomb open data — 🚩 **the licence forbids commercial use and redistribution**

Repo <https://github.com/statsbomb/open-data>, which now 301-redirects to
<https://github.com/hudl/open-data>. Actively maintained — last push **2026-05-26**.

**Coverage** (parsed from `data/competitions.json`, 80 competition-seasons): La Liga 1973/74 +
2004/05→2020/21 (the Messi corpus), Premier League 2003/04 + 2015/16, Serie A 1986/87 + 2015/16,
Bundesliga 2015/16 + 2023/24 ⚡, Ligue 1 2015/16 + 2021/22 ⚡ + 2022/23 ⚡, Champions League
1970/71–2018/19, World Cup 1958–2022 ⚡, Euro 2020 ⚡ + 2024 ⚡, Copa America 2024, AFCON 2023 ⚡,
NWSL, FA WSL, Liga F, Frauen-Bundesliga, Serie A Women, Women's WC, Indian Super League, Liga
Profesional (ARG) 1981 + 1997/98, Copa del Rey, North American League 1977. (⚡ = 360 freeze-frames.)

🚨 **The MLS entry is a trap.** `competition_id=44, season_id=107`, `match_available_360` populated
— but `data/matches/44/107.json` contains **exactly 6 matches, all Inter Miami, Aug–Oct 2023**: the
Messi arrival window. All six do have 360 freeze-frame files (6.4–7.8 MB each), so the granularity
is superb — but it is a highlight sample, not a season.

🚨 **No Mexico anywhere.** Country list: Africa, Argentina, England, Europe, France, Germany, India,
International, Italy, North and Central America, South America, Spain, USA.

**Licence — quoted from `LICENSE.pdf` ("StatsBomb Public Data User Agreement", last updated
8 September 2023):**

> **1.2. The User may not:**
> **1.2.1. edit, distort, distribute, reproduce, sell or in any way provide the data to any
> external or third party;**
> **1.2.2. commercially exploit the data or any analysis derived from the use of the Service;**
> **1.4.** The User is required to accredit any publication of analysis formed from StatsBomb Data
> with the StatsBomb brand logo.
> **7.** *"…all data provided through the Service, is the property of StatsBomb. The User shall,
> except as expressly permitted herein, shall not modify, translate, transfer, distribute, license,
> sell or otherwise exploit for any purposes whatsoever any data…"*

Governing law: England and Wales. StatsBomb Services Ltd, no. 10377735.

The permissive line everyone quotes — *"please state the data source as StatsBomb and use our
logo"* — is from the **README**, not the licence.

**Verdict: unusable in production.** scorearc.futbol is a public commercial product; 1.2.1 and
1.2.2 are unambiguous, and 1.2.2 reaches *derived analysis*. Private prototyping only.

### 3.7 Understat — best free European shot data, worst legal footing

Six leagues exactly: EPL, La Liga, Bundesliga, Serie A, Ligue 1, RFPL. **No MLS, no Liga MX.**
Seasons 2014/15 → 2025/26. Footer: "© understat 2017—2026".

⚠️ **The scraping shape changed** — the old inline `shotsData = JSON.parse(...)` is gone; shots now
come from `https://understat.com/main/getMatchData/{match_id}`, returning per-shot
`{minute, result, X, Y, xG, player, h_a, situation, shotType, player_assisted, lastAction}` with
normalised 0–1 coordinates, plus match-level `h_xg/a_xg`, `h_deep/a_deep`, `h_ppda/a_ppda`.

**No API, no terms page.** The only machine-readable statement is
<https://understat.com/robots.txt>, in full:

```
User-agent: *
Disallow: /
```

**Blanket disallow of the entire site.** No licence, no attribution scheme, no permission grant.

### 3.8 FBref / Sports-Reference — 🚩 **the advanced data is gone as of January 2026**

Primary source, Sports Reference blog, 2026-01-20
(<https://www.sports-reference.com/blog/2026/01/fbref-stathead-data-update/>), Sean Forman:

> *"Unfortunately, last week the provider of our advanced soccer data sent us a letter terminating
> our access to their data feeds and requiring the deletion of their data from the site immediately.
> As a result, we have removed the provider's data from FBref and Stathead in compliance with their
> demand."*
> *"FBref will continue to present the deep historic basic data we have for over one hundred
> competitions, but if we present advanced data in the future it will certainly have a
> **dramatically smaller scale**."*

⚠️ **The blog post does not name the provider.** Press coverage identifies it as Stats Perform/Opta
and notes the timing — eight days after Stats Perform was named FIFA's exclusive betting-data
distributor for the 2026 World Cup
(<https://awfulannouncing.com/soccer/sports-reference-pulls-advanced-data-agreement-violation-dispute.html>)
— but that attribution is **unverified**. Sports Reference denies the alleged violation, and
refunds are being offered to Stathead soccer subscribers.
**xG, xA, progressive passing and shot-creating actions are deleted.** Any plan assuming FBref
advanced stats for Liga MX or MLS is dead.

Basic coverage of our nine remains deep: Liga MX comp **31** (verified back to 2015-16; a secondary
index suggests 2003-04 — **unverified**), MLS comp **22** back to the **1996** inaugural season,
**Leagues Cup comp 939** added 2025-09-05 covering 2023–25, CCC comp **133** (depth unverified).

**Bot policy**, verbatim from <https://www.sports-reference.com/bot-traffic.html>:

> *"Currently we will block users sending requests to: **FBref and Stathead sites more often than
> ten requests in a minute.** … If you violate this rule your session will be in jail for up to a
> day."*
> *"**Why Not Provide an API?** Most of our data comes from third parties who sell the data to us.
> As part of our agreements with them we can not provide the data available as a download on our
> site."*

**Terms of Use §5(i)** is the clause that blocks us specifically — you may not

> *"use any material or Content from the Site… **to create any database, archive, or other data
> store that competes with or constitutes a material substitute for the services or data stores
> offered on the Site or by the Site's Data Providers**"*

and §5(j) separately bans use *"for purposes of training, fine-tuning, prompting, or instructing
artificial intelligence models"*. Their data-use page adds: *"**you should not create websites or
tools based on data you scrape from Sports Reference**"* and *"**We will not fulfill any requests
for data for custom downloads, unless you are prepared to pay a minimum of $5,000**."*

ScoreArc is a football stats site — i.e. precisely a "material substitute". FBref is off the table.
It is also now behind a Cloudflare interactive JS challenge; plain fetches get 403 even on
`/robots.txt` (verified today).

### 3.9 Football-Data.co.uk — has Liga MX **and** MLS, fresh, no licence

| Competition | File | Range | `Last-Modified` |
|---|---|---|---|
| **Liga MX** | <https://www.football-data.co.uk/new/MEX.csv> | **2012/13 → 2026/27**, 4,682 matches | 04 Aug 2026 |
| **MLS** | <https://www.football-data.co.uk/new/USA.csv> | **2012 → 2026**, 6,085 matches | 11 Aug 2026 |
| Big five | `mmz4281/{season}/{E0,SP1,I1,D1,F1}.csv` | 1993/94 → 2026/27 | current |
| Leagues Cup, CCC | — | ❌ absent | |

**Two schemas.** Core European files carry shots, shots on target, fouls, corners, cards, referee
and ~30 bookmakers of odds (match stats only from 2000/01). **The MEX/USA files carry only**
`Country, League, Season, Date, Time, Home, Away, HG, AG, Res` **plus closing odds — no half-time
score, no shots, no cards, no corners, no referee.** Both do include playoffs/liguilla.

**Licence: there is none.** The only scope statement, verbatim from
<https://www.football-data.co.uk/data.php>: *"**All data provided by Football-Data are made
available for the purposes of league match prediction only.**"* And `notes.txt` names its own
upstreams — *"Current results (full time, half time) XScores… Match statistics BBC, Flashscore,
ESPN Soccer, Bundesliga.de, Gazzetta.it and Football.fr"* — i.e. it is a secondary compiler and
cannot grant rights it does not hold.

"Free" here means free of charge, not freely licensed. **Use as a private reconciliation input, not
a redistributable dataset — and never surface the odds columns publicly.**

### 3.10 openfootball — CC0, and the only clean CONCACAF Champions Cup source

<https://github.com/openfootball/world>, **CC0-1.0**, last push **2026-08-17**.

- **Liga MX** — `2010-11_mx1.txt` → `2024-25_mx1.txt` (15 seasons, Apertura + Clausura + liguilla),
  plus `mx2ascenso` / `mx2expansion`.
- **MLS** — `2005_mls.txt` → `2025_mls.txt` (21 seasons).
- **CONCACAF Champions Cup** — `2010-11_concacafcl.txt` → `2025_concacafcl.txt` (15 editions).
  🚨 **The only free, cleanly-licensed CCC source found in this entire study.**
- **Leagues Cup — ❌ absent entirely.**

🚩 **The North America pipeline has lapsed.** Commit history for `north-america/` shows
`auto-update week 22` on 2025-05-31 and nothing content-bearing since. Proof from the data:
`2025_mls.txt` holds the full 510-match schedule but **only 164 matches carry a score**, last
scored 2025-05-04. Liga MX 2024-25 is complete only because that season ended just before the
updater stopped. European repos are current through 2026-27, so the org is alive — this pipeline is
not. **Do not architect around it staying current.**

**Format:** Football.TXT (spec at <https://github.com/openfootball/spec>) — full-time and half-time
scores, date, kickoff, matchday. No shots, cards, referees, lineups or xG. The JSON mirror has far
worse North American coverage; for Liga MX/MLS you must parse the `.txt`.

**Licence: CC0 1.0.** Critically, CC0's waiver explicitly enumerates *"rights protecting the
extraction, dissemination, use and reuse of data"* and *"database rights (such as those arising
under Directive 96/9/EC…)"* — the exact sui generis exposure Football-Data.co.uk leaves open.
Commercial ✅ · storage ✅ · redistribution ✅ · **attribution not required**.

*(Related: `footballcsv/*` is effectively abandoned — `footballcsv/major-league-soccer` covers
1996–2016 and died 2020-04-10. Superseded by openfootball.)*

### 3.11 transfermarkt-datasets — 🚩 looks like the answer, isn't

<https://github.com/dcaribou/transfermarkt-datasets> — **CC0 1.0** (verified: full CC0 text in
`LICENSE`), 472 stars, last push **2026-08-05**, refreshed **weekly** via GitHub Actions.

**Scale:** 79,000+ games, 37,000+ players, 1,800,000+ appearances, 1,100,000+ game events
(goals/cards/subs), 2,800,000+ lineup rows, 87,000+ transfers, 500,000+ **market valuations**.
12 joinable tables.

**Coverage — and this is where it falls apart for us.** `config.yml` lists seasons **2012–2025** and
an allowlist including **`MLS1`** and **`MEX1`** alongside `GB1, ES1, IT1, L1, FR1`. But the
*actual data* for our two competitions is far thinner than the config implies:

| Competition | Actual coverage in the published data |
|---|---|
| Big five | ✅ 2012-08 → 2026-05, ~4,300–5,300 games each |
| **Liga MX (`MEX1`)** | ⚠️ **only 2025-01-11 → 2026-04-27, 241 games — and Clausura only** |
| **MLS (`MLS1`)** | ⚠️ **only 2025-02-22 → 2026-05-25, 727 games** |
| **Leagues Cup / CCC** | ❌ absent |

Market values: 656,301 rows spanning 2000-01-20 → 2026-06-12 — but **Liga MX has 800 players with
506 valuations, MLS 1,018 with 820.** The European depth is genuine; the North American depth is a
year and a half.

🚩 **And the pipeline is currently broken.** Every scheduled acquisition run since **2026-07-14**
has failed (`Scraped 0 new records for clubs / RuntimeError: tfmkt failed`) — DataDome blocking
GitHub Actions IPs. Last good run **2026-07-10**; roughly a 1-in-3 success rate across 2026. The
newest valuation is dated 2026-06-12, i.e. **a two-month blind spot straight through the summer
window.**

**No shots, no xG, no coordinates.**

⚠️ **Legal caveat — stronger than it first appears.** The CC0 dedication is the *repo author's*,
over data scraped from Transfermarkt against an express §11.1 prohibition and a §44b TDM
reservation. CC0 waives rights the licensor *holds*; `dcaribou` holds copyright in the pipeline
code, not Transfermarkt's §87a database right. **The CC0 badge cannot convey rights its publisher
never had.** The companion `dcaribou/transfermarkt-scraper` has **no LICENSE file at all**
(`license: null` — all rights reserved), so its code is not reusable either.

**Verdict: this fails on coverage, on freshness, and on law — all three independently — before you
reach the ethics question.** I had this in Tier 1 on an earlier reading of `config.yml` alone;
reading the actual data moves it out.

#### ✅ There IS one legitimate Transfermarkt route — and it is not Transfermarkt

**SCOUTASTIC.** Transfermarkt GmbH & Co. KG took **50.1% of SCOUTASTIC GmbH** (Bremen) in August
2020 to build its B2B arm. Scoutastic's own site states verbatim (<https://scoutastic.com/en/>):

> *"**SCOUTASTIC has exclusive rights to the official Transfermarkt.de data.** … Furthermore,
> SCOUTASTIC offers an API. **Clubs that use SCOUTASTIC can thus legally and securely create
> further scouting analyses using Transfermarkt data.**"*
> *"**REST API for Accessing Transfermarkt & Soccerdonna Data** … can be integrated directly into
> your company's BI platform via the REST API."*

Their own testimonials include the **MLS Players Association** (*"The integration with the
Transfermarkt API has helped us to build a comprehensive and up-to-date understanding of the
players we serve"*) and Club Brugge (*"Transfermarkt's contract and transfer data"*).

**That exclusivity grant also settles a question: nobody else legally resells Transfermarkt market
values.** Any vendor claiming to is either mistaken or reselling a scrape.

⚠️ No public pricing (demo request only), and the product is positioned for clubs, federations and
agencies — **whether a consumer fútbol site can license this way is unverified.** That is the email
to send: `info@scoutastic.com`, cc `sales@transfermarkt.com`.

#### Licensable alternatives to Transfermarkt market values

| Provider | Product | Liga MX / MLS | Price |
|---|---|---|---|
| ⭐ **SciSports** | **Estimated Transfer Value (ETV)** | Global; **Club América** a named client | Not published |
| **CIES Football Observatory** | Peer-reviewed transfer-value model | ✅ **MEX, USA, CAN all in the league list** | Free tier = top-valued player per club only; full per-player = paid |
| **Football Benchmark** | 10,000+ players | "UEFA, CONMEBOL, **CONCACAF**, AFC" — not itemised | Demo only |
| **Analytics FC — TransferLab** | 101 leagues, 90,000 players, incl. salary data | Not named | 7-day free trial; "API Connect" exists |

**The SciSports datapoint is the most useful thing in this table.** Since **2026-02-25**, their ETV
has been *"fully integrated into FotMob's mobile app and website, bringing AI-driven player
valuations to every fan, for every player, across the globe"*
(<https://www.scisports.com/fotmob-partners-with-scisports-to-power-new-player-value-insights/>).
**That is proof they licence valuations for exactly our consumer-facing use case** — which makes
them the first call if market values ever become a priority, rather than treating the gap as
permanent.

### 3.12 Wyscout / Pappalardo figshare — the best commercially-usable event data with coordinates

<https://figshare.com/collections/Soccer_match_event_dataset/4415000> (DOI
`10.6084/m9.figshare.c.4415000.v5`), paper <https://www.nature.com/articles/s41597-019-0247-7>.

**Coverage: 2017/18 only** — LaLiga 380, Premier League 380, Serie A 380, Bundesliga 306, Ligue 1
380, World Cup 2018 (64), Euro 2016 (51). **1,941 matches, 3,251,294 events, 4,299 players.**
🚨 No Liga MX, MLS, Leagues Cup or CCC.

**Coordinates: yes**, verbatim from the Events item: *"**positions**: the origin and destination
positions associated with the event. Each position is a pair of coordinates (x, y). The x and y
coordinates are always in the range [0, 100] and indicate the percentage of the field from the
perspective of the attacking team."* Event types: pass, foul, shot, duel, free kick, offside, touch,
each with sub-types and tags.

JSON, `events.zip` = 77 MB. Frozen (last modified 2019-10/2020-01), verified downloadable today.

**Licence: CC BY 4.0** — the figshare API returns
`"license": {"name": "CC BY 4.0", "url": "https://creativecommons.org/licenses/by/4.0/"}` for every
data item. **Commercial ✅ · storage ✅ · redistribution of derived stats ✅ · attribution
MANDATORY** (cite Pappalardo & Massucco 2019 and the DOI).

### 3.13 RSSSF — the deepest free Liga MX history anywhere

Champions index <https://www.rsssf.org/tablesm/mexchamp.html> (**1902-03 → 2025-26**); season index
<https://www.rsssf.org/tablesm/mexhist.html>.

Season pages carry **full round-by-round results with dates, scores AND goalscorers with minutes**,
plus Liguilla two-leg results, final tables, top scorers, Liga Expansión, Campeón de Campeones and
champion squads. Verified, e.g. on <https://www.rsssf.org/tablesm/mex79.html>:
`Atlante 1-3 Cruz Azul [Gustavo Beltrán 46; Omar Mendiburu 22, Adrián Camacho 26, José de Jesús Jiménez 75]`.

⚠️ **URL patterns are inconsistent** — `mex2015`, `mex2020`, `mex79`, `mex08`, `mex99` return 200;
`mex2005`, `mex2010`, `mex1995`, `mex2000` return 404. Crawl `mexhist.html` for the real link list.
Format is plain text inside `<pre>`, **latin-1 not UTF-8**. This is a parser job, not a download.

Maintained — footer reads "Last updated: 19 Mar 2026".

**Licence**, verbatim from <https://www.rsssf.org/>: *"(C) Copyright RSSSF 1999/2026. **You are free
to copy this document in whole or part provided that proper acknowledgement is given to the
RSSSF.** All rights reserved."* Attribution mandatory. (The Norway mirror adds a non-commercial
restriction; the main .org statement does not.)

No CONCACAF club-competition index was found.

**This is the only path to pre-2001 Liga MX, and it has goalscorers. Nobody has properly parsed it
— that is a moat, not a commodity download.**

### 3.14 Wikidata / Wikipedia / DBpedia

**Wikidata — CC0, but essentially no match data.** Live SPARQL: total
`association football match` (Q12166442) entities in all of Wikidata = **41,123**. Per competition:
MLS 52, Ligue 1 51, LaLiga 28, CCC 12, Premier League 9, Bundesliga 4, **Liga MX 4**, Serie A 3,
**Leagues Cup 0**. These are notable finals, not fixture lists.

Where it *is* useful: **season entities** (Liga MX **131** back to 1943, CCC 59 back to 1967, MLS 36
from 1996) — though shallow, with only 87 of 131 Liga MX seasons carrying a `winner`; and
**squad/transfer history** via `P54` with date qualifiers, which genuinely covers Mexico (Chivas
546 players, Club América 534, Cruz Azul 399), ~60–80% complete on start dates.

Etiquette (<https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual>): 60-second timeout;
*"One client (user agent + IP) is allowed 60 seconds of processing time each 60 seconds"*; 5
parallel queries per IP; *"Clients who don't comply with the User-Agent policy may be blocked
completely"*. The full dump is ~102 GB — use targeted SPARQL.

**Licence** (<https://www.wikidata.org/wiki/Wikidata:Licensing>): *"All structured data in the main,
property and lexeme namespaces is made available under the Creative Commons CC0 License."*
Commercial ✅, storage ✅, redistribution ✅, **no attribution required**.

**Wikipedia — more data, copyleft caveat.** Season articles carry complete score matrices (e.g.
<https://en.wikipedia.org/wiki/2024%E2%80%9325_Liga_MX_season> has the full 18×18 grid, liguilla
brackets and top scorers) but **scores only, no dates**. Licence: CC BY-SA 4.0 + GFDL
(<https://en.wikipedia.org/wiki/Wikipedia:Copyrights>).

The nuance that matters: individual scorelines are uncopyrightable facts, so extracting a handful
is not a derivative work. **But** systematic bulk extraction of whole results tables implicates the
EU/UK sui generis database right, which CC BY-SA 4.0 §4 *does* license — **with ShareAlike
attached**, meaning a substantially-extracted derived database would itself have to be CC BY-SA
4.0. That conflicts with treating our DB as a proprietary asset. **Use Wikipedia to fill gaps and
cross-check with a link, not as a bulk backfill.**

**DBpedia — skip.** Infoboxes only, **zero per-match data**, only 8 `*_Liga_MX_season` resources,
mangled triples (`highestAttendance = --07-26`), ~1 year stale, and licensed CC BY-SA **3.0** —
which, unlike 4.0, does not clearly license sui generis database rights. Strictly dominated by
Wikidata.

### 3.15 Other open datasets, screened

- **DFL / IDSSE official tracking** (<https://www.nature.com/articles/s41597-025-04505-y>) — 2
  Bundesliga + 5 2.Bundesliga matches, 2022/23, **25 Hz TRACAB positions (1,002,644 frames)
  integrated with official Sportec event data (11,137 events)**, XML, ~2.63 GB. *"All data was
  provided by the original data collector, i.e., DFL with the permission to publish them under
  CC-BY 4.0."* **The only free, commercially-usable official tracking data that exists.** A
  pipeline-validation corpus, not a backfill.
- **SkillCorner open data** (<https://github.com/SkillCorner/opendata>) — **MIT**, actively
  maintained (push 2026-08-07). ⚠️ The dataset was **replaced**: current `master` is 10 matches of
  the 2024/25 **Australian A-League**, not the original European games. Friendliest terms of any
  tracking dataset, and useless for our competitions.
- **Metrica Sports** (<https://github.com/metrica-sports/sample-data>) — dormant since 2021-04-15,
  3 matches, **anonymised** (*"no references to the names of players, teams or competitions"*), and
  `LICENSE` returns **404** with `license: null` via the API. The README's *"Please be responsible…
  please aknowledge the source"* is not a grant. **Treat commercial use as not permitted.**
- **socceraction / SPADL** (<https://github.com/ML-KULeuven/socceraction>) — MIT library that
  converts StatsBomb/Wyscout/Opta feeds into SPADL and values actions with VAEP/xT. README:
  *"be aware that socceraction is not actively developed."* **MIT covers the code; it does not
  launder the source data's licence.** Useful if we adopt SPADL as our internal event schema.
- **`excel4soccer/espn-soccer-data` on Kaggle** — 🚨 1.61 GB, version 645, **updated daily (last
  2026-08-17)**, claiming *"400+ unique leagues"* with lineups, play-by-play, key events,
  commentary and team/player stats. This is a rolling archive of **exactly the ESPN API ScoreArc
  already reads** — potentially the historical backfill ESPN's live API won't serve. 🚩 But the
  "MIT" tag is declared by a non-rights-holder over ESPN's data and grants us nothing against
  ESPN, and the author's own site describes only seven European leagues, contradicting the 400+
  claim. **Liga MX/MLS inclusion unverified.**
- **Kaggle Liga MX sets** — `gerardojaimeescareo/ligamx-matches-2016-2022` (CC0, 2016→2024,
  results + referee + venue, no shots) and `gerardojaimeescareo/ligamx-events` (CC0) — 🚩 the
  latter's "events" are **goals/cards/subs at minute resolution only**; 2.6 MB for six seasons
  tells you everything. **No coordinates.**
- **`josephvm/major-league-soccer-dataset`** (CC0) — MLS matches 2001–2021, ~420k events 2008–2021.
  Abandoned 2022-07. Coordinate presence **unverified — assume none**.
- **Rejected:** `hugomathien/soccer` (author: *"I must insist that you do not make any commercial
  use of the data"*), `secareanualin/football-events` (licence "Unknown"; events *"derived by
  reverse engineering the text commentary, using regex"*), `scottiemeadows/...` (**synthetic
  data**), SoccerNet (**NDA-gated**), PFF FC WC2022 (no licence published anywhere).
- **SoccerStatsUS/concacaf_data** — richest CONCACAF archive found (Liga MX 1902–2016, CCC
  1960s–2020 with goalscorers, assists, lineups, cards) but **no LICENSE file at all**, and its own
  headers read `BlockSource: http://rsssf.com/tablesm/mex2017.html` — it is machine-readable RSSSF,
  frozen at 2016. Not redistributable without contacting the author.

### 3.16 Enterprise providers

**Stats Perform / Opta.** No self-serve: `developer.statsperform.com` does not resolve;
`documentation.statsperform.com` returns **HTTP 401 Basic auth**. You cannot read the Opta docs
without a contract. Their FAQ says pricing suits *"large **and small** enterprise-level clients"*
and that *"custom licensing [is] available by competition, country, or data level"* — so a
Liga MX + MLS + Leagues Cup-only licence is structurally possible — but there is no trial, no
sandbox and no entry tier (<https://www.statsperform.com/faqs/stats-perform-faqs-pricing-licensing/>).

The **only official Opta dollar figures in public** are in their own Master Licence Agreements:

| Term | MLA 2020 | **MLA December 2025** |
|---|---|---|
| API calls in base | 5,000,000/month | **2,000,000/month + 20 calls/sec** |
| Incremental fee | $500 per additional 1M/mo | **$1,500 per additional 1M/mo** |
| Renewal uplift | +15%/term | +15%/term |

(<https://www.statsperform.com/mla2020/>, <https://www.statsperform.com/legal/mla-december-2025/>.)
Base fees are always "as specified in the Work Order" — never published. Note the direction of
travel: base allowance **fell 60%** while overage **tripled**.

🚩 **The Dec 2025 licence is directly hostile to ScoreArc's architecture.** It forbids
sublicensing, syndication and white-labelling; mandates a Stats Perform logo and copyright line for
the term; adds a new prohibition on using the data *"to create, develop, test, train, modify,
enhance, populate, or support machine learning, generative artificial intelligence or artificial
intelligence models"*; and — most pointedly — states the licensee *"**shall not bulk download or
otherwise build archival files**."* **Even a paid Opta licence would not straightforwardly permit
"own the data → history".**

Coordinates live in `MA3` (legacy `F24`); tracking is a separate product, **Opta Vision**. Opta is
**CONCACAF's official data partner**. The one fully disclosed contract value: the **BBC Sport Data
Feed**, UK Find a Tender award `2025/S 000-033085` (17 June 2025) — supplier Perform Content Ltd,
**£4,500,000 ex VAT over four years ≈ £1.125M/year**, awarded by direct award
(<https://www.find-tender.service.gov.uk/Notice/033085-2025>). Multi-sport and BBC-scale, so an
upper bound — but it is the only verified Opta contract figure that exists.

**Sportradar.** Self-serve *trials* yes, published prices no — decompiling their marketplace SPA
bundle found **zero** occurrences of `price`, `pricing`, `currency` or `amount`. Trial = 30 days,
**1,000 requests per rolling 30 days, 1 QPS**. 🚩 And the trial cannot legally power a public site:
their US Master T&Cs (last updated 2026-08-05) define Free Trial as *"**non-commercial** use …
for **internal testing and evaluation purposes only**"* (§1.14) and §3.1 forbids *"any commercial
use or any use involving publication or display of the Data or Content in any form or media."*
Running a public site off a trial key breaches it twice.

🚩 **And §7.4 is a strategic landmine for ScoreArc specifically.** On termination, the customer must
within thirty days *"commence and thereafter diligently pursue the **destruction and sanitization of
all data and databases** relating to all data, databases, feeds, content, and statistical
information licensed… **including without limitation all historical data**."* Our roadmap is
*own the data → history → AI-powered stats*. **Sportradar's terms mean the day we stop paying, the
history we accumulated is contractually destroyed.** That is the opposite of owning our data — and
worth noting that §1.21 does otherwise expressly contemplate *"storage on customer servers"* while
the contract is live.

Paid contracts also carry an **annual escalator of the greater of US CPI or 5%**, overage fees, a
mandatory *"powered by Sportradar"* logo (§2.12), audit rights twice yearly, and a right to raise
fees on 30 days' notice if an upstream rightsholder does. Coordinates are **Extended tier only**:
*"Detailed event data with XY coordinates for all events."* Reported prices range from
"$1,250/month" (a competitor's blog) to "$10,000+/month" — **both unverified and mutually
inconsistent by 8×.**

**Genius Sports / Second Spectrum.** `developer.geniussports.com` documents the APIs but `/signup`
returns 403 and `api.geniussports.com` returns 403 — it is documentation for existing contract
holders. **No published Genius prices exist anywhere.** Second Spectrum (official tracking provider
of the EPL, NBA and MLS, acquired 2021 for $200m) now redirects to
`performancestudio.geniussports.com`, which returns **HTTP 401** behind an Auth0 wall. **Genius
holds Liga MX exclusively — see §4.**

**Hudl Wyscout.** Published video tiers (Copper → Diamond) carry **no currency amounts in 2026**;
the €299/€399 figures that circulate are historical. But the **API is real and has coordinates** —
the live OpenAPI spec at `https://apidocs.wyscout.com/assets/specs/prod/current.yml` (1.1 MB,
OpenAPI 3.0.1) documents four packs (Database, Statistics, **Events**, Videos) and states:
*"The subject's goal to be defended is always **x=0%** and the attack is always **x=100%**."*
Passes, carries, possessions and shots carry `location{x,y}`, `endLocation{x,y}`. HTTP Basic auth,
12 req/sec. **No licence or redistribution text anywhere in the spec.** Marketing claims 600+
leagues and "up to five years of historical data", plus a **Physical Data Pack** from broadcast
tracking. **Liga MX/MLS coverage unverified** — no machine-readable competition list is published.
**Price unverified**; the circulating "£5,000 per league per year" traces to a single 2024 tweet
relaying an email quote. Hudl's public User Terms grant only a *"non-sublicensable"* licence for
*"intended purposes based on your Role"* — **no self-serve licence permits public display on a
commercial third-party site.**

**Hudl StatsBomb.** Positioning, verbatim: *"Hudl Statsbomb is for professional soccer
organizations"* (<https://www.hudl.com/products/statsbomb/faq>). 3,400+ events/match, 360 data,
FIFA-Basic-certified broadcast tracking, physical metrics, OBV/xPass/HOPS models, API in
JSON/XML/CSV. **No pricing published; whether a small company can buy is unverified** — the framing
suggests not.

**SkillCorner.** 120+ competitions, 30,000+ games/season. **Neither Liga MX nor MLS is named on any
public page (unverified)**, though their client wall includes LA Galaxy and Detroit City FC.
XY tracking from single-camera broadcast, physical data (speed zones, acceleration profiles, peak
velocity), Game Intelligence (off-ball runs, pressures, phases of play). **`skillcorner.com/pricing`
returns 404**; every CTA is "Get a Demo". **Not purchasable at small scale.**

**PFF FC** (<https://fc.pff.com/>, HTTP 530 today, **partially unverified**) — event data 2024/25 =
Premier League + UCL, expanding from 2025 to EPL + EFL Championship/L1/L2 + UCL. Broadcast tracking
and physical metrics across 40 competitions incl. North America. No public pricing. **Its event
coverage does not include Liga MX or MLS.**

**Answer to "is physical/tracking data enterprise-only in 2026?" — confirmed, yes.** Hudl,
SkillCorner, Second Spectrum, Opta Vision and Sportradar Extended are all sales-gated with no
published price and no small-scale route.

**With one free exception worth knowing about.** FIFA publishes free per-match **Post-Match Summary
Report** PDFs for the 2026 World Cup on the FIFA Training Centre
(<https://www.fifatrainingcentre.com/en/fifa-world-cup-2026/match-report-hub-knockout-stage.php>),
and they are far richer than expected. The Final's report (`PMSR-M104-ESP-V-ARG.pdf`, 6.06 MB)
contains a per-team **Physical Data** page with per-player rows:
`Total Distance (m) | Zone 1 <7 km/h | Zone 2 7–15 | Zone 3 15–20 | Zone 4 20–25 | Zone 5 >25 |
High Speed Runs | Sprints | Top Speed (km/h)` — plus team-level xG, Line Breaks, Defensive Line
Height & Team Length, Receptions in the Final Third, Ball Progressions, Defensive Pressures
Applied, Forced Turnovers, Phases of Play %, and cross locations/zones/delivery types.

🚩 **But the licence kills it for us.** FIFA Training Centre ToS §5.3 restricts use to *"privately
for **non-commercial purposes**"*; §6.4(a) grants a display licence *"**solely for non-commercial
purposes**"* with mandatory attribution; §6.6 forbids *"robots, spiders or other automated
programmes"* (<https://www.fifatrainingcentre.com/en/terms-of-service.php>). **Link to the PDFs;
do not ingest and republish them.**

### 3.17 Smaller commercial APIs, briefly

- **Highlightly** (<https://highlightly.net/football-api/>) — cheapest credible option at
  **$9.49/mo** (7,500 req/day; free $0/100 req/day). Verified: big five, MLS, Liga MX. **Leagues
  Cup and CCC are not listed and "CONCACAF" appears nowhere on their coverage page —
  unverified.** Richest metadata at this price: injuries, **career transfers with fees**,
  **market-value time series**, confirmed lineups 30–60 min pre-kickoff. No coordinates. Refresh:
  matches/events 1 min, statistics 5 min, lineups 15 min, with all SLAs disclaimed. **Best terms in
  the survey (§6.1):** *"Distribution, transfer, and storage of the data provided by the Service are
  allowed. You are free to use the data in your applications and products."* **Not versioned** —
  base URL has no version segment.
- **SportsData.io** — has **Leagues Cup (ID 49)**, MLS (8), Liga MX (12), big five, but **CCC is
  absent** → 8/9. Soccer is not self-serve: the Leagues API *"requires a commercial agreement"*, and
  the self-serve Discovery Lab ($99–$149/mo) **explicitly excludes soccer** and is *"Not licensed
  for commercial redistribution."* Free trial serves **scrambled fake data**.
  `PitchPositionHorizontal/Vertical` (0–50) are a formation diagram, not event coordinates.
- **Goalserve** — MLS ✅, Liga MX ✅, CCC ✅, **Leagues Cup ✗**. Results from 2006, granular stats
  from 2016, live 3–5 s, predicted **and** confirmed lineups, injuries. `ball_pos` is a live ball
  position, not per-event shot x/y. Full Stats $300/mo, Full Soccer $550/mo. **No data licence
  published anywhere** — their T&Cs cover billing only.
- **SoccerDataAPI** — **no Leagues Cup, no CCC** → 7/9, disqualified. Mid-rebrand to StatPal, docs
  last updated Oct 2023, returns **HTTP 200 on errors**, and its ToS bans *"any revenue-generating
  endeavor, commercial purpose"* and *"systematically retriev[ing] data… to create… a database"* —
  i.e. it bans our ingester outright. Rule it out.
- **LiveScore API** — 464 competitions with IDs (Liga MX 45, MLS 76, CCC 268); **"Leagues Cup"
  returns zero matches**. €11–€69/mo. *"The team's logos may not be commercialized."*
- **Statorium** — Liga MX, MLS, CCC listed; **no Leagues Cup**. Real entry is the 25-league plan at
  €99/mo. One-domain licence.
- **Entity Sport** — MLS on Starter, but **Liga MX and CCC are Elite-only** and there is **no
  Leagues Cup** → entry price **$750/mo**.
- **Broadage** — Liga MX, MLS, CCC ✅; **no Leagues Cup**. ⚠️ Their published coverage metadata says
  MLS has 23 teams and the current champion is Toronto FC (2017) — roughly eight years stale.
- **SoccersAPI** — catalogue is client-side-only and unverifiable; terms simultaneously forbid
  *"publicly perform, distribute, or otherwise use the Material… for any public or commercial
  purpose"* and require attribution *"in any publication or distribution of said data."* Incoherent.
- **AllSportsAPI** — World Wide plan $111/mo; terms allow *"distribution, transfer and storage"*
  then contradict themselves with *"personal, non-commercial use"* two sentences later.
- **RapidAPI resellers** (Football Pro, Livescore6, Sofascore-style feeds) — no vendor-owned primary
  source, no SLA, no versioning; anything presenting Sofascore data is a scraper with real takedown
  exposure.

### 3.18 Injuries — the awkward gap

- **API-Football**: `/injuries` + `/sidelined` (injuries *and* suspensions, per player and coach).
  Depth for Liga MX/MLS specifically **unverified** — testable free at 100 req/day.
- **Sportmonks**: ✅ via the `sidelined` include (no standalone endpoint), **on all plans including
  free** — see §3.2. This is the cheapest injuries coverage across all nine competitions.
- **Highlightly**: injuries listed, at $9.49/mo.
- **RotoWire is the only vendor verified to ship injury feeds for BOTH MLS and Liga MX.**
  `Soccer/MLS/Injuries.php` and `Soccer/LIGAMX/Injuries.php`, plus the big five and UCL
  (<https://rotowire.readme.io/llms.txt>). Richest field set found anywhere: `Injury.Type`
  (Knee/Ankle/Hamstring…), `Injury.Status` (OUT/GTD/Q/D/IR), `Injury.Detail`
  (Sprain/Strain/Fracture), `Injury.Side`, `Injury.ReturnDate`. Real-time; recommended polling
  5–60 min by context. **No Leagues Cup, no CCC. No published price** (B2B contact only), and their
  consumer soccer pages carry *"Portions copyright by STATS LLC"* — so some of it is sub-licensed
  from Stats Perform, which may cap what they can grant downstream. **Weakness: history is 2 weeks
  by default; there is no soccer injuries archive.**
- 🚩 **The official Fantasy Premier League API is free, keyless and richly populated — and using it
  is prohibited.** `https://fantasy.premierleague.com/api/bootstrap-static/` returns 1.38 MB with
  per-player `status` (`a`/`d`/`i`/`s`/`u`), `chance_of_playing_next_round` at 25-point granularity,
  `news` and `news_added`, refreshed on a 5-minute Fastly cache. But the Premier League's terms
  (<https://www.premierleague.com/terms-and-conditions>) state the site *"must not be used in any
  other way, **including for commercial purposes**, and you may not otherwise reproduce, re-utilise
  or redistribute it (**including, by way of example, creating a database (electronic or otherwise)
  that includes material downloaded or otherwise obtained from the Website or App**), or frame or
  **deep-link** to it… without our prior written approval."* **That clause names our exact three
  activities.** Note it contains no anti-bot language at all — the prohibition is an IP/database-
  right one, which means the UK sui generis right gives them a cause of action that does not depend
  on us having agreed to anything. **Do not put FPL data in production.** *(An earlier draft of this
  report recommended it; that was wrong.)*
- **MLS Fantasy no longer exists in a usable form.** `fantasy.mlssoccer.com/api/bootstrap-static/`
  returns 404, and the site's own title reads *"MLS Fantasy Just Got a New Home"* — MLS moved
  fantasy to **Kickbase** in February 2026
  (<https://www.mlssoccer.com/news/mls-and-kickbase-announce-collaboration-to-launch-new-fantasy-platform-ahead-of-2026-season>),
  mobile-app only. Kickbase's `/v4/competitions` answers unauthenticated (MLS = competition id 9)
  but **every endpoint carrying player availability returns 403**. Automating against an
  auth-walled API with a registered account is contractually *worse* than a keyless endpoint.
- ⭐ **Liga MX has a free, keyless injury feed — via Biwenger.**
  `https://cf.biwenger.com/api/v2/competitions/liga-mx/data?lang=en&score=1` returned 197 KB today,
  no key, `season: "Apertura 2026"`, 18 teams, 493 players, `update` timestamp **2026-08-17T07:18Z
  (this morning)**, with `{ok: 477, injured: 11, sanctioned: 5}` and real current names. Its
  `fitness` array is a rolling per-round history where each slot is a points integer or the literal
  `'injured'`/`'sanctioned'` — **recent availability history, which FPL does not provide at all.**
  ⚠️ Two caveats: `statusInfo` (the human-written reason and return date) is **null for every Liga
  MX player** — that text exists only for LaLiga; and **Biwenger's terms could not be retrieved**
  (JS SPA shell). Biwenger is owned by **Diario AS (PRISA)**, a commercial media company, and its
  Liga MX scoring is licensed from **SofaScore** — so we would sit downstream of a two-hop chain
  with neither hop's terms verified. **Prototyping and cross-validation only, not production.**
- **Goalserve has no soccer injuries endpoint at all** — NFL/NBA/MLB/NHL each have one; soccer does
  not. **PhysioRoom is no longer a data vendor** — it is now a retail store for physio equipment.
  **`injurydataapi.com` does not resolve.**
- **The official MLS API is dead.** The widely-circulated gist documenting
  `sportapi.mlssoccer.com/api/matches` and `stats-api.mlssoccer.com/v1/…` was probed today:
  `/api/matches` → 404, `/api/standings/live` → 404, `stats-api.mlssoccer.com/v1/clubs` → 404
  `{"message":"Endpoint Not Found"}`, `docs.mlssoccerapi.com` → DNS failure.
- **Market values**: only Transfermarkt (no licence) and Highlightly (a reseller). No clean route.

---

## 4. The Liga MX / MLS problem

**Providers verifiably covering both Liga MX and MLS:**

| Provider | Liga MX | MLS | Leagues Cup | CCC | Cost |
|---|---|---|---|---|---|
| **API-Football** | ✅ | ✅ | ✅ (no standings) | ✅ (no standings) | **$19/mo** |
| **Sportmonks** | ✅ `#743` | ✅ `#779` | ✅ `#3211` | ✅ `#1111` | **~€45/mo** |
| **TheSportsDB** | ✅ `4350` | ✅ `4346` | ✅ `5281` | ✅ `4721` | **$9/mo** |
| **RotoWire** (injuries only) | ✅ | ✅ | ❌ | ❌ | sales only |
| transfermarkt-datasets | ⚠️ **241 games, 2025+** | ⚠️ **727 games, 2025+** | ❌ | ❌ | free, but see §3.11 |
| openfootball | ✅ 10/11–24/25 | ✅ 05–25 | ❌ | ✅ 10/11–25 | free (CC0) |
| football-data.co.uk | ✅ results+odds | ✅ results+odds | ❌ | ❌ | free (no licence) |
| RSSSF | ✅ **1902–2026** | ❌ | ❌ | ❌ | free (attribution) |
| football-data.org | ✅ (€99 tier) | ✅ (€49 tier) | ❌ | ❌ | disqualified |
| FBref / Sofascore / WhoScored / FotMob / Transfermarkt | ✅ | ✅ | ✅ | ✅ | **legally unavailable** |

**Covering MLS but not Liga MX:** American Soccer Analysis, StatsBomb open data (6 matches),
Statorium, Big Balls Data. **Covering neither:** Understat, Wyscout figshare, SkillCorner, DFL.

### The decisive asymmetry

For **MLS** there is a free, coordinate-level, 13-season historical source (ASA). For **Liga MX**
there is nothing comparable at any price we would pay.

- No open Liga MX event or shot-location dataset exists on GitHub, Kaggle, HuggingFace or figshare.
  The full first page of a GitHub search for Liga MX data returns ten repos with 0–3 stars, most
  dead since 2017–2020. **There is no serious, maintained Liga MX open-data project.**
- Searches for Liga MX shot/xG data surface only *derived aggregate* tables on consumer sites
  (FootyStats, OddAlerts, xGscore) — no downloadable shot locations.
- Sportmonks has real x/y but **excludes** Liga MX, MLS, Leagues Cup and CCC from coordinate
  coverage. API-Football has no coordinates at all.

### The Liga MX rights position — the structural reason this is hard

**Liga MX appointed Genius Sports as its exclusive long-term Official Data, Streaming and Integrity
Partner on 2020-11-24**, covering Liga MX, Liga de Expansión, Copa MX and Liga BBVA Femenil —
*"the exclusive right across all… games to capture live data from in-stadia and distribute it"*
(<https://investors.geniussports.com/news/news-details/2020/Liga-MX-appoints-Genius-Sports-Group-as-exclusive-long-term-Official-Data-Streaming-and-Integrity-Partner/default.aspx>).
Still live as of 2026-06-10. As written, the exclusivity covers in-stadia capture and distribution
to licensed sportsbooks; whether it forecloses non-betting media data is **unverified**, and Opta
clearly still collects Liga MX independently. Genius publishes no prices and
`developer.geniussports.com/signup` returns 403.

Meanwhile **MLS** data routes elsewhere entirely: MLS partnered with **Sportec Solutions +
Deltatre** in March 2023 (12 Tracab 4K cameras per stadium, skeletal tracking, xG, across all MLS,
**Leagues Cup** and MLS NEXT Pro), with **IMG Arena** distributing — and **Sportradar acquired IMG
Arena in November 2025**
(<https://investors.sportradar.com/news-releases/news-release-details/sportradar-announces-close-acquisition-img-arena-and-its>).

**So MLS enhanced data routes through Sportradar, Liga MX official data routes through Genius, and
Opta collects both independently. There is no one-stop vendor for our two core leagues.** That is
corroborated in MLS's own page source, which carries Opta IDs *and* Sportec IDs side by side.

Sportradar's own public coverage matrix (queried live) makes the asymmetry concrete:
**MLS `sr:competition:242` is full across the board** including `Extended Statistics 2` and
`Deeper Play by Play 2`; **Liga MX `sr:competition:27464` reports `Extended Statistics 0`** with
deeper stats true for Apertura and **false for Clausura**; **Leagues Cup `29472` reports
`Extended Statistics 0` and `Lineups 0`**. Even the enterprise vendor treats Liga MX as second
class.

### 🚨 The trap: FotMob has exactly what we want for Liga MX, and forbids it four ways

`https://www.fotmob.com/api/data/matches?date=20260816` returns **139 leagues** with no auth and no
key, including **Liga MX (id 230)**, Liga MX Femenil, Liga de Expansión MX, **MLS (913550)** and MLS
Next Pro. And `…/api/data/matchDetails?matchId=…` for a Liga MX match returns 309 KB containing
`shotmap`, `momentum`, `attackingZones`, `heatmapUrl`, `playerStats` — with shots shaped:

```json
{"eventType":"AttemptSaved","playerName":"Raphael Veiga",
 "x":79.669,"y":35.296,"blockedX":81.697,"blockedY":35.296,
 "goalCrossedY":34.839,"goalCrossedZ":1.22,
 "expectedGoals":0.017,"expectedGoalsOnTarget":0,
 "shotType":"LeftFoot","situation":"RegularPlay","isFromInsideBox":false}
```

That is pitch coordinates, blocked coordinates, goal-mouth crossing point, xG and xGOT — for
**Liga MX**. The payload is littered with `optaId` fields, confirming FotMob is an Opta licensee.

**It is also the single most explicitly prohibited source in this entire study.** Their
`robots.txt` reads `Disallow: /api/*` for everyone except Googlebot, Qwantbot, Bingbot and
AmazonAdBot. Their ToS (Norwegian law, exclusive jurisdiction Bergen) prohibits it in four separate
sentences. And scraping it would interfere with FotMob's own Opta contract.

**The convenience is the hazard.** Nothing will stop us, and nothing will warn us, until a letter
arrives. Do not build on it.

### The irony worth internalising

**ESPN's key-events feed is currently the best free Liga MX granularity we can plausibly reach.**
Measured
today against `site.api.espn.com`: Liga MX `mex.1` goes back to **2001** (2001 → 167 events, 2002 →
204, 2003 → 208); **Leagues Cup `concacaf.leagues.cup`** returns 2019 (7 events) and 2023–2026
(77/77/62/54); CCC `concacaf.champions` goes back to **2010**. And a Liga MX summary pull returned
`boxscore`, full `rosters`, 25 `keyEvents`, 111 `commentary` entries, `leaders`, `odds` and
`standings`, with events carrying `fieldPositionX/Y`, `fieldPosition2X/Y` and `goalPositionX/Y`.

Not a full event stream — no passes, no defensive actions, no xG — but **materially richer than
every other free Liga MX source, and the only free source with coordinates for Mexico at all.**

**Consequence for the product:** our Liga MX historical depth begins the day we started ingesting,
and that is not fixable on this budget. Plan the product around it — an "MLS since 2013 / Liga MX
since 2026" framing — rather than waiting for a source that does not exist.

---

## 5. Historical backfill options, ranked

Separate from live APIs. Ranked by value for gap #1.

**Tier 1 — ingest now, zero legal review:**

1. **openfootball/world `.txt`** (CC0, no attribution) — Liga MX 2010/11–2024/25, MLS 2005–2025,
   **CCC 2010/11–2025**. The only cleanly-licensed CCC source found anywhere.
2. **Wyscout figshare** (CC BY 4.0, 77 MB) — the only commercially-clean, coordinate-bearing event
   data in existence. Big five 2017/18. **Store the citation string in the schema** so attribution
   survives into whatever we render.
3. **Wikidata SPARQL** (CC0) — clubs, stadiums, players, squad history with dates, season winners.
   Good Mexican club coverage. Send a real User-Agent.
**Tier 2 — high value, needs permission or private use:**

4. **ASA API for MLS** — shot-level xG with coordinates back to 2013, plus g+ and salaries. Email
   ASA for written terms before it ships publicly; **mirror it regardless**, because its Opta
   lineage makes it exactly as revocable as FBref proved to be.
5. **Football-Data.co.uk MEX/USA** — the only *fresh* free Liga MX/MLS results, covering the
   2025/26–2026/27 window openfootball is missing. Private reconciliation only; never republish the
   odds columns.
6. **RSSSF** (Liga MX 1902→2026, attribution mandatory) — the only path to pre-2001 Liga MX, with
   goalscorers. Costs a latin-1 `<pre>` parser and a crawl of `mexhist.html`. **This is the
   differentiator nobody else has built.**
7. **DFL/IDSSE as a calibration set** — CC BY 4.0, 7 matches of 25 Hz tracking integrated with
   official event data. Validate our event schema against a gold standard. *(StatsBomb open data
   would serve the same purpose but is **private prototyping only** under its licence — see §3.6.)*

**Do not use for backfill:** StatsBomb open data in production (§3.6), **transfermarkt-datasets**
(§3.11 — fails on coverage, freshness *and* law), FBref (ToS §5(i) targets exactly this product),
Understat (`Disallow: /`), Kaggle European Soccer Database (author forbids commercial use),
`secareanualin/football-events` (licence unknown), `scottiemeadows` (synthetic), SoccerStatsUS
(no licence), Metrica (no licence), DBpedia (dominated by Wikidata), the MLS official API (dead).

---

## 6. Legal / ToS risk assessment

**Hosts that refused a plain automated fetch on 2026-08-17** (403/blocked): `fbref.com`,
`sports-reference.com`, `sofascore.com`, `whoscored.com`, `transfermarkt.com`, `api-football.com`,
`api-sports.io`, `footystats.org`. For the scrape-target sites in that list, the block *is* the
position.

| Source | Commercial | Redistribute | Store in our DB | Attribution | Risk |
|---|---|---|---|---|---|
| **ESPN (current)** | ⛔ **prohibited** | ⛔ | ⛔ **prohibited** | — | 🔴 **High — see below** |
| **Sportmonks** | ✅ explicit | ✅ | ✅ **explicit** | none (logos are ours to clear) | 🟢 Low |
| **Highlightly** | ✅ explicit | ✅ | ✅ explicit | none | 🟢 Low |
| **TheSportsDB** | ✅ on paid | ✅ (no reselling the API) | ✅ (*"you can scrape, copy and modify"*) | **required** | 🟢 Low |
| **API-Football** | ⚠️ **"we do not provide a license"** | not licensed | not addressed | none | 🟡 Medium |
| **football-data.org** | ✅ on paid | ✅ | ⚠️ **must stop after cancellation** | **required** | 🟡 Medium |
| **openfootball / Wikidata / footballcsv** | ✅ CC0 | ✅ | ✅ | none | 🟢 **None** |
| **transfermarkt-datasets** | ⛔ CC0 badge conveys nothing | ⛔ | ⛔ | none | 🔴 High — *nemo dat quod non habet* |
| **Fantasy Premier League API** | ⛔ *"including for commercial purposes"* | ⛔ | ⛔ **"creating a database"** named | — | 🔴 High |
| **Biwenger** (free Liga MX injuries) | ⚠️ **terms unreadable**; two-hop chain (AS/PRISA → SofaScore) | ⚠️ | ⚠️ | — | 🟡 Medium — prototype only |
| **RotoWire** | ✅ docs assume persistence | ✅ | ✅ *"persist this tracking in a database"* | — | 🟢 Low (but STATS LLC sub-licence caveat) |
| **Wyscout figshare / DFL** | ✅ CC BY 4.0 | ✅ | ✅ | **mandatory** | 🟢 Low |
| **RSSSF** | ⚠️ not addressed | ⚠️ | ✅ | **mandatory** | 🟡 Medium |
| **Wikipedia** | ✅ | ⚠️ **ShareAlike** | ⚠️ | **mandatory** | 🟡 Medium (viral licence) |
| **ASA** | ⚠️ **no terms published** | ⚠️ | ⚠️ | none stated | 🟡 Medium — *ask first* |
| **Football-Data.co.uk** | ⚠️ *"match prediction only"* | ⛔ | ⚠️ | — | 🟡 Medium |
| **StatsBomb open data** | ⛔ **banned (1.2.2)** | ⛔ **banned (1.2.1)** | ⚠️ | **logo mandatory** | 🔴 High |
| **FBref / Sports-Reference** | ⛔ ToS 5(i) + 5(j) | ⛔ | ⛔ | — | 🔴 High — enforced blocking |
| **Understat** | ⛔ `Disallow: /` | ⛔ | ⛔ | — | 🔴 High |
| **Transfermarkt** direct | ⛔ | ⛔ | ⛔ | — | 🔴 High |
| **FotMob** | ⛔ **expressly prohibited** | ⛔ | ⛔ | — | 🔴 High |
| **Sofascore / WhoScored** | ⛔ | ⛔ | ⛔ | — | 🔴 High (WhoScored also carries Stats Perform rights) |
| **SoccerDataAPI / SoccersAPI** | ⛔ ToS bans commercial + public display | ⛔ | ⛔ | — | 🔴 High |
| **Metrica / SoccerStatsUS / SoccerNet** | ⛔ no licence / NDA | ⛔ | ⛔ | — | 🔴 High |
| **mlssoccer.com** (incl. Deltatre `dapi`) | ⛔ ToS §5.2(vi) *"for any commercial purpose"* | ⛔ | ⛔ | — | 🔴 High |
| **ligamx.net** | ⛔ **`User-agent: * / Disallow: /`** | ⛔ | ⛔ | — | 🔴 High |
| **concacaf.com** (incl. `dapi`) | ⛔ **bans compiling a database** | ⛔ | ⛔ | — | 🔴 High |
| **FIFA Training Centre** (WC2026 physical PDFs) | ⛔ non-commercial only | ⚠️ link only | ⛔ | mandatory | 🔴 High |
| **Sportradar / Wyscout trial keys** | ⛔ trial = *"non-commercial… internal testing"* | ⛔ | ⛔ | — | 🔴 High |
| **TheStatsAPI** | ✅ *"Absolutely"* | ✅ display OK | ⚠️ **"no caching beyond operational need"** | — | 🟡 Medium |

**FotMob**, verbatim (<https://www.fotmob.com/tos.txt>):
> *"The use of automatic services (robots, spiders, indexing, etc.), as well as other methods for
> systematic, regular, or bulk retrieval of data, is expressly forbidden."*
> *"Use of the data, content, or any information displayed on FotMob for any purpose, including but
> not limited to scraping, reproduction, redistribution, or commercial purposes, without the express
> written consent of FotMob is strictly prohibited."*

**Transfermarkt**, verbatim from their Terms of Use §11.1 (retrieved today via
<https://www.transfermarkt.us/intern/anb>; the `.com` host refuses automated fetches entirely):

> *"The User is not permitted to access or copy the Digital Content using bots, spiders, screen
> scraping or other automated processes."*

and, in the same section:

> *"the user is also prohibited from using the digital content for the training or development of
> artificial intelligence (AI), including language models, machine learning, neural networks or
> other AI systems."*

§3.2 asserts exclusive rights over their programs, **databases**, software and trademarks. The only
carve-out is *"Uses for text and data mining (Section 44b UrhG) are expressly reserved"* — a German
research exception that does not cover a commercial public website. **This is as explicit a
prohibition as exists in this document, and it applies transitively to the CC0-labelled scraper
mirrors.**

**Sofascore** — their terms-of-use page returns HTTP 403 to automated requests, so the text could
not be retrieved. Their `robots.txt` **is** fetchable and is *not* a blanket disallow: it blocks
Bytespider entirely and restricts crawlers from dated content, share images and standings pages
across ~20 locales. So the position is less absolute than FotMob's on paper — but with no readable
ToS and an actively blocked legal page, **there is no basis on which to claim permission.**

The `soccerdata` library documents that **WhoScored** *"implements strong protection against
scraping using Incapsula"* and requires Chrome + Selenium to access at all
(<https://soccerdata.readthedocs.io/en/latest/intro.html>). Needing a headless browser to defeat a
bot-protection vendor is a bright-line signal.

### The uncomfortable finding about our current source

ESPN.com's footer Terms of Use link resolves to **<https://disneytermsofuse.com/english/>**
(verified today). Under *License Grant and Restrictions*:

> **§2.B.x** — you may not *"access, monitor, copy or extract the Disney Products using a robot,
> spider, script, or other automated means, including, for the avoidance of doubt, for the purposes
> of creating or developing any AI Tool, data mining or web scraping or otherwise compiling,
> building, creating or contributing to any collection of data, data set or database"*

> **§2.B.viii** — you may not *"use the Disney Products for any commercial or business-related use
> or build a business utilizing the Disney Products, or engage in any activity to enable third
> parties to engage in any of the foregoing activities"*

That is a near-verbatim description of what our ingester does: automated extraction, into a
database, for a public site. There is no ESPN public API programme to license our way out of it.

This does not require panic — enforcement against small projects is rare, and facts (scores, dates)
are generally not copyrightable in the US even where terms are breached. But it changes the framing
of this whole exercise: **a licensed second provider is not just redundancy insurance against a
schema change, it is the migration path off a source we are not permitted to use.** Sportmonks'
terms — which affirmatively permit storage, distribution and building a commercial product — are
the direct antidote to Disney §2.B.viii and §2.B.x.

### The official league sources — all three forbid it, and Liga MX most clearly

- **Liga MX** — `https://www.ligamx.net/robots.txt` is an **allowlist**: ~50 named search bots each
  granted access, closing with `# disallow all other bots` / `User-agent: *` / `Disallow: /`.
  **This is the least ambiguous machine-readable "no" in this entire study.** No ToS is reachable
  (`/cancha/terminosycondiciones` → 500), and there is no public or undocumented JSON API — the
  site is server-rendered PHP/JSP whose only AJAX endpoints are social-count proxies. (Archaeology:
  the homepage carries a commented-out `/* Se quita Match Analysis` block referencing their former
  stats provider `mxfeed.matchanalysis.com`, which no longer resolves.)
- **MLS** — `robots.txt` is `Allow: /`, but the Terms of Service §5.2 prohibit *"spidering, screen
  scraping, database scraping"* and, at (vi), any automated mechanism used *"to harvest or otherwise
  collect information from the Services **to be used for any commercial purpose**"*. Content is
  defined to include *"statistics, updated scores"*, licensed for *"personal, noncommercial use
  only"* (<https://www.mlssoccer.com/legal/terms-of-service>).
- **Concacaf** — `robots.txt` is `Allow: /`, and the Terms are **the strictest text found anywhere
  in this research** (<https://www.concacaf.com/terms-conditions>, Florida law, AAA arbitration in
  Miami-Dade, class-action waiver, injunctive relief without bond):
  > *"**Systematic retrieval of data or other content from the Services, whether to create or
  > compile, directly or indirectly, a collection, compilation, database or directory, is
  > prohibited** absent our express prior written consent."*
  > *"You shall not use … **automated electronic processes, robots, spiders, scrapers, webcrawlers**
  > … including without limitation **real time scoring, statistics** … **(whether current or
  > archival)**."*
  > *"You shall not use real time scoring, rankings, statistics or other data … **for sale, license
  > or other commercial purposes** … unless expressly licensed by CONCACAF."*

  That "whether to create or compile, directly or indirectly, a … database" clause is a bespoke
  description of what our backend does.

**What *is* technically open (and still covered by those terms):** MLS and Concacaf both run
**Deltatre Forge**, and its content API answers unauthenticated —
`https://dapi.mlssoccer.com/v2/content/en-us/{matches,clubs,players,seasons}`,
`https://dapi.leaguescup.com/v2/content/en-us/matches`, and
`https://dapi.concacaf.com/v2/content/en-us/competitions` all return 200. Match records carry
**both** `optaId`/`homeClubOptaId`/`competitionOptaId` **and** `sportecId`/`homeClubSportecId`,
plus kickoff times, broadcasters and venues — genuinely valuable for **ID reconciliation**. The
Concacaf competitions endpoint returns both **Leagues Cup** and **Champions Cup** and carries a
`bracketStructure` field holding the tournament format as JSON — directly relevant to our
arc-bracket rendering. But there is **no standings, no match stats, no events, no coordinates**, it
is undocumented and unstable, and it is squarely inside the ToS above — Concacaf's in particular
forbids exactly this.

⚠️ **The previous generation of MLS endpoints is dead.** The widely-circulated gist documenting
`sportapi.mlssoccer.com/api/*` and `stats-api.mlssoccer.com/v1/*` was tested today with correct
Origin/Referer headers: **every route returns 404** (`stats-api` answers
`{"message":"Endpoint Not Found"}`). Any tutorial describing them is stale. That is a preview of
what happens to undocumented endpoints generally — including ESPN's.

### The general legal landscape — verified

**United States: the CFAA is a weak weapon in 2026; contract is not.**

- ***hiQ Labs v. LinkedIn*** is routinely quoted at the halfway point. Full arc: 9th Cir. 2019 →
  **vacated by SCOTUS June 2021** in light of *Van Buren* → 9th Cir. reaffirmed April 2022,
  31 F.4th 1180 → and then, in **November 2022, the district court held hiQ had BREACHED
  LinkedIn's User Agreement**, settling in December 2022. The CFAA half is the half people cite;
  **the breach-of-contract half is the half that applies to us.**
- ***Amazon.com Services, LLC v. Perplexity AI, Inc.***, 9th Cir. No. 26-1444, **decided
  2026-08-04** — thirteen days ago, the most current authority
  (<https://cdn.ca9.uscourts.gov/datastore/opinions/2026/08/04/26-1444.pdf>). The panel **vacated**
  Amazon's injunction, holding it was the *user*, not Perplexity's agent, who accessed Amazon's
  computers. But **footnote 5** is the lesson:
  > *"This outcome **does not impair Amazon's ability to regulate access to Amazon.com via private
  > terms of service** for its users. On the facts before us, Amazon is simply unlikely to succeed
  > in its attempt to regulate access by invoking the CFAA and the CDAFA."*

  The trend from hiQ (2022) to Perplexity (2026) narrows the criminal statute and leaves contract
  **fully intact** — and contract is exactly what every source above relies on.

**UK / EU: the sui generis database right, and the football case that decided it.**

- The right: Copyright and Rights in Databases Regulations 1997 (SI 1997/3032), implementing
  Directive 96/9/EC (<https://www.legislation.gov.uk/uksi/1997/3032/made>). Reg. 13(1) protects a
  database with *"substantial investment in obtaining, verifying or presenting the contents"*;
  Reg. 12(1) defines *extraction* as transfer to another medium and *re-utilisation* as making
  available to the public; **Reg. 16(2)**: *"the **repeated and systematic extraction or
  re-utilisation of insubstantial parts** … may amount to … a substantial part."* 15-year term.
- ***Football Dataco Ltd & Ors v Stan James Plc & Ors* [2013] EWCA Civ 27**
  (<https://caselaw.nationalarchives.gov.uk/ewca/civ/2013/27>) — the closest decided case to what
  ScoreArc does. Football DataCo's "Football Live" (goals, scorers, times, cards, subs, collected
  by human observers) was scraped by Sportradar and displayed via a pop-up on a betting site.
  Held:
  - **It is a protected database** — investment *"of the order of £600,000 per annum"* in
    collection "clearly justifies" it (¶69). The Court rejected the argument that *created* data
    falls outside protection.
  - **The Court of Appeal removed even the narrow "goals and times only" safe harbour** the first
    instance judge had allowed (¶106): UK users extract a substantial part; **Stan James and
    Sportradar are joint tortfeasors**; no *abus de droit* or Art. 10 ECHR defence.
  - ¶97: *"The provider of such a website is **causing each and every UK user who accesses his site
    to infringe.** His very purpose in providing the website is to cause or procure acts which will
    amount in law to infringement."*

  **Three consequences: (1) live football data collected at real cost is a protected database in
  the UK/EU — settled, not arguable. (2) The "it's just facts" defence fails — the facts aren't
  protected, the collection is. (3) Serving the data to our users makes *us* the infringer, jointly
  with them. A read-through cache is not a shield; it was the defendant's exact model.** The CJEU
  (Case C-173/11) also held the UK has jurisdiction over a foreign defendant that "targets" the UK
  public — a `.futbol` site serving Europe is targeting.

**2024–2026 developments.** ⚠️ A correction, because search engines are currently getting this
wrong: the widely-resurfaced *"Genius Sports Sues Sportradar"* article is dated **February 2021**,
not 2026 (its embedded schema reads `"datePublished":"2021-02-07"`). The real litigation was UK —
CAT cases **1342/5/7/20** and **1410/5/7/21(T)** — and **it settled on 2022-10-11, seven days into
trial, before a single witness**, so **nothing was decided**. Notably the theories pleaded were
**breach of confidence, ticket-condition breach and unlawful means conspiracy — not database
right.** The 2026 action has moved to antitrust: *Sportradar v Football DataCo* **[2026] CAT 46**
(18 May 2026) let a non-party obtain pleadings for CMA complaints; *Altenar v Sportradar* (D.N.J.,
~March 2026) alleges a Sportradar/Genius **duopoly** under the Sherman Act.

**No 2024–2026 decision was found holding that raw sports scores and facts may be freely scraped
and redistributed.** Practical risk ranking, descending: **(1) contract/ToS, (2) UK/EU database
right per *Stan James*, (3) breach of confidence for live in-venue data, (4) — a distant fourth —
the CFAA.**

**A pattern worth noticing across three separate findings:** Stats Perform terminated FBref's feed
in January 2026; Stats Perform is MLS's exclusive data provider; ASA says *"we get our data from
Opta"*. The rights-holder is actively consolidating and enforcing. Any strategy that depends on a
free intermediary reselling Opta-derived data has a shortening half-life. **Mirror everything we
depend on.**

---

## 7. Recommendation — staged plan

### Stage 0 — this week, free

**(a) Backfill MLS shot-level history from ASA.** ~7,000 keyless GETs:
`/api/v1/mls/games?season_name=YYYY` for 2013–2026, then `/api/v1/mls/games/shots?game_id=…` per
match. Land it in our event schema — ASA's coordinate space is 0–100 with x=100 at goal, so it needs
a mapping layer to our ESPN `fieldPositionX/Y` convention. Pull the aggregate endpoints (xG, xPass,
goals-added, salaries) in the same pass.

**(b) Ingest the CC0/CC-BY tier**: openfootball (Liga MX + MLS + **CCC**), Wyscout figshare (event
geometry, with a mandatory citation stored alongside), Wikidata (entities). **Not**
transfermarkt-datasets — see §3.11.

**(c) Send one email to ASA** asking for written permission for commercial use and what their
upstream licence permits. The backfill can be built while waiting; it should not ship without an
answer. **Mirror the data regardless.**

**Cost: €0.** This closes more of gap #1 than everything else combined.

### Stage 1 — this month, ~€45/month

**Subscribe to Sportmonks Starter (€29) + 4 extra leagues (€4 each).** Start with the 14-day trial
and verify four things before paying:

1. **The €4/league price** — their pricing page and glossary contradict each other. Fallback is
   Growth at €99/mo.
2. **`sidelined` against Liga MX `#743` and MLS `#779`.** Injury coverage appears nowhere in their
   73 MB coverage matrix, so this is undeclared and must be proven empirically. It is the single
   highest-value unknown in the whole plan.
3. **That their data disagrees with ESPN where we already know ESPN is wrong** (own-goal
   misattribution, alphabetical ordering of unplayed tables). If it agrees with ESPN's errors, it is
   the same upstream and worthless as a second opinion.
4. **How thin Leagues Cup `#3211` and CCC `#1111` really are in practice** — the matrix says no
   lineups and no player stats for either. Confirm what you actually get.

Wire it behind the existing `DataStore` seam as a second provider, querying `my/leagues` and
`my/data-features` rather than hardcoding IDs. Add the **€29 one-time Historical add-on** if the
3-season base window proves too shallow.

**Why Sportmonks over API-Football**, despite API-Football being $19 with better coverage
granularity: API-Football states in writing that it grants no publication licence and pushes rights
clearance onto us. If the point of buying a second provider is to *reduce* legal exposure, that
undoes the purpose. Sportmonks explicitly permits storage, distribution and commercial use. The
€26/month delta buys a licence.

### Stage 2 — defer, revisit in 3–6 months

- **Injuries** should be covered by Sportmonks' `sidelined` include at no extra cost — a Stage 1
  feature, not a Stage 2 purchase, *if the trial proves it for Liga MX and MLS*. If it doesn't:
  **RotoWire** is the only vendor verified to ship both `Soccer/MLS/Injuries.php` and
  `Soccer/LIGAMX/Injuries.php` with typed body part, status, detail, side and return date
  (`shannon@rotowire.com`; ask about the STATS LLC sub-licensing constraint). Cheaper fallbacks:
  API-Football at $19/mo or Highlightly at $9.49/mo, neither confirmed on Leagues Cup or CCC.
- **Market values are not permanently out of reach.** Sportmonks verifiably has none, and
  Transfermarkt's only licensing door is **SCOUTASTIC** (club-facing, pricing unpublished). But
  **SciSports licensed its ETV valuations to FotMob for consumer display in February 2026** — proof
  the use case is licensable. **CIES** is the cheaper alternative and explicitly covers MEX, USA and
  CAN. Ask both before assuming the gap is permanent.
- **RSSSF parser** for Liga MX 1902–2001. A weekend of work for history literally nobody else has.
- **Predicted lineups** — Sportmonks' add-on is €199/mo on top of a €99 Growth plan, ~€300/mo
  all-in. Not worth it at our stage.
- **Calibrate our xG model** against ASA's xG and the Wyscout/DFL sets once the shot data lands.

### Stage 3 — probably never

Enterprise event and tracking data (Stats Perform/Opta, Sportradar, Hudl StatsBomb, Wyscout, PFF,
Second Spectrum). Sales-gated, realistically $500+/month on annual commitments. MLS's own tracking
data belongs to Genius Sports. Revisit only with revenue that absorbs a five-figure annual contract.

### Avoid entirely — ranked by how well the risk is disguised

1. **FotMob's keyless API.** The easiest route to Liga MX + MLS shot coordinates, xG, xGOT,
   heatmaps and momentum in existence — and the most explicitly prohibited source in this study,
   with `Disallow: /api/*` naming our exact access path and an upstream Opta contract we would be
   interfering with. **The convenience is the hazard.**
2. **The CC0 tag on Kaggle's Transfermarkt dataset.** *Nemo dat quod non habet* — the uploader
   cannot grant CC0 over data obtained against §11.1 and an express §44b TDM reservation.
   Downloading it does not launder the provenance.
3. **StatsBomb open data in production.** Clause 1.2.2 is an express non-commercial bar reaching
   *derived analysis*. The friendly README is not the licence.
4. **Anything scraped from ligamx.net.** `User-agent: * / Disallow: /` is the least ambiguous "no"
   in this entire report.
5. **The Fantasy Premier League API.** Free, keyless, excellent injury data — and the Premier
   League's terms prohibit commercial use, database creation and deep-linking **by name**, backed by
   a UK database right that doesn't require us to have agreed to anything.
6. **Trial API keys in production.** Sportradar's §3.1 forbids commercial use *and* public display
   — two breaches, not one.
7. **Sportradar at all, unless the history question is settled first.** §7.4 requires destruction of
   all accumulated data, *"including without limitation all historical data,"* within 30 days of
   termination. That is structurally incompatible with "own the data → history."
8. Plus the obvious: FBref/Sports-Reference, Transfermarkt direct, Sofascore, WhoScored, Understat,
   SoccerDataAPI, SoccersAPI, and the Deltatre `dapi` endpoints for anything beyond private ID
   reconciliation.

### Architecture implications

1. **Never call a paid football API from Vercel functions.** API-Football explicitly warns that
   shared serverless outbound IPs trigger their per-IP rate limiting and recommends a dedicated
   static IP. All provider traffic belongs in the Fly.io ingester.
2. **Mirror everything we depend on, immediately.** FBref lost its feed overnight; ASA runs on the
   same upstream. Our R2 bucket is the durability layer.
3. **Attribution must be a schema field, not a footer.** Wyscout (CC BY 4.0) and RSSSF require
   attribution; TheSportsDB and football-data.org require it too. Carry a `source` +
   `attribution_text` per row so credit survives into every rendered surface.
4. **Consider adopting SPADL as the internal event schema** if we ingest from more than two
   providers — socceraction is MIT and already maps StatsBomb/Wyscout/Opta shapes, though it is no
   longer actively developed.
5. **Store provider IDs, not names.** Sportmonks' own docs warn against hardcoding league lists;
   API-Football still calls the CCC "CONCACAF Champions League". The Deltatre `dapi` endpoints are
   genuinely useful here — they expose Opta IDs and Sportec IDs side by side on the same match
   record, which is the Rosetta stone for reconciling providers. Use them for **private ID mapping
   only**, and expect them to disappear: the previous generation of MLS endpoints already 404s.
6. **A read-through cache is not a legal shield.** *Football Dataco v Stan James* held the website
   operator jointly liable with its own users for extraction they trigger. If the architecture is
   ever questioned, "we only proxy" is not a defence — it was the defendant's exact model.
7. **Anything we license, we may not be able to keep — check this clause first, every time.** Opta's
   Dec 2025 MLA forbids bulk download and archival file building; **Sportradar §7.4 requires
   destroying all historical data within 30 days of termination**; football-data.org bars
   referencing data after cancellation; TheStatsAPI forbids caching *"beyond what is reasonably
   necessary to operate your application"*. **Sportmonks is the only vendor found whose terms
   affirmatively permit storage** — which is precisely why it is the recommendation, and why its
   *"data is exclusively available per domain"* clause is worth reading before adding a second
   surface.

### Rough cost summary

| Stage | What | Monthly |
|---|---|---|
| 0 | ASA backfill + CC0/CC-BY datasets | **€0** |
| 1 | Sportmonks Starter + 4 extra leagues | **~€45** (+€29 one-time for history) |
| 2 (optional) | API-Football Pro or Highlightly for injuries | +$19 / +$9.49 |
| 2 (optional) | Sportmonks xG add-on (big five + UEFA only) | +€29 (€24 annual) |
| 2 (deferred) | Predicted lineups (Growth €99 + €199 add-on) | +€298 (€238 annual) |
| 3 | Enterprise event/tracking | $500+ (not recommended) |

**Recommended spend: €0 now, ~€45/month from next month, ~€55–65/month if injuries need a second
vendor.**

---

## 8. Open items — verify before acting

1. **ASA licensing** — no published terms. Email them. Blocking for Stage 0 shipping.
2. **Sportmonks €4/league** — their own pages contradict each other. Blocking for the €45 figure.
3. **Sportmonks `sidelined` coverage for Liga MX `#743` and MLS `#779`** — the endpoint exists on all
   plans, but injuries appear nowhere in the 73 MB coverage matrix, so per-league population is
   undeclared. **Test this in the trial; it is the highest-value unknown in the plan.**
   *(Resolved separately: the per-league feature matrix itself — see the table in §3.2.)*
4. **API-Football generally — needs a human with a real browser.** Their entire estate
   (api-football.com, api-sports.io, the dashboard) sits behind a Cloudflare managed challenge.
   Two independent research passes were run: one succeeded by rendering the pages in a local browser
   engine (that is the source of the 9/9 coverage matrix in §3.3), the other was blocked at every
   method and could verify nothing. **A negative result worth recording: you cannot fingerprint
   their endpoints by probing the live host** — `/injuries`, `/sidelined`, `/transfers` and a
   deliberately bogus path all return byte-identical "Missing application key" errors. Anyone
   claiming to have confirmed endpoints that way is reporting an artifact. Per-competition season
   depth is commented out of the coverage HTML and remains unknown.
5. **Highlightly Leagues Cup / CCC coverage** — free key, one `/leagues` call settles it. Worth five
   minutes given their terms are the best in the survey at $9.49/mo.
6. **Kaggle `excel4soccer/espn-soccer-data`** — whether Liga MX / MLS / Leagues Cup / CCC are in the
   claimed 400+ leagues. Needs a logged-in check. If they are, it is a ready-made ESPN historical
   archive — though its "MIT" tag grants nothing against ESPN.
7. **FBref Liga MX earliest season and CCC comp-133 depth** — Cloudflare-gated. Moot given §3.8.
8. **Whether SCOUTASTIC licenses to consumer media products** rather than only clubs and agencies —
   `info@scoutastic.com`. This is the only legitimate door to Transfermarkt data.
9. **Sportradar's Liga MX coverage records conflict with each other** — `sr:competition:27464`
    reports `Extended Statistics 0` while a second record `sr:competition:27466` ("Liga MX,
    Clausura") reports all-2s. Treat Liga MX depth as partial and season-dependent.
10. **WhoScored's ToS wording** is high-confidence but **search-index sourced** — the page returns
    403, the Internet Archive was offline during this research, and reader proxies were IP-blocked.
11. **Sofascore's own ToS wording** — unreadable (403 on every host). The quoted clauses are from
    **Torneo by Sofascore**, the same legal entity (Sofa IT d.o.o., Zagreb), so parallel drafting is
    near-certain but not verified.
12. **Whether Genius's Liga MX exclusivity forecloses non-betting media data** — as written it
    covers in-stadia capture and distribution to licensed sportsbooks. Opta clearly still collects
    Liga MX independently. Worth a direct question to both if we ever go enterprise.
