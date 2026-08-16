package espn

import (
	"encoding/json"
	"strconv"
	"strings"
)

// MapParticipation extracts the people from an ESPN match summary: the full
// squads (starters AND substitutes) and one event per player-action.
//
// It is deliberately a sibling of MapSummary rather than part of it. MapSummary
// produces MatchDetail, every field of which is serialized into match_detail's
// jsonb and served to the site; adding to it would change an API response.
// Nothing here is serialized, so this can grow without touching the contract.
//
// A summary with no rosters and no key events is not an error — plenty of
// scheduled matches have neither. The caller gets empty slices.
func MapParticipation(raw []byte, homeSourceID, awaySourceID string) (*MatchParticipation, error) {
	var rs rawSummary
	if err := json.Unmarshal(raw, &rs); err != nil {
		return nil, err
	}

	part := &MatchParticipation{
		HomeTeamSourceID: homeSourceID,
		AwayTeamSourceID: awaySourceID,
		Home:             make([]SquadPlayer, 0),
		Away:             make([]SquadPlayer, 0),
		Events:           make([]PlayerEvent, 0),
	}

	for i := range rs.Rosters {
		entry := &rs.Rosters[i]
		squad := mapSquad(entry)
		switch string(entry.Team.ID) {
		case homeSourceID:
			part.Home = append(part.Home, squad...)
		case awaySourceID:
			part.Away = append(part.Away, squad...)
		}
		// A roster for neither side is ESPN sending us a match we didn't ask
		// for; dropping it is correct — we have no team to attribute it to.
	}

	for _, e := range rs.KeyEvents {
		part.Events = append(part.Events, mapPlayerEvents(e)...)
	}

	return part, nil
}

func mapSquad(entry *rawRosterEntry) []SquadPlayer {
	out := make([]SquadPlayer, 0, len(entry.Roster))
	for _, p := range entry.Roster {
		var number *int
		if n, err := strconv.Atoi(p.Jersey); err == nil {
			number = &n
		}
		out = append(out, SquadPlayer{
			SourceID: string(p.Athlete.ID),
			Name:     p.Athlete.DisplayName,
			Number:   number,
			Position: p.Position.Abbreviation,
			Starter:  p.Starter,
		})
	}
	return out
}

// mapPlayerEvents turns one ESPN key event into zero or more player-actions.
//
// Zero for events that concern no player (kickoff, halftime, delays) or that
// carry no team — we will not attribute an action to a team we can't name.
// Two for a substitution.
func mapPlayerEvents(e rawKeyEvent) []PlayerEvent {
	if e.Team == nil || e.Team.ID == "" {
		return nil
	}
	teamID := string(e.Team.ID)

	base := func(kind string, athlete rawAthleteName) PlayerEvent {
		return PlayerEvent{
			TeamSourceID:   teamID,
			PlayerSourceID: string(athlete.ID),
			PlayerName:     athlete.DisplayName,
			Type:           kind,
			Minute:         e.Clock.DisplayValue,
			Penalty:        e.PenaltyKick,
			Shootout:       e.Shootout,
			Detail:         e.Type.Text,
		}
	}

	// ESPN's machine value is stable across locales; e.Type.Text is English
	// display prose. Fall back to the scoringPlay flag, which is what the
	// legacy scorer mapper keys on, so the two can never disagree about
	// whether a goal happened.
	kind := strings.ToLower(e.Type.Type)

	switch {
	case kind == "substitution":
		// Verified against the recorded fixture (8/8): participants[0] is the
		// player coming ON, participants[1] the player going OFF, matching the
		// event's own "X replaces Y" prose. Any other arity is a shape we have
		// not seen — skip rather than guess which way round it is, because an
		// inverted substitution is worse than a missing one.
		if len(e.Participants) != 2 {
			return nil
		}
		return []PlayerEvent{
			base(PlayerEventSubOn, e.Participants[0].Athlete),
			base(PlayerEventSubOff, e.Participants[1].Athlete),
		}

	case strings.Contains(kind, "own"):
		// Unverified: no own goal appears in any recorded fixture. Detail keeps
		// ESPN's own label, so if this guess is wrong it is fixable from stored
		// rows rather than by re-fetching a finished match.
		return []PlayerEvent{base(PlayerEventOwnGoal, firstAthlete(e.Participants))}

	case e.ScoringPlay:
		return []PlayerEvent{base(PlayerEventGoal, firstAthlete(e.Participants))}

	case strings.Contains(kind, "red-card"), redCardRe.MatchString(e.Type.Text):
		return []PlayerEvent{base(PlayerEventRed, firstAthlete(e.Participants))}

	case strings.Contains(kind, "yellow-card"), cardTypeRe.MatchString(e.Type.Text):
		return []PlayerEvent{base(PlayerEventYellow, firstAthlete(e.Participants))}
	}

	return nil
}

func firstAthlete(participants []rawParticipant) rawAthleteName {
	if len(participants) == 0 {
		return rawAthleteName{}
	}
	return participants[0].Athlete
}
