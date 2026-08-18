package main

import (
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const (
	fastInterval   = 20 * time.Second
	slowInterval   = 5 * time.Minute
	topScorerLimit = 30

	// scheduledDetailFarTTL and scheduledDetailMidTTL bound how often a
	// SCHEDULED match's stored detail (lineups, form, h2h, pre-match win
	// probability) is worth re-fetching, based on how long until kickoff.
	// The final band (<= 1h to kickoff) keeps slowInterval unchanged -- see
	// scheduledDetailTTL below for why.
	//
	// Before this: every scheduled fixture in the rolling -30d/+7d scoreboard
	// window was re-fetched and rewritten on EVERY slow tick, forever -- 82
	// candidates x 288 slow ticks/day = 23,616 match_detail rewrites and
	// 23,616 ESPN summary requests/day, of which a content-hash audit across
	// a 426-second window found ZERO changed
	// (docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md
	// §3.2).
	//
	// scheduledDetailMidTTL rests on docs/research/2026-08-18-espn-payload-volatility.md
	// §2.3: the one pre-kickoff window actually sampled (~11h before
	// kickoff) showed zero movement in the exact fields mapWinProbability
	// reads, over a 9-minute gap. scheduledDetailFarTTL has no measurement
	// this far out to point to -- it is a judgment call, stated as one, not a
	// finding: comfortably looser than the measured-quiet band, comfortably
	// tighter than "once a season". Neither band is a claim that the market
	// is provably frozen at these horizons, only that rewriting unconditionally
	// every 5 minutes, all season, was known-wasteful and this is a
	// defensible replacement.
	scheduledDetailFarTTL = 6 * time.Hour
	scheduledDetailMidTTL = time.Hour
)

func nextInterval(anyLive bool) time.Duration {
	if anyLive {
		return fastInterval
	}
	return slowInterval
}

// scheduledDetailTTL returns how stale a SCHEDULED match's stored detail is
// allowed to get before it is worth re-fetching, given how long until
// kickoff. It tightens as kickoff approaches.
//
// The final band (<= 1h to kickoff, including a kickoff that has already
// passed while still reported scheduled) is left at slowInterval --
// deliberately unchanged from today's cadence. This is NOT because the
// evidence says the market is quiet there; the volatility audit's own
// caveats say the opposite is unmeasured ("No live match was observed...the
// nearest tracked-competition kickoffs at audit time were 11-19 hours away",
// §6). Lineups get announced and markets are most likely to actually move in
// this window. Absent evidence either way, this band keeps the one cadence
// that has already run in production without incident, rather than
// tightening OR loosening on a guess.
func scheduledDetailTTL(timeToKickoff time.Duration) time.Duration {
	switch {
	case timeToKickoff > 24*time.Hour:
		return scheduledDetailFarTTL
	case timeToKickoff > time.Hour:
		return scheduledDetailMidTTL
	default:
		return slowInterval
	}
}

// needsSummary decides whether match's summary is worth fetching this cycle.
// now is passed in and never read internally (no time.Now() in this function),
// so the TTL boundaries above are testable without a wall clock. slowTick
// preserves the existing every-slow-tick behavior inside the final hour,
// where an age check equal to slowInterval would otherwise skip the next tick
// because match_detail.updated_at is stamped after the provider fetch.
func needsSummary(
	match model.Match,
	existing *store.MatchRow,
	now time.Time,
	slowTick bool,
) bool {
	if existing != nil && existing.FinalizedAt.Valid {
		return false
	}
	switch match.State {
	case model.MatchStateLive, model.MatchStateFinished:
		// A live match is refetched on every cycle it is processed in,
		// unconditionally -- the scheduled->live transition therefore always
		// refreshes immediately, by construction, not via a special case
		// bolted onto the TTL below.
		return true
	case model.MatchStateScheduled:
		if existing == nil || !existing.HasDetail || !existing.DetailUpdatedAt.Valid {
			return true
		}
		kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
		if err != nil {
			// resolveMatch already required match.Kickoff to parse before
			// this match could reach processMatches at all -- this branch
			// should be unreachable in practice. Fail OPEN (refetch) rather
			// than silently freezing a fixture's detail forever on a
			// defensive path that is never expected to run.
			return true
		}
		// Recomputed fresh from THIS call's (kickoff, now) every time --
		// never cached against a previously-assigned band. A fixture that
		// gets rescheduled is picked up on the very next check because
		// there is nothing stale to leave behind.
		ttl := scheduledDetailTTL(kickoff.Sub(now))
		if ttl == slowInterval {
			return slowTick
		}
		return now.Sub(existing.DetailUpdatedAt.Time) >= ttl
	default:
		return false
	}
}

// matchRowUnchanged reports whether UpsertMatch would write anything different
// from what is already stored, so the caller can skip the statement -- the C2
// guard from
// docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md
// §4.2. It MUST be called with `match` in its FINAL form: after processMatches'
// own preservation rules (round/bracket/winner/team carry-forward) have already
// run, because those rules are what decide the value a preserved round or
// winner actually carries.
//
// Every comparison mirrors matchUpsertSQL column for column, using
// IS DISTINCT FROM semantics -- nil==nil is unchanged, nil vs a value is a
// real difference -- EXCEPT the columns matchUpsertSQL itself writes with a
// COALESCE or a CASE that can reference the stored row (home_score, away_score,
// round, the two placeholders). Those get their own helper below so a nil
// incoming value SQL would coalesce away is never treated as a difference, and
// so a value SQL would compute differently from the raw payload (a cleared
// round, a cleared winner, an un-stuck placeholder) still counts as a real one.
// `source` is deliberately not compared: every write in this process carries
// the same sourceESPN constant, so it can never produce a false "unchanged".
func matchRowUnchanged(identity store.MatchIdentity, match model.Match, current store.MatchRow) bool {
	kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
	if err != nil {
		// resolveMatch already rejects an unparseable kickoff before this
		// point on every real call path. If one ever reaches here anyway,
		// treat it as a change rather than silently skip a write this
		// function cannot reason about.
		return false
	}
	return kickoff.Equal(current.Kickoff) &&
		match.State == current.State &&
		identity.HomeTeamID == current.Home.ID &&
		identity.AwayTeamID == current.Away.ID &&
		coalesceIntUnchanged(match.HomeScore, current.HomeScore) &&
		coalesceIntUnchanged(match.AwayScore, current.AwayScore) &&
		strPtrEqual(match.Minute, current.Minute) &&
		match.StatusDetail == current.StatusDetail &&
		match.StatusName == current.StatusName &&
		strPtrEqual(identity.WinnerTeamID, current.WinnerID) &&
		strPtrEqual(match.Note, current.Note) &&
		finalRound(match, current) == current.Round &&
		boolPtrEqual(match.BracketRequired, current.BracketRequired) &&
		finalPlaceholder(match.BracketConfirmed, identity.HomeTeamID, current.Home.ID,
			current.HomePlaceholder, match.HomePlaceholder) == current.HomePlaceholder &&
		finalPlaceholder(match.BracketConfirmed, identity.AwayTeamID, current.Away.ID,
			current.AwayPlaceholder, match.AwayPlaceholder) == current.AwayPlaceholder
}

// finalRound mirrors matchUpsertSQL's round CASE. Once a bracket match is
// confirmed with BracketRequired explicitly false, round is cleared to NULL
// regardless of what the payload carries -- a bye or a dead rubber leaving the
// bracket. Otherwise an empty incoming round falls back to whatever is already
// stored, matching SQL's empty-string-to-NULL fallback before COALESCE.
func finalRound(match model.Match, current store.MatchRow) string {
	if match.BracketConfirmed && match.BracketRequired != nil && !*match.BracketRequired {
		return ""
	}
	if match.Round == "" {
		return current.Round
	}
	return match.Round
}

// finalPlaceholder mirrors matchUpsertSQL's placeholder CASE. While a bracket
// match's confirmation is still pending, a placeholder flag that is already
// true and still points at the same team is sticky: the scoreboard has no way
// to prove an unresolved leg has resolved, so its silence is not evidence.
// Once the match is bracket-confirmed, the incoming flag is authoritative.
func finalPlaceholder(bracketConfirmed bool, incomingTeamID, storedTeamID string,
	storedPlaceholder, incomingPlaceholder bool) bool {
	if !bracketConfirmed && incomingTeamID == storedTeamID && storedPlaceholder {
		return true
	}
	return incomingPlaceholder
}

// coalesceIntUnchanged mirrors `COALESCE($n, match.col)`: a nil incoming score
// can never change the stored one, so it is never a difference for this guard
// even when the stored value is non-nil.
func coalesceIntUnchanged(incoming, stored *int) bool {
	return incoming == nil || (stored != nil && *incoming == *stored)
}

func strPtrEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func boolPtrEqual(a, b *bool) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
