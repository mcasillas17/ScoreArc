package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/mcasillas17/scorearc-backend/shared/source"
)

const resourcesHeader = "X-ScoreArc-Resources"
const maxResourceHeaderBytes = 8192
const maxResponseResources = 8

type resourceMetadata struct {
	Status       string     `json:"status"`
	Availability string     `json:"availability"`
	Source       string     `json:"source"`
	Derivation   string     `json:"derivation"`
	Scope        string     `json:"scope"`
	ObservedAt   *time.Time `json:"observedAt"`
	FinalizedAt  *time.Time `json:"finalizedAt"`
}
type resourceEnvelope struct {
	Version   int                         `json:"version"`
	Resources map[string]resourceMetadata `json:"resources"`
}
type resourceScope struct {
	freshnessScope
	Route, Metric, PlayerID string
	Detail                  bool
	GameIDs                 []string
	Degraded                map[string]bool
}
type collectionEvidence struct {
	ObservedAt *time.Time
	RowCount   int
}
type aggregateEvidence struct {
	Count, Known, Completed, Pending, Held int
	ObservedAt, FinalizedAt, LatestAt      *time.Time
}
type resourceSnapshot struct {
	Core                         freshnessSnapshot
	CoreFound                    bool
	Unresolved                   bool
	Standings, Leaders, Squad    *collectionEvidence
	Stats, Career, Participation aggregateEvidence
	DetailCount                  int
}

func validResourceTime(at *time.Time, now time.Time) bool {
	return at != nil && !at.IsZero() && !at.After(now)
}
func unknownResource(scope, derivation string) resourceMetadata {
	return resourceMetadata{Status: "unavailable", Availability: "unavailable", Source: "espn", Derivation: derivation, Scope: scope}
}
func collectionResource(now time.Time, evidence *collectionEvidence, ttl time.Duration, scope, derivation string, dormant bool) resourceMetadata {
	r := unknownResource(scope, derivation)
	if evidence != nil && validResourceTime(evidence.ObservedAt, now) && evidence.RowCount >= 0 {
		r.ObservedAt = evidence.ObservedAt
		r.Status, r.Availability = "fresh", "complete"
		if evidence.RowCount == 0 {
			r.Status, r.Availability = "empty", "empty"
		}
		if now.Sub(*evidence.ObservedAt) >= ttl {
			r.Status = "stale"
		}
	}
	if dormant {
		r.Status = "dormant"
	}
	return r
}
func aggregateResource(now time.Time, evidence aggregateEvidence, ttl time.Duration, scope string, dormant bool) resourceMetadata {
	var accepted *collectionEvidence
	if evidence.Count > 0 && evidence.Known > 0 {
		accepted = &collectionEvidence{ObservedAt: evidence.ObservedAt, RowCount: evidence.Count}
	}
	if evidence.LatestAt != nil && !validResourceTime(evidence.LatestAt, now) {
		accepted = nil
	}
	r := collectionResource(now, accepted, ttl, scope, "direct", dormant)
	if evidence.Count > evidence.Known && evidence.Known > 0 {
		r.Availability = "partial"
		r.Status = "unavailable"
	}
	return r
}
func participationResource(now time.Time, e aggregateEvidence, scope string) resourceMetadata {
	r := unknownResource(scope, "derived")
	switch {
	case e.Count > 0 && e.Completed == e.Count && validResourceTime(e.FinalizedAt, now) && validResourceTime(e.ObservedAt, now) && (e.LatestAt == nil || validResourceTime(e.LatestAt, now)):
		r.Status, r.Availability = "fresh", "complete"
		r.FinalizedAt = e.FinalizedAt
		r.ObservedAt = e.ObservedAt
	case e.Pending > 0:
		r.Availability = "pending"
	case e.Held > 0:
		r.Availability = "partial"
	}
	return r
}
func (a *App) resourceMap(scope resourceScope, snapshot resourceSnapshot) (resourceEnvelope, *matchFreshness, error) {
	now := a.clock()
	_, season, ok := a.resolve(scope.Competition, scope.Season)
	if !ok {
		return resourceEnvelope{}, nil, errors.New("unknown resource scope")
	}
	start, end, err := source.SeasonBounds(season)
	if err != nil {
		return resourceEnvelope{}, nil, err
	}
	dormant := (now.Before(start) || !now.Before(end)) && !snapshot.Unresolved
	out := resourceEnvelope{Version: 1, Resources: map[string]resourceMetadata{}}
	resources := out.Resources
	identityScope := "competition-season"
	if scope.TeamID != "" {
		identityScope = "team-season"
	}
	if scope.PlayerID != "" {
		identityScope = "player"
	}
	if scope.MatchID != "" {
		identityScope = "match"
	}
	identity := unknownResource(identityScope, "mixed")
	identity.Source = "mixed"
	identity.Availability = "partial"
	detail := unknownResource(identityScope, "retained")
	if snapshot.DetailCount > 0 {
		detail.Availability = "partial"
	}
	var old *matchFreshness
	if hasCoreResources(scope.Route) {
		if !snapshot.CoreFound {
			return out, nil, ErrNotFound
		}
		snapshot.Core.SingleMatch = scope.MatchID != ""
		f := computeFreshness(now, start, end, snapshot.Core)
		old = &f
		r := unknownResource("selection", "direct")
		r.Status = f.Status
		if r.Status == "dormant" && snapshot.Unresolved {
			copy := snapshot.Core
			copy.HasUnfinalized = true
			r.Status = computeFreshness(now, start, end, copy).Status
		}
		if scope.Route == "calendar" || scope.Route == "bracket" {
			r.Scope = "competition-season"
		}
		if scope.TeamID != "" {
			r.Scope = "team-season"
		}
		if scope.MatchID != "" {
			r.Scope = "match"
		}
		r.Availability = "complete"
		if len(snapshot.Core.Matches) == 0 {
			r.Availability = "empty"
		}
		if validResourceTime(f.ObservedAt, now) {
			r.ObservedAt = f.ObservedAt
		}
		if len(snapshot.Core.Matches) == 1 && scope.MatchID != "" && validResourceTime(snapshot.Core.Matches[0].FinalizedAt, now) {
			r.FinalizedAt = snapshot.Core.Matches[0].FinalizedAt
		}
		if r.ObservedAt == nil && r.FinalizedAt == nil {
			r.Availability = "unavailable"
			if r.Status != "dormant" {
				r.Status = "unavailable"
			}
		}
		switch scope.Route {
		case "calendar":
			r.Derivation = "derived"
			resources["calendar"] = r
		case "bracket":
			r.Derivation = "derived"
			resources["bracket"] = r
			resources["identity"] = identity
		default:
			resources["matches"] = r
			resources["identity"] = identity
			if scope.Route != "matches" || scope.Detail {
				resources["detail"] = detail
			}
		}
	}
	switch scope.Route {
	case "standings", "team":
		resources["standings"] = collectionResource(now, snapshot.Standings, 20*time.Minute, "competition-season", "direct", dormant)
		resources["identity"] = identity
	case "leaders", "top-scorers":
		resources["leaders"] = collectionResource(now, snapshot.Leaders, 20*time.Minute, "competition-season", "direct", dormant)
		if scope.Route == "top-scorers" {
			r := resources["leaders"]
			r.Derivation = "projection"
			resources["leaders"] = r
		}
		resources["identity"] = identity
	}
	if scope.Route == "squad" || scope.Route == "team" {
		resources["squad"] = collectionResource(now, snapshot.Squad, 25*time.Hour, "team-season", "current-roster", dormant)
		resources["seasonStats"] = aggregateResource(now, snapshot.Stats, 25*time.Hour, "team-season", dormant)
		resources["identity"] = identity
	}
	if scope.Route == "player" {
		resources["identity"] = identity
		resources["seasonStats"] = aggregateResource(now, snapshot.Stats, 25*time.Hour, "player-season", dormant)
		resources["career"] = collectionResource(now, &collectionEvidence{ObservedAt: snapshot.Career.ObservedAt, RowCount: snapshot.Career.Count}, 32*24*time.Hour, "player", "direct", false)
		if snapshot.Career.Count > maxPlayerCareer {
			r := resources["career"]
			r.Status, r.Availability = "unavailable", "partial"
			resources["career"] = r
		}
		log := unknownResource("player-season", "derived")
		if len(scope.GameIDs) > 0 {
			log.Availability = "partial"
		}
		resources["gameLog"] = log
		resources["participation"] = participationResource(now, snapshot.Participation, "selection")
	}
	if scope.Route == "summary" || scope.Route == "box-score" {
		resources["participation"] = participationResource(now, snapshot.Participation, "match")
		resources["identity"] = identity
	}
	for name := range scope.Degraded {
		r, exists := resources[name]
		if exists {
			r.Status, r.Availability = "unavailable", "unavailable"
			r.ObservedAt, r.FinalizedAt = nil, nil
			resources[name] = r
		}
	}
	return out, old, nil
}
func hasCoreResources(route string) bool {
	return route == "matches" || route == "calendar" || route == "bracket" || route == "team" || route == "summary"
}
func writeResources(w http.ResponseWriter, envelope resourceEnvelope) error {
	if len(envelope.Resources) == 0 || len(envelope.Resources) > maxResponseResources {
		return errors.New("resource count exceeds bound")
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	if len(raw) > maxResourceHeaderBytes {
		return errors.New("resource header exceeds bound")
	}
	w.Header().Set(resourcesHeader, string(raw))
	return nil
}
func (a *App) attachResources(w http.ResponseWriter, r *http.Request, reader matchReader, finish func(), scope resourceScope) bool {
	snapshot, err := reader.Resources(r.Context(), scope)
	var envelope resourceEnvelope
	var old *matchFreshness
	if err == nil {
		envelope, old, err = a.resourceMap(scope, snapshot)
	}
	finish()
	if err == nil {
		err = writeResources(w, envelope)
	}
	if err != nil {
		a.logDependencyError(r, "resource evidence", err, "competition", scope.Competition, "season", scope.Season)
		writeError(w, 500, "internal error")
		return false
	}
	if old != nil {
		w.Header().Set("X-ScoreArc-Freshness", old.Status)
		w.Header().Set("X-ScoreArc-Poll-Status", old.PollStatus)
		w.Header().Set("X-ScoreArc-Stale-Matches", strconv.Itoa(old.StaleMatches))
		w.Header().Set("X-ScoreArc-Overdue-Matches", strconv.Itoa(old.OverdueMatches))
		if old.ObservedAt != nil {
			w.Header().Set("X-ScoreArc-Observed-At", old.ObservedAt.UTC().Format(time.RFC3339Nano))
		}
	}
	return true
}

// One request-scoped statement: the core projection contains only metadata for
// returned IDs, and every other component is an aggregate, never an entity list.
const resourceEvidenceSQL = `
WITH core(succeeded_at,poll_status,has_unfinalized,id,kickoff,state,status_name,finalized_at,observed_at) AS MATERIALIZED (` + freshnessSQL + ` AND $7::boolean),
selected AS MATERIALIZED (
 SELECT m.id,CASE WHEN m.finalized_at >= timestamptz '0001-01-01 00:00:00Z' AND m.finalized_at < timestamptz '10000-01-01 00:00:00Z' THEN m.finalized_at END AS finalized_at FROM match m WHERE m.competition_id=$1 AND m.season_id=$2 AND m.id=ANY($9::uuid[])
), roster AS MATERIALIZED (
 {{roster}}
), stats AS MATERIALIZED (
 {{stats}}
), participation AS MATERIALIZED (
 SELECT s.id,s.finalized_at,p.completed,CASE WHEN p.completed_at >= timestamptz '0001-01-01 00:00:00Z' AND p.completed_at < timestamptz '10000-01-01 00:00:00Z' THEN p.completed_at END AS completed_at,(SELECT count(*) FROM (SELECT 1 FROM appearance a WHERE a.match_id=s.id LIMIT 65) a) AS held
 FROM selected s LEFT JOIN match_participation_availability p ON p.match_id=s.id
)
SELECT jsonb_build_object(
 'CoreFound',(SELECT count(*)>0 FROM core WHERE $10::text IS NOT NULL),
 'Core',jsonb_build_object('PollSucceededAt',(SELECT max(succeeded_at) FROM core),'PollStatus',(SELECT max(poll_status) FROM core),
 'HasUnfinalized',coalesce((SELECT bool_or(has_unfinalized) FROM core),false),
 'Matches',coalesce((SELECT jsonb_agg(jsonb_build_object('Kickoff',kickoff,'State',state,'Status',status_name,'FinalizedAt',finalized_at,'ObservedAt',observed_at)) FROM core WHERE id IS NOT NULL),'[]'::jsonb)),
 'Unresolved',EXISTS(SELECT 1 FROM match m WHERE m.competition_id=$1 AND m.season_id=$2 AND
 (m.finalized_at IS NULL OR (m.state='finished' AND m.status_name NOT IN ('STATUS_CANCELED','STATUS_ABANDONED','STATUS_FORFEIT') AND NOT EXISTS(SELECT 1 FROM match_participation_availability p WHERE p.match_id=m.id AND p.completed)))),
 'Standings',{{standings}},
 'Leaders',{{leaders}},
 'Squad',{{squad}},
 'Stats',jsonb_build_object('Count',CASE WHEN $8::uuid IS NOT NULL THEN 1 ELSE (SELECT count(*) FROM roster) END,'Known',(SELECT count(observed_at) FROM stats),'ObservedAt',(SELECT min(observed_at) FROM stats),'LatestAt',(SELECT max(observed_at) FROM stats)),
 'Career',{{career}},
 'Participation',jsonb_build_object('Count',(SELECT count(*) FROM participation),'Completed',(SELECT count(*) FROM participation WHERE completed AND completed_at IS NOT NULL AND finalized_at IS NOT NULL),
 'Pending',(SELECT count(*) FROM participation WHERE completed=false),'Held',(SELECT coalesce(sum(held),0) FROM participation),'ObservedAt',(SELECT min(completed_at) FROM participation WHERE completed),
 'LatestAt',(SELECT max(greatest(completed_at,finalized_at)) FROM participation WHERE completed),'FinalizedAt',(SELECT min(finalized_at) FROM participation WHERE completed)),
 'DetailCount',{{detail}}
)`

func (s *Store) Resources(ctx context.Context, scope resourceScope) (resourceSnapshot, error) {
	var snapshot resourceSnapshot
	var ids []uuid.UUID
	selected := scope.MatchIDs
	if scope.MatchID != "" {
		selected = []string{scope.MatchID}
	}
	if scope.Selected || scope.MatchID != "" {
		ids = make([]uuid.UUID, 0, len(selected))
		for _, raw := range selected {
			id, err := uuid.Parse(raw)
			if err != nil {
				return snapshot, err
			}
			ids = append(ids, id)
		}
	}
	gameIDs := make([]uuid.UUID, 0, len(scope.GameIDs)+1)
	games := scope.GameIDs
	if scope.MatchID != "" {
		games = []string{scope.MatchID}
	}
	for _, raw := range games {
		id, err := uuid.Parse(raw)
		if err != nil {
			return snapshot, err
		}
		gameIDs = append(gameIDs, id)
	}
	var playerID *uuid.UUID
	if scope.PlayerID != "" {
		id, err := uuid.Parse(scope.PlayerID)
		if err != nil {
			return snapshot, err
		}
		playerID = &id
	}
	var raw []byte
	standings, leaders, squad := "NULL::jsonb", "NULL::jsonb", "NULL::jsonb"
	if scope.Route == "standings" || scope.Route == "team" {
		standings = resourceStandingsSQL
	}
	if scope.Route == "leaders" || scope.Route == "top-scorers" {
		leaders = resourceLeadersSQL
	}
	if (scope.Route == "squad" || scope.Route == "team") && !scope.Degraded["squad"] {
		squad = resourceSquadSQL
	}
	roster, stats, career, detail := "SELECT NULL::uuid AS player_id WHERE false", "SELECT NULL::timestamptz AS observed_at WHERE false", "jsonb_build_object('ObservedAt',null,'Count',0)", "0"
	if (scope.Route == "squad" || scope.Route == "team") && !scope.Degraded["squad"] {
		roster, stats = resourceRosterSQL, resourceStatsSQL
	}
	if scope.Route == "player" {
		stats, career = resourceStatsSQL, resourceCareerSQL
	}
	if (scope.Route == "summary" || scope.Route == "team" || (scope.Route == "matches" && scope.Detail)) && !scope.Degraded["detail"] {
		detail = resourceDetailSQL
	}
	query := strings.NewReplacer("{{standings}}", standings, "{{leaders}}", leaders, "{{squad}}", squad, "{{roster}}", roster, "{{stats}}", stats, "{{career}}", career, "{{detail}}", detail).Replace(resourceEvidenceSQL)
	err := s.db.QueryRow(ctx, query, scope.Competition, scope.Season, ids, scope.TeamID, scope.Bracket, bracketRoundOrder, hasCoreResources(scope.Route), playerID, gameIDs, scope.Metric).Scan(&raw)
	if err != nil {
		return snapshot, err
	}
	err = json.Unmarshal(raw, &snapshot)
	return snapshot, err
}

const resourceRosterSQL = `SELECT sm.player_id FROM squad_membership sm WHERE sm.competition_id=$1 AND sm.season_id=$2 AND sm.team_id=$4 LIMIT 101`

const resourceStatsSQL = `SELECT CASE WHEN st.observed_at >= timestamptz '0001-01-01 00:00:00Z' AND st.observed_at < timestamptz '10000-01-01 00:00:00Z' THEN st.observed_at END AS observed_at FROM player_season_stat st WHERE st.competition_id=$1 AND st.season_id=$2 AND st.source='espn'
 AND (($8::uuid IS NOT NULL AND st.player_id=$8) OR ($8::uuid IS NULL AND st.player_id IN (SELECT player_id FROM roster)))`

const resourceCareerSQL = `jsonb_build_object('ObservedAt',(SELECT CASE WHEN bio_observed_at >= timestamptz '0001-01-01 00:00:00Z' AND bio_observed_at < timestamptz '10000-01-01 00:00:00Z' THEN bio_observed_at END FROM player WHERE id=$8),'Count',(SELECT count(*) FROM (SELECT 1 FROM player_team_history WHERE player_id=$8 LIMIT 51) history))`

const resourceDetailSQL = `(SELECT count(*) FROM match_detail d JOIN core c ON c.id=d.match_id)`

// Source and count must still match the accepted replacement; a later provider
// cannot inherit ESPN's clock. Probes stop one row beyond their fixed bound.
const resourceStandingsSQL = `(SELECT jsonb_build_object('ObservedAt',CASE WHEN o.observed_at >= timestamptz '0001-01-01 00:00:00Z' AND o.observed_at < timestamptz '10000-01-01 00:00:00Z' THEN o.observed_at END,'RowCount',o.row_count)
 FROM resource_observation o CROSS JOIN LATERAL (SELECT count(*) AS n,coalesce(bool_and(source='espn'),true) AS owned
 FROM (SELECT source FROM standing WHERE competition_id=$1 AND season_id=$2 LIMIT 10001) facts) actual
 WHERE o.competition_id=$1 AND o.season_id=$2 AND o.source='espn' AND o.resource='standings' AND o.subject=''
 AND actual.n=o.row_count AND actual.n<=10000 AND actual.owned)`
const resourceLeadersSQL = `(SELECT jsonb_build_object('ObservedAt',CASE WHEN o.observed_at >= timestamptz '0001-01-01 00:00:00Z' AND o.observed_at < timestamptz '10000-01-01 00:00:00Z' THEN o.observed_at END,'RowCount',o.row_count)
 FROM resource_observation o CROSS JOIN LATERAL (SELECT count(*) AS n,coalesce(bool_and(source='espn'),true) AS owned
 FROM (SELECT source FROM top_scorer WHERE competition_id=$1 AND season_id=$2 AND category=$10 LIMIT 31) facts) actual
 WHERE o.competition_id=$1 AND o.season_id=$2 AND o.source='espn' AND o.resource='leaders' AND o.subject=$10
 AND actual.n=o.row_count AND actual.n<=30 AND actual.owned)`
const resourceSquadSQL = `(SELECT jsonb_build_object('ObservedAt',CASE WHEN o.observed_at >= timestamptz '0001-01-01 00:00:00Z' AND o.observed_at < timestamptz '10000-01-01 00:00:00Z' THEN o.observed_at END,'RowCount',o.row_count)
 FROM resource_observation o CROSS JOIN LATERAL (SELECT count(*) AS n,coalesce(bool_and(source='espn'),true) AS owned
 FROM (SELECT source FROM squad_membership WHERE competition_id=$1 AND season_id=$2 AND team_id=$4 LIMIT 101) facts) actual
 WHERE o.competition_id=$1 AND o.season_id=$2 AND o.source='espn' AND o.resource='squad' AND o.subject=$4
 AND actual.n=o.row_count AND actual.n<=100 AND actual.owned)`
