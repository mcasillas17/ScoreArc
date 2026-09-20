package main

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/shared/source"
)

var freshnessHeaders = []string{
	"X-ScoreArc-Freshness", "X-ScoreArc-Observed-At", "X-ScoreArc-Poll-Status",
	"X-ScoreArc-Stale-Matches", "X-ScoreArc-Overdue-Matches",
}

// Filters only the returned matches; the poll and unresolved-work checks always
// retain competition/season scope, including for empty team/bracket subsets.
type freshnessScope struct {
	Competition, Season, MatchID, TeamID string
	Bracket                              bool
}

type freshnessMatch struct {
	Kickoff                 time.Time
	State, Status           string
	FinalizedAt, ObservedAt *time.Time
}

type freshnessSnapshot struct {
	PollSucceededAt *time.Time
	PollStatus      string
	HasUnfinalized  bool
	Matches         []freshnessMatch
	SingleMatch     bool // Explicit UUID selection, not a collection containing one row.
}

type matchFreshness struct {
	Status, PollStatus           string
	ObservedAt                   *time.Time
	StaleMatches, OverdueMatches int
}

// Age is measured by the reader, not by a heartbeat inside the worker. No
// retry timestamp or match.updated_at is evidence of accepted source facts.
func computeFreshness(now, start, end time.Time, snapshot freshnessSnapshot) matchFreshness {
	result := matchFreshness{Status: "fresh", PollStatus: snapshot.PollStatus}
	if result.PollStatus == "" {
		result.PollStatus = "unknown"
	}
	knownTime := func(at *time.Time) bool { return at != nil && !at.After(now) }
	oldest := func(at *time.Time) {
		if knownTime(at) && (result.ObservedAt == nil || at.Before(*result.ObservedAt)) {
			result.ObservedAt = at
		}
	}
	oldest(snapshot.PollSucceededAt)
	pollKnown := knownTime(snapshot.PollSucceededAt)
	pollHealthy := pollKnown && snapshot.PollStatus == "ok" && now.Sub(*snapshot.PollSucceededAt) < 20*time.Minute
	unfinalized, missing := 0, false
	for _, match := range snapshot.Matches {
		oldest(match.ObservedAt)
		if match.FinalizedAt != nil {
			continue
		}
		unfinalized++
		delayed := match.Status == "STATUS_POSTPONED" || match.Status == "STATUS_SUSPENDED"
		overdue := !delayed && ((match.State == "scheduled" && now.Sub(match.Kickoff) >= 15*time.Minute) ||
			(match.State == "live" && now.Sub(match.Kickoff) >= 4*time.Hour))
		ttl := 24 * time.Hour
		if match.State == "live" && !delayed {
			ttl = 2 * time.Minute
		} else if match.State == "scheduled" && !delayed {
			// Full-season discovery runs daily; leave one hour for slow-tick
			// alignment and bounded reconciliation of distant scheduled rows.
			ttl = 25 * time.Hour
		}
		observed := knownTime(match.ObservedAt)
		if !observed {
			missing = true
		}
		if overdue {
			result.OverdueMatches++
		}
		if overdue || !observed || now.Sub(*match.ObservedAt) >= ttl || !pollHealthy {
			result.StaleMatches++
		}
	}
	switch {
	case (now.Before(start) || !now.Before(end)) && !snapshot.HasUnfinalized:
		result.Status = "dormant"
	case snapshot.SingleMatch && len(snapshot.Matches) == 1 && unfinalized == 0:
		// One sealed match needs no heartbeat. Active collections still need
		// discovery polling, even when every currently known row is finalized.
	case result.OverdueMatches > 0:
		result.Status = "stale"
	case missing || !pollKnown:
		result.Status = "unavailable"
	case !pollHealthy || result.StaleMatches > 0:
		result.Status = "stale"
	case len(snapshot.Matches) == 0:
		result.Status = "empty"
	}
	return result
}

func (s *Store) MatchScope(ctx context.Context, id string) (freshnessScope, error) {
	scope := freshnessScope{MatchID: id}
	matchID, err := uuid.Parse(id)
	if err != nil {
		return scope, ErrNotFound
	}
	err = s.db.QueryRow(ctx, `SELECT competition_id, season_id FROM match WHERE id=$1`, matchID).
		Scan(&scope.Competition, &scope.Season)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return scope, err
}

// One indexed metadata query, no detail/body projection and no per-match SQL.
// The season row preserves poll evidence when the selected collection is empty,
// while rejecting unknown persisted scopes instead of inventing an empty one.
const freshnessSQL = `
SELECT p.succeeded_at, COALESCE(p.outcome, 'unknown'),
       EXISTS (SELECT 1 FROM match pending
               WHERE pending.competition_id=$1 AND pending.season_id=$2
                 AND pending.finalized_at IS NULL),
       m.id, m.kickoff, m.state, m.status_name, m.finalized_at, sync.observed_at
FROM season s
LEFT JOIN match_poll_status p
  ON p.competition_id=$1 AND p.season_id=$2 AND p.source='espn'
LEFT JOIN match m ON m.competition_id=$1 AND m.season_id=$2
  AND ($3::uuid IS NULL OR m.id=$3)
  AND ($4::text='' OR m.home_team_id=$4 OR m.away_team_id=$4)
  AND (NOT $5::boolean OR m.round=ANY($6::text[]))
LEFT JOIN match_sync_status sync ON sync.match_id=m.id AND sync.source='espn'
WHERE s.competition_id=$1 AND s.id=$2`

func (s *Store) Freshness(ctx context.Context, scope freshnessScope) (freshnessSnapshot, error) {
	var snapshot freshnessSnapshot
	var id *uuid.UUID
	if scope.MatchID != "" {
		parsed, err := uuid.Parse(scope.MatchID)
		if err != nil {
			return snapshot, ErrNotFound
		}
		id = &parsed
		snapshot.SingleMatch = true
	}
	rows, err := s.db.Query(ctx, freshnessSQL, scope.Competition, scope.Season, id, scope.TeamID, scope.Bracket, bracketRoundOrder)
	if err != nil {
		return snapshot, err
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		found = true
		var matchID *uuid.UUID
		var kickoff *time.Time
		var state, status *string
		var match freshnessMatch
		if err := rows.Scan(&snapshot.PollSucceededAt, &snapshot.PollStatus, &snapshot.HasUnfinalized,
			&matchID, &kickoff, &state, &status, &match.FinalizedAt, &match.ObservedAt); err != nil {
			return snapshot, err
		}
		if matchID != nil {
			match.Kickoff, match.State, match.Status = *kickoff, *state, *status
			snapshot.Matches = append(snapshot.Matches, match)
		}
	}
	if err := rows.Err(); err != nil {
		return snapshot, err
	}
	if !found {
		return snapshot, ErrNotFound
	}
	return snapshot, nil
}

func (a *App) readFreshness(ctx context.Context, reader matchReader, scope freshnessScope) (matchFreshness, error) {
	_, season, ok := a.resolve(scope.Competition, scope.Season)
	if !ok {
		return matchFreshness{}, errors.New("unknown freshness scope")
	}
	start, end, err := source.SeasonBounds(season)
	if err != nil {
		return matchFreshness{}, err
	}
	snapshot, err := reader.Freshness(ctx, scope)
	if err != nil {
		return matchFreshness{}, err
	}
	now := time.Now()
	if a.now != nil {
		now = a.now()
	}
	return computeFreshness(now, start, end, snapshot), nil
}

func (a *App) attachFreshness(writer http.ResponseWriter, request *http.Request, reader matchReader, finish func(), scope freshnessScope) bool {
	freshness, err := a.readFreshness(request.Context(), reader, scope)
	// Release before any response write, including error JSON. A slow client
	// must not keep this request's database snapshot/pooled connection open.
	finish()
	if err != nil {
		// Do not log dependency text: it can include connection credentials.
		a.logger.Error("match freshness unavailable", "competition", scope.Competition, "season", scope.Season)
		writeError(writer, http.StatusInternalServerError, "internal error")
		return false
	}
	writer.Header().Set("X-ScoreArc-Freshness", freshness.Status)
	writer.Header().Set("X-ScoreArc-Poll-Status", freshness.PollStatus)
	writer.Header().Set("X-ScoreArc-Stale-Matches", strconv.Itoa(freshness.StaleMatches))
	writer.Header().Set("X-ScoreArc-Overdue-Matches", strconv.Itoa(freshness.OverdueMatches))
	if freshness.ObservedAt != nil {
		writer.Header().Set("X-ScoreArc-Observed-At", freshness.ObservedAt.UTC().Format(time.RFC3339Nano))
	}
	return true
}
