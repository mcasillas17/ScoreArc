package main

import "github.com/mcasillas17/scorearc-backend/shared/espn"

// Match mirrors src/server/data/types.ts's Match exactly. The detail fields
// are stored separately in Postgres and reconstructed by Store.Matches.
type Match struct {
	ID             string               `json:"id"`
	Kickoff        string               `json:"kickoff"`
	State          espn.MatchState      `json:"state"`
	Minute         *string              `json:"minute"`
	StatusDetail   string               `json:"statusDetail"`
	StatusName     string               `json:"statusName"`
	Home           espn.Team            `json:"home"`
	Away           espn.Team            `json:"away"`
	HomeScore      *int                 `json:"homeScore"`
	AwayScore      *int                 `json:"awayScore"`
	WinnerID       *string              `json:"winnerId"`
	Note           *string              `json:"note"`
	Scorers        []espn.Scorer        `json:"scorers"`
	Cards          []espn.Card          `json:"cards"`
	Shootout       *espn.Shootout       `json:"shootout"`
	ShootoutDetail *espn.ShootoutDetail `json:"shootoutDetail"`
	Stats          *espn.MatchStats     `json:"stats"`
	WinProbability *espn.WinProbability `json:"winProbability"`
}

type Standing struct {
	Team           espn.Team `json:"team"`
	Rank           int       `json:"rank"`
	Played         int       `json:"played"`
	Wins           int       `json:"wins"`
	Draws          int       `json:"draws"`
	Losses         int       `json:"losses"`
	GoalsFor       int       `json:"goalsFor"`
	GoalsAgainst   int       `json:"goalsAgainst"`
	GoalDifference int       `json:"goalDifference"`
	Points         int       `json:"points"`
	Advanced       bool      `json:"advanced"`
}

type Group struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Standings []Standing `json:"standings"`
}

type BracketRound struct {
	Slug    string              `json:"slug"`
	Name    string              `json:"name"`
	Matches []espn.BracketMatch `json:"matches"`
}

// MatchSummary mirrors MatchSummaryData. The aggregate shootout score is part
// of Match, not the on-demand summary contract.
type MatchSummary struct {
	Scorers        []espn.Scorer         `json:"scorers"`
	Cards          []espn.Card           `json:"cards"`
	Stats          *espn.MatchStats      `json:"stats"`
	WinProbability *espn.WinProbability  `json:"winProbability"`
	Lineups        *espn.MatchLineups    `json:"lineups"`
	Videos         []espn.MatchVideo     `json:"videos"`
	ShootoutDetail *espn.ShootoutDetail  `json:"shootoutDetail"`
	Info           *espn.MatchInfo       `json:"info"`
	Form           *espn.MatchForm       `json:"form"`
	Commentary     []espn.CommentaryItem `json:"commentary"`
	H2H            []espn.H2HMeeting     `json:"h2h"`
}

func normalizeMatch(match *Match) {
	if match.Scorers == nil {
		match.Scorers = []espn.Scorer{}
	}
	if match.Cards == nil {
		match.Cards = []espn.Card{}
	}
	if match.ShootoutDetail != nil {
		if match.ShootoutDetail.Home == nil {
			match.ShootoutDetail.Home = []espn.PenaltyKick{}
		}
		if match.ShootoutDetail.Away == nil {
			match.ShootoutDetail.Away = []espn.PenaltyKick{}
		}
	}
}

func normalizeMatchSummary(summary *MatchSummary) {
	if summary.Scorers == nil {
		summary.Scorers = []espn.Scorer{}
	}
	if summary.Cards == nil {
		summary.Cards = []espn.Card{}
	}
	if summary.Videos == nil {
		summary.Videos = []espn.MatchVideo{}
	}
	if summary.Commentary == nil {
		summary.Commentary = []espn.CommentaryItem{}
	}
	if summary.H2H == nil {
		summary.H2H = []espn.H2HMeeting{}
	}
	if summary.ShootoutDetail != nil {
		if summary.ShootoutDetail.Home == nil {
			summary.ShootoutDetail.Home = []espn.PenaltyKick{}
		}
		if summary.ShootoutDetail.Away == nil {
			summary.ShootoutDetail.Away = []espn.PenaltyKick{}
		}
	}
	if summary.Lineups != nil {
		if summary.Lineups.Home.Players == nil {
			summary.Lineups.Home.Players = []espn.LineupPlayer{}
		}
		if summary.Lineups.Away.Players == nil {
			summary.Lineups.Away.Players = []espn.LineupPlayer{}
		}
	}
	if summary.Form != nil {
		if summary.Form.Home == nil {
			summary.Form.Home = []espn.FormResult{}
		}
		if summary.Form.Away == nil {
			summary.Form.Away = []espn.FormResult{}
		}
	}
}
