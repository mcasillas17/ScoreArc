package source

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// The entrants of a finished tournament are fixed. Check the provider's
// directory against its eight original groups before using it to drive writes.
var worldCup2002Groups = [8][4]string{
	{"212", "478", "479", "654"}, // A: Uruguay, France, Denmark, Senegal
	{"164", "210", "467", "472"}, // B: Spain, Paraguay, South Africa, Slovenia
	{"205", "214", "465", "658"}, // C: Brazil, Costa Rica, Türkiye, China
	{"451", "471", "482", "660"}, // D: South Korea, Poland, Portugal, United States
	{"476", "481", "655", "656"}, // E: Republic of Ireland, Germany, Saudi Arabia, Cameroon
	{"202", "448", "466", "657"}, // F: Argentina, England, Sweden, Nigeria
	{"162", "203", "209", "477"}, // G: Italy, Mexico, Ecuador, Croatia
	{"454", "459", "627", "659"}, // H: Russia, Belgium, Japan, Tunisia
}

// WorldCup2002Archive retrieves the whole archive before exposing any rows.
// An absent squad means its season-qualified endpoint explicitly returned 404.
func (e *ESPN) WorldCup2002Archive(ctx context.Context) ([]model.Standing, map[string]model.Squad, error) {
	registry, err := config.Load()
	if err != nil {
		return nil, nil, err
	}
	competition, ok := registry.Get("world-cup")
	season := competition.Seasons["2002"]
	if !ok || competition.ESPNSlug != "fifa.world" || season.Publication != "archive" || season.Monitored {
		return nil, nil, fmt.Errorf("expected the archived world-cup/2002 edition")
	}
	// The legacy registry does not require a league UID for live World Cup
	// standings. The recorded archive identifies the men's World Cup as 606.
	competition.ESPNScoreboardID = "606"
	raw, err := e.get(ctx, espn.StandingsURL(competition.ESPNSlug, 2002))
	if err != nil {
		return nil, nil, fmt.Errorf("2002 standings: %w", err)
	}
	verified, err := standingsEdition(raw, competition, season, 2002)
	if err != nil {
		return nil, nil, err
	}
	if !verified {
		return nil, nil, fmt.Errorf("2002 standings lack edition evidence")
	}
	rows, err := espn.MapRankedStandings(raw)
	if err != nil {
		return nil, nil, err
	}
	if err := checkWorldCup2002Directory(rows); err != nil {
		return nil, nil, err
	}
	squads := make(map[string]model.Squad)
	playerTeams := make(map[string]string)
	for _, row := range rows {
		id := row.Team.ID
		raw, err := e.get(ctx, espn.TeamRosterURL(competition.ESPNSlug, id)+"?season=2002")
		if err != nil {
			var status *espn.HTTPStatusError
			// Only China and Senegal were unavailable when the archive was
			// verified. A new gap on a previously covered team aborts the run.
			if (id == "658" || id == "654") && errors.As(err, &status) && status.StatusCode == http.StatusNotFound {
				continue
			}
			return nil, nil, fmt.Errorf("2002 %s roster: %w", row.Team.Name, err)
		}
		squad, err := mapWorldCup2002Squad(raw, competition, season, row.Team)
		if err != nil {
			return nil, nil, fmt.Errorf("2002 %s roster: %w", row.Team.Name, err)
		}
		for _, member := range squad.Players {
			if other, seen := playerTeams[member.SourceID]; seen {
				return nil, nil, fmt.Errorf("player %s appears for both %s and %s", member.SourceID, other, id)
			}
			playerTeams[member.SourceID] = id
		}
		squads[id] = squad
	}
	return rows, squads, nil
}

func checkWorldCup2002Directory(rows []model.Standing) error {
	if len(rows) != 32 {
		return fmt.Errorf("2002 standings contain %d entrants, expected 32", len(rows))
	}
	seen := make(map[string]bool, len(rows))
	for _, row := range rows {
		table, err := strconv.Atoi(row.TableKey)
		if err != nil || table < 1 || table > len(worldCup2002Groups) || row.TableKey != strconv.Itoa(table) {
			return fmt.Errorf("unexpected 2002 table %q", row.TableKey)
		}
		group := string(rune('A' + table - 1))
		if row.GroupName == nil || *row.GroupName != "Group "+group || !slices.Contains(worldCup2002Groups[table-1][:], row.Team.ID) || seen[row.Team.ID] {
			return fmt.Errorf("invalid or repeated 2002 entrant %s in table %s", row.Team.ID, row.TableKey)
		}
		if row.Played != 3 || row.Wins+row.Draws+row.Losses != 3 || row.Points != 3*row.Wins+row.Draws || row.GoalDifference != row.GoalsFor-row.GoalsAgainst {
			return fmt.Errorf("inconsistent final group record for %s", row.Team.Name)
		}
		seen[row.Team.ID] = true
	}
	return nil
}

func mapWorldCup2002Squad(raw []byte, competition config.Competition, season config.Season, team model.Team) (model.Squad, error) {
	if err := validateEditionResource(raw, competition, season, 2002, "squad"); err != nil {
		return model.Squad{}, err
	}
	squad, err := espn.MapRoster(raw)
	if err != nil {
		return model.Squad{}, err
	}
	var doc struct {
		Team struct {
			Abbreviation, SeasonSummary string
			IsNational                  bool
		}
		Athletes []struct {
			UID, DisplayName string
			Statistics       *struct {
				Splits struct{ Type string }
			}
		}
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return model.Squad{}, err
	}
	if squad.TeamSourceID != team.ID || doc.Team.Abbreviation != team.Abbr || !doc.Team.IsNational || doc.Team.SeasonSummary != "2002" {
		return model.Squad{}, fmt.Errorf("team identity or season does not match the directory")
	}
	minimum := 23
	if team.ID == "477" || team.ID == "657" { // Croatia and Nigeria each have 22 observed members.
		minimum = 22
	}
	if len(squad.Players) != len(doc.Athletes) || len(squad.Players) < minimum || len(squad.Players) > 23 {
		return model.Squad{}, fmt.Errorf("unexpected roster size %d (expected %d–23)", len(squad.Players), minimum)
	}
	for i, member := range squad.Players {
		if doc.Athletes[i].UID != "s:600~a:"+member.SourceID {
			return model.Squad{}, fmt.Errorf("athlete UID does not match player %s", member.SourceID)
		}
		squad.Players[i].DisplayName = strings.TrimSpace(doc.Athletes[i].DisplayName)
		if stats := doc.Athletes[i].Statistics; stats != nil && stats.Splits.Type != "total" {
			return model.Squad{}, fmt.Errorf("statistics for player %s are not edition totals", member.SourceID)
		}
	}
	return squad, nil
}
