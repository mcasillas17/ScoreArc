package espn

import (
	"fmt"
	"time"
)

func validateSummaryIdentity(rs rawSummary, eventID, homeID, awayID string) error {
	if eventID == "" || string(rs.Header.ID) != eventID || len(rs.Header.Competitions) != 1 ||
		string(rs.Header.Competitions[0].ID) != eventID {
		return fmt.Errorf("summary event identity does not match %q", eventID)
	}
	competitors := rs.Header.Competitions[0].Competitors
	if len(competitors) != 2 || homeID == "" || awayID == "" || homeID == awayID {
		return fmt.Errorf("summary event %q requires exactly two distinct teams", eventID)
	}
	for _, competitor := range competitors {
		if competitor.ID != nil && *competitor.ID != competitor.Team.ID {
			return fmt.Errorf("summary event %q has contradictory competitor/team identity", eventID)
		}
	}
	gotHome, gotAway := headerTeamIDs(rs)
	if gotHome != homeID || gotAway != awayID {
		return fmt.Errorf("summary teams do not match event %q", eventID)
	}
	return nil
}

// MapSummaryObservation derives fresh match facts from an identity-checked
// summary header. Only stable team and bracket metadata survive from expected.
// Season date bounds are checked by source, which owns the season ID policy.
func MapSummaryObservation(raw []byte, expected Match, league string, seasonYear int) (Match, error) {
	var rs rawSummary
	if err := parseRawSummary(raw, &rs); err != nil {
		return Match{}, err
	}
	if err := validateSummaryIdentity(rs, expected.ID, expected.Home.ID, expected.Away.ID); err != nil {
		return Match{}, err
	}
	if league == "" || rs.Header.League.Slug != league {
		return Match{}, fmt.Errorf("summary league %q does not match %q", rs.Header.League.Slug, league)
	}
	if seasonYear == 0 || rs.Header.Season.Year != seasonYear {
		return Match{}, fmt.Errorf("summary season %d does not match %d", rs.Header.Season.Year, seasonYear)
	}
	comp := rs.Header.Competitions[0]
	kickoff, err := parseESPNDate(comp.Date)
	if err != nil {
		return Match{}, err
	}
	state, err := observedMatchState(comp.Status)
	if err != nil {
		return Match{}, err
	}
	match := Match{
		ID: expected.ID, Home: expected.Home, Away: expected.Away,
		Kickoff: kickoff.UTC().Format(time.RFC3339), State: state,
		StatusName: comp.Status.Type.Name, StatusDetail: comp.Status.Type.ShortDetail,
		Round: expected.Round, BracketRequired: expected.BracketRequired,
		HomePlaceholder: expected.HomePlaceholder, AwayPlaceholder: expected.AwayPlaceholder,
		// A summary never confirms bracket placement or resolved placeholders.
		BracketConfirmed: false,
	}
	if state == MatchStateLive && comp.Status.DisplayClock != "" {
		clock := comp.Status.DisplayClock
		match.Minute = &clock
	}
	if len(comp.Notes) > 0 && comp.Notes[0].Text != "" {
		note := comp.Notes[0].Text
		match.Note = &note
	}
	var home, away rawHeaderCompetitor
	for _, competitor := range comp.Competitors {
		score := scoreOf(competitor.Score)
		if competitor.Score != nil && *competitor.Score != "" && score == nil {
			return Match{}, fmt.Errorf("summary event %q has invalid score", expected.ID)
		}
		if competitor.HomeAway == "home" {
			match.HomeScore = score
			home = competitor
		} else {
			match.AwayScore = score
			away = competitor
		}
	}
	match.WinnerID, err = shootoutFirstWinnerID(
		expected.Home.ID, expected.Away.ID,
		home.ShootoutScore, away.ShootoutScore, home.Winner, away.Winner,
	)
	if err != nil {
		return Match{}, fmt.Errorf("summary event %q winner: %w", expected.ID, err)
	}
	if (state == MatchStateLive || (state == MatchStateFinished && !terminalMatchStatus(match.StatusName))) &&
		(match.HomeScore == nil || match.AwayScore == nil) {
		return Match{}, fmt.Errorf("summary event %q lacks scores", expected.ID)
	}
	return match, nil
}
