package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
)

const maxIdentityIDs = 100

var providerIdentityPattern = regexp.MustCompile(`^[1-9][0-9]{0,31}$`)
var teamIdentityPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type identityQuery struct {
	Kind, From string
	IDs        []string
}

type IdentityReference struct {
	ID            string  `json:"id"`
	Status        string  `json:"status"`
	CanonicalID   *string `json:"canonicalId"`
	ProviderID    *string `json:"providerId"`
	CompetitionID *string `json:"competitionId"`
	SeasonID      *string `json:"seasonId"`
	HomeID        *string `json:"homeId"`
	AwayID        *string `json:"awayId"`
}

func parseIdentityQuery(raw string) (identityQuery, error) {
	values, err := singleValues(raw, "kind", "from", "ids")
	if err != nil {
		return identityQuery{}, err
	}
	q := identityQuery{Kind: values["kind"], From: values["from"], IDs: strings.Split(values["ids"], ",")}
	if len(values) != 3 || (q.Kind != "match" && q.Kind != "player" && q.Kind != "team") ||
		(q.From != "canonical" && q.From != "espn") || len(q.IDs) > maxIdentityIDs {
		return identityQuery{}, errors.New(errQueryInvalid)
	}
	seen := make(map[string]bool, len(q.IDs))
	for _, id := range q.IDs {
		valid := providerIdentityPattern.MatchString(id)
		if q.From == "canonical" {
			valid = isCanonicalMatchID(id)
			if q.Kind == "team" {
				valid = len(id) <= 128 && teamIdentityPattern.MatchString(id)
			}
		}
		if !valid || seen[id] {
			return identityQuery{}, errors.New(errQueryInvalid)
		}
		seen[id] = true
	}
	return q, nil
}

func (a *App) handleIdentities(w http.ResponseWriter, r *http.Request) {
	comp, season := chi.URLParam(r, "comp"), chi.URLParam(r, "season")
	if _, _, ok := a.resolve(comp, season); !ok {
		writeError(w, http.StatusBadRequest, "unknown competition or season")
		return
	}
	query, err := parseIdentityQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid query")
		return
	}
	reader, finish, ok := a.beginMatchSnapshot(w, r)
	if !ok {
		return
	}
	defer finish()
	refs, err := reader.Identities(r.Context(), comp, season, query)
	finish()
	if err != nil {
		a.logger.Error("identity references unavailable")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	// Persisted references establish addressing, not a collection freshness clock.
	metadata := unknownResource("selection", "mixed")
	metadata.Source, metadata.Availability = "mixed", "partial"
	if err := writeResources(w, resourceEnvelope{Version: 1, Resources: map[string]resourceMetadata{"identity": metadata}}); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeContractJSON(w, refs)
}

func (s *Store) Identities(ctx context.Context, competition, season string, query identityQuery) ([]IdentityReference, error) {
	// Only these fixed fragments select SQL identifiers. All request values bind below.
	table, target, cast, scope, contextFields := "", "", "", "", "NULL::text,NULL::text,NULL::text,NULL::text"
	switch query.Kind {
	case "match":
		table, target, cast = "match", "match_id", "::uuid"
		scope = " AND e.competition_id=$2 AND e.season_id=$3"
		contextFields = "e.competition_id,e.season_id,e.home_team_id,e.away_team_id"
	case "player":
		table, target, cast = "player", "player_id", "::uuid"
	case "team":
		table, target = "team", "team_id"
	default:
		return nil, errors.New("invalid identity kind")
	}
	address := "input.id" + cast
	switch query.From {
	case "espn":
		address = fmt.Sprintf("(SELECT %s FROM %s_external_ref WHERE source='espn' AND source_id=input.id)", target, table)
	case "canonical":
	default:
		return nil, errors.New("invalid identity representation")
	}
	// Match scopes are bound even for global entities so every statement has the same signature.
	sql := fmt.Sprintf(`WITH input AS (SELECT id,ord FROM unnest($1::text[]) WITH ORDINALITY AS ids(id,ord))
 SELECT input.id,e.id::text,refs.ids,%s
 FROM input LEFT JOIN %s e ON e.id=%s%s
 LEFT JOIN LATERAL (
  SELECT array_agg(source_id) AS ids FROM (
   SELECT source_id FROM %s_external_ref WHERE source='espn' AND %s=e.id LIMIT 2
  ) bounded
 ) refs ON true
 WHERE $2::text IS NOT NULL AND $3::text IS NOT NULL
 ORDER BY input.ord`, contextFields, table, address, scope, table, target)
	rows, err := s.db.Query(ctx, sql, query.IDs, competition, season)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]IdentityReference, 0, len(query.IDs))
	for rows.Next() {
		ref := IdentityReference{Status: "missing"}
		var canonical, comp, sn, home, away *string
		var providerIDs []string
		if err := rows.Scan(&ref.ID, &canonical, &providerIDs, &comp, &sn, &home, &away); err != nil {
			return nil, err
		}
		switch {
		case len(providerIDs) > 1:
			ref.Status = "ambiguous"
		case canonical != nil && len(providerIDs) == 1:
			if !providerIdentityPattern.MatchString(providerIDs[0]) {
				return nil, errors.New("invalid stored provider identity")
			}
			ref.Status, ref.CanonicalID, ref.ProviderID = "resolved", canonical, &providerIDs[0]
			ref.CompetitionID, ref.SeasonID, ref.HomeID, ref.AwayID = comp, sn, home, away
		}
		result = append(result, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
