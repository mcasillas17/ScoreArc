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
