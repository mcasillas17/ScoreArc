# Player identity capture — design

- **Date:** 2026-08-12
- **Component:** `backend/shared/espn/`, `backend/shared/store/`, `backend/ingester/`, `backend/migrations/`
- **Depends on:** `feat/canonical-identity-impl` (this branch is stacked on it)
- **Follows:** `docs/superpowers/specs/2026-08-12-canonical-identity-design.md` §9 "Follow-on"

## 1. The problem

ScoreArc has no concept of a player.

Canonical identity gave us a `player` table, a `player_external_ref` crosswalk and a
correct `Store.Player()` resolver that mints UUIDv7 ids and adopts the incumbent on a
race. **It has zero non-test callers.** The spine is built and entirely dead, because
nothing in the ingest path ever supplies a provider player id.

Three separate places discard the data that would feed it:

1. **The provider structs don't declare the field.** `rawAthlete`
   (`backend/shared/espn/summary.go:164`) declares only `DisplayName` and
   `JerseyImages`; `rawAthleteName` (`:200`) declares only `DisplayName`. ESPN sends
   `athlete.id` on both roster entries and key-event participants. `encoding/json`
   silently drops undeclared fields, so the id is gone before any mapper runs — with no
   error, no log line, and nothing in a test that would notice.

2. **The model carries names, not identities.** `LineupPlayer` (`shared/model/types.go:202`)
   is `{Name, Number, Position, Jersey}`. `Scorer` (`:129`) and `Card` (`:138`) carry
   `Player string` — a display name. So a goal is attributed to the *string*
   `"Rodrygo"`, not to a person.

3. **The storage is a JSON blob.** Lineups, scorers and cards are jsonb columns on
   `match_detail` (`migrations/0001_init.up.sql:132`). Nothing is queryable across
   matches. "How many goals has this player scored this season" is not a slow query, it
   is an impossible one.

There is a fourth, quieter loss: the lineup mapper keeps starters only
(`summary.go:~978`, `if !p.Starter { continue }`). Every substitute is thrown away, so
even the names we do keep are two thirds of a team sheet.

The consequence is that two players who share a display name are the same player to us,
and one player appearing in Liga MX and the World Cup is two unrelated strings. Player
valuation — the stated goal — is not blocked on modelling effort. It is blocked on the
fact that we do not know who anyone is.

## 2. Goal

Make every player ScoreArc observes a **canonical person** with a stable id, and record
what they did in a match in **relational, queryable form** — while changing nothing the
reader currently serves.

Non-goals, explicitly: no valuation model, no xG, no second data source, no historical
backfill, no reader endpoints. This slice makes those possible. It does not start them.

## 3. Design

### 3.1 Capture the id (provider layer)

Add `ID flexibleString \`json:"id"\`` to `rawAthlete` and `rawAthleteName`.
`flexibleString` (`backend/shared/espn/matches.go:111`) is the existing helper for ESPN's
habit of sending ids as either string or number; the same type already backs
`rawStandingTeam.ID` (`standings.go:52`) and `rawSummaryTeam.ID` (`summary.go:45`).

This is the whole fix for loss #1. It is two lines and it is the reason the other three
losses are fixable at all.

### 3.2 Carry it through the model

Add `SourceID string` to `LineupPlayer`, `Scorer` and `Card`.

The mappers stay in **provider shape** — they emit ESPN's id, not a canonical one. The
provider layer must not know about canonical identity; that is the seam the whole
canonical-identity design rests on, and resolution belongs to the ingester where the
`Store` lives. This mirrors how `MatchRef`/`TeamRef` already work.

`SourceID` is `""` when ESPN omits it. That is a normal, expected state, not an error
(see §5.1).

Also stop discarding substitutes: the lineup mapper (`summary.go:975`, `if !p.Starter`)
keeps every roster entry and records `Starter bool` per player. The existing
`MatchLineups` jsonb blob continues to serialize **starters only**, so the reader's
payload is byte-identical; the full roster is used for appearances and never leaves the
ingester.

### 3.3 Store it relationally (new migration `0003_player_capture`)

Two additive tables. Nothing existing is altered.

```sql
CREATE TABLE appearance (
  match_id     uuid NOT NULL REFERENCES match(id)  ON DELETE CASCADE,
  player_id    uuid NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  team_id      text NOT NULL REFERENCES team(id),
  starter      bool NOT NULL,
  shirt_number int,
  position     text,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE match_event (
  match_id  uuid NOT NULL REFERENCES match(id)  ON DELETE CASCADE,
  seq       int  NOT NULL,               -- ordinal within the match, mapper order
  player_id uuid          REFERENCES player(id) ON DELETE SET NULL,
  team_id   text NOT NULL REFERENCES team(id),
  type      text NOT NULL,               -- goal | own_goal | penalty | yellow | red
  minute    text NOT NULL,
  shootout  bool NOT NULL DEFAULT false,
  PRIMARY KEY (match_id, seq)
);
```

Two deliberate choices:

- **`match_event.player_id` is nullable.** An event ESPN reports without an athlete id
  still happened, and dropping it would silently understate a scoreline. We record the
  event and leave the person unknown. `appearance.player_id` is *not* nullable — an
  appearance with no player is meaningless.
- **The key is `(match_id, seq)`, not a surrogate uuid.** Events have no stable provider
  id, so a surrogate key would make re-ingestion produce duplicates. See §3.4.

### 3.4 Idempotent re-ingestion — the part that will bite

A match summary is re-fetched repeatedly while the match is live. Every refetch re-reads
the same goals. Naive inserts would multiply them.

`(match_id, seq)` makes re-ingestion an upsert against a deterministic key: the *n*th
event in the mapper's output is always row *n*. Combined with a scoped
`DELETE FROM match_event WHERE match_id = $1 AND seq > $2` for the tail, a match that
loses an event (ESPN corrects a mis-attributed goal) shrinks correctly instead of
retaining a phantom.

**This requires `GRANT DELETE ON appearance, match_event TO scorearc_ingester`.**

That grant is called out here because its absence is exactly the defect that shipped
undetected in the canonical-identity branch: `promoteProvisionalTeam` ended in a `DELETE`
the ingester role could not perform, the `42501` was swallowed into a warning that
returned `nil`, and the migrations test asserted the insufficient grant — locking the bug
in. The test for this slice must exercise the delete path **as `scorearc_ingester`**, not
as the container superuser, or it proves nothing.

### 3.5 Resolution in the ingester

Inside the existing finalize/detail write path, per match, in one transaction:

1. For each roster entry with a non-empty `SourceID`, call `Store.Player()` to get a
   canonical id, then upsert an `appearance`.
2. For each scorer/card, resolve the same way; write a `match_event` with the resolved id
   or `NULL`.

`Store.Player()` already handles the concurrent-writer race correctly (mint, then adopt
whoever won the crosswalk upsert). No new concurrency design is needed — that is the
payoff for having built the spine first.

## 4. What does not change

- No reader code, no endpoint, no `openapi.yaml`, no response shape.
- No frontend.
- `match_detail`'s jsonb columns keep their exact current contents (§3.2).
- Migrations `0001`/`0002` are untouched; this adds `0003`.

The slice is therefore mergeable independently of the deploy, board and cutover
workstreams, and invisible to production until something queries the new tables.

## 5. Risks

### 5.1 ESPN omits the athlete id

Observed present on lineups and key events in sampled payloads, but not guaranteed
across all nine competitions, and near-certainly absent for some historic seasons.

**Degrade, don't block** — the same philosophy as provisional teams. A missing id means:
no appearance row for that player, and a `match_event` with `player_id IS NULL`. The
match still ingests. We must **not** fall back to minting a player keyed by display name:
that manufactures exactly the name-collision identity we are removing, and it would do so
invisibly.

Coverage must be *reported*, not assumed, or a competition where capture silently fails
looks identical to a competition with no goals. `ingest_run` has no counters column
(`migrations/0001_init.up.sql:186` — `id, competition_id, kind, started_at, finished_at,
ok, error`), so reporting follows the pattern `reportProvisionalTeam` already established
(`shared/store/identity.go:186`): a `LogIngestRun` row under a distinct `kind`, carrying
the counts in its message. One row **per match**, summarising resolved-vs-unresolved —
not one per miss, which would bury the signal it exists to raise.

### 5.2 Cross-source identity is not solved here

ESPN's athlete id gives us *ESPN's* notion of a person. A second source will have its own,
and joining them is a genuinely hard entity-resolution problem (names, accents,
transliteration, birth dates). The crosswalk's shape supports it; this slice does not
attempt it. Nothing here should assume one source.

### 5.3 Squad churn

`appearance` is per match, so a transfer needs no special handling — the player's team is
recorded per appearance rather than as a property of the player. This is deliberate and is
why `player` has no `team_id`.

## 6. Testing

- Mapper tests against recorded fixtures asserting the athlete id survives, plus one
  asserting a payload with no `athlete.id` yields `SourceID == ""` rather than an error.
- A resolver test that the same ESPN athlete id across two matches resolves to one
  canonical player.
- An idempotence test: ingest the same summary twice, assert event and appearance counts
  are unchanged and ids are stable.
- A shrink test: ingest a summary, re-ingest with one fewer event, assert the tail is gone.
- **A role-scoped test** running the delete path as `scorearc_ingester` (§3.4).
- A degradation test: a summary whose events carry no athlete ids still ingests, writes
  events with `player_id IS NULL`, and reports the miss.
