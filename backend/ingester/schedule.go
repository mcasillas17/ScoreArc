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
)

func nextInterval(anyLive bool) time.Duration {
	if anyLive {
		return fastInterval
	}
	return slowInterval
}

func needsSummary(match model.Match, existing *store.MatchRow, slowTick bool) bool {
	if existing != nil && existing.FinalizedAt.Valid {
		return false
	}
	switch match.State {
	case model.MatchStateLive, model.MatchStateFinished:
		return true
	case model.MatchStateScheduled:
		return existing == nil || !existing.HasDetail || slowTick
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
// stored, exactly like SQL's COALESCE(NULLIF($2,”), match.round).
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
