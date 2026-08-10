package espn

// Domain types persisted by the ingester. These mirror the frontend's
// src/server/data/types.ts field-for-field (same JSON tags as the TS
// property names) so the eventual Postgres reader can serialize rows back
// out in the exact shape the frontend already expects.
//
// Match here is deliberately narrower than the TS `Match` interface: comp
// and season are added by the ingester (they're not present in a single
// ESPN payload), and the "detail" fields the TS type inlines (scorers,
// cards, stats, winProbability, shootout, shootoutDetail) live instead on
// MatchDetail, stored separately as jsonb — the scoreboard/bracket mappers
// (Tasks 2, 5) never populate them. Match additionally carries Round: the
// bracket mapper (Task 5) tags knockout matches with a round slug (e.g.
// "round-of-16") before they're upserted into the same `match` table as
// group-stage fixtures (Task 6); group-stage matches leave Round empty.

// MatchState mirrors types.ts's MatchState union.
type MatchState string

const (
	MatchStateScheduled MatchState = "scheduled"
	MatchStateLive      MatchState = "live"
	MatchStateFinished  MatchState = "finished"
)

// Team mirrors types.ts's Team.
type Team struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Abbr     string  `json:"abbr"`
	CrestURL *string `json:"crestUrl"`
}

// Match is the ESPN-mapped subset of types.ts's Match that the scoreboard
// and bracket mappers (Tasks 2, 5) produce; comp/season are attached by the
// ingester's store layer (Task 6), not by these mappers.
type Match struct {
	ID           string     `json:"id"`
	Kickoff      string     `json:"kickoff"` // ISO date string
	State        MatchState `json:"state"`
	Round        string     `json:"round"` // knockout round slug, e.g. "round-of-16"; "" for group stage
	Minute       *string    `json:"minute"`
	StatusDetail string     `json:"statusDetail"`
	StatusName   string     `json:"statusName"`
	Home         Team       `json:"home"`
	Away         Team       `json:"away"`
	HomeScore    *int       `json:"homeScore"`
	AwayScore    *int       `json:"awayScore"`
	WinnerID     *string    `json:"winnerId"`
	Note         *string    `json:"note"`
}

// BracketTeam mirrors types.ts's BracketTeam. It is distinct from Team
// because knockout brackets can name a not-yet-determined slot ("Round of 32
// Winner 5") before the feeding match resolves; Placeholder flags that case
// so the reader can render a TBD slot instead of a real crest.
type BracketTeam struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Abbr        string  `json:"abbr"`
	CrestURL    *string `json:"crestUrl"`
	Placeholder bool    `json:"placeholder"`
}

// BracketMatch mirrors types.ts's BracketMatch field-for-field. It is the
// bracket mapper's (Task 5) output: a knockout match tagged with its round
// slug, alongside BracketTeam legs that may still be placeholders. These
// rows are upserted into the same `match` table as scoreboard matches
// (Task 6); the reader reconstructs BracketRound[] (name + ordered matches)
// from them in slice 1c.
type BracketMatch struct {
	ID           string      `json:"id"`
	Round        string      `json:"round"` // knockout round slug, e.g. "round-of-16"
	Kickoff      string      `json:"kickoff"`
	Home         BracketTeam `json:"home"`
	Away         BracketTeam `json:"away"`
	HomeScore    *int        `json:"homeScore"`
	AwayScore    *int        `json:"awayScore"`
	State        MatchState  `json:"state"`
	StatusDetail string      `json:"statusDetail"`
	StatusName   string      `json:"statusName"`
	Minute       *string     `json:"minute"`
	WinnerID     *string     `json:"winnerId"`
	Note         *string     `json:"note"`
}

// Standing mirrors types.ts's Standing, plus GroupID/GroupName: the ESPN
// group ("Group A") a row was ranked within, not present on the TS Standing
// type itself (the TS side carries it one level up, on Group.id/Group.name)
// but persisted here per-row since the `standing` table has no nested
// group concept. Nil for single-table competitions with no ESPN grouping.
type Standing struct {
	Team           Team    `json:"team"`
	GroupID        *string `json:"groupId"`
	GroupName      *string `json:"groupName"`
	Rank           int     `json:"rank"`
	Played         int     `json:"played"`
	Wins           int     `json:"wins"`
	Draws          int     `json:"draws"`
	Losses         int     `json:"losses"`
	GoalsFor       int     `json:"goalsFor"`
	GoalsAgainst   int     `json:"goalsAgainst"`
	GoalDifference int     `json:"goalDifference"`
	Points         int     `json:"points"`
	Advanced       bool    `json:"advanced"`
}

// TopScorer mirrors types.ts's TopScorer.
type TopScorer struct {
	Rank         int     `json:"rank"`
	Player       string  `json:"player"`
	TeamAbbr     string  `json:"teamAbbr"`
	TeamName     string  `json:"teamName"`
	TeamCrestURL *string `json:"teamCrestUrl"`
	Goals        int     `json:"goals"`
	Matches      *int    `json:"matches"`
}

// ===== MatchDetail sub-shapes (stored as jsonb) =====
// These mirror types.ts's MatchSummaryData plus the goal/card/shootout
// fields that live inline on the TS Match type. Port of providers/espn-summary.ts.

// Scorer mirrors types.ts's Scorer.
type Scorer struct {
	TeamID   string `json:"teamId"`
	Player   string `json:"player"`
	Minute   string `json:"minute"`
	Penalty  bool   `json:"penalty"`
	Shootout bool   `json:"shootout"`
}

// Card mirrors types.ts's Card.
type Card struct {
	TeamID string `json:"teamId"`
	Player string `json:"player"`
	Minute string `json:"minute"`
	Type   string `json:"type"` // "yellow" | "red"
}

// TeamStats mirrors types.ts's TeamStats.
type TeamStats struct {
	Possession     *float64 `json:"possession"`
	Shots          *float64 `json:"shots"`
	ShotsOnTarget  *float64 `json:"shotsOnTarget"`
	ShotAccuracy   *float64 `json:"shotAccuracy"`
	Corners        *float64 `json:"corners"`
	Offsides       *float64 `json:"offsides"`
	Passes         *float64 `json:"passes"`
	PassAccuracy   *float64 `json:"passAccuracy"`
	Crosses        *float64 `json:"crosses"`
	CrossAccuracy  *float64 `json:"crossAccuracy"`
	LongBalls      *float64 `json:"longBalls"`
	Tackles        *float64 `json:"tackles"`
	TackleAccuracy *float64 `json:"tackleAccuracy"`
	Interceptions  *float64 `json:"interceptions"`
	Clearances     *float64 `json:"clearances"`
	BlockedShots   *float64 `json:"blockedShots"`
	Saves          *float64 `json:"saves"`
	Fouls          *float64 `json:"fouls"`
	YellowCards    *float64 `json:"yellowCards"`
	RedCards       *float64 `json:"redCards"`
}

// MatchStats mirrors types.ts's MatchStats.
type MatchStats struct {
	Home TeamStats `json:"home"`
	Away TeamStats `json:"away"`
}

// WinProbability mirrors types.ts's WinProbability.
type WinProbability struct {
	Home float64 `json:"home"`
	Draw float64 `json:"draw"`
	Away float64 `json:"away"`
}

// Shootout mirrors types.ts's Shootout (aggregate score).
type Shootout struct {
	HomeScore int `json:"homeScore"`
	AwayScore int `json:"awayScore"`
}

// PenaltyKick mirrors types.ts's PenaltyKick.
type PenaltyKick struct {
	Order  int    `json:"order"`
	Player string `json:"player"`
	Scored bool   `json:"scored"`
}

// ShootoutDetail mirrors types.ts's ShootoutDetail (kick-by-kick).
type ShootoutDetail struct {
	Home []PenaltyKick `json:"home"`
	Away []PenaltyKick `json:"away"`
}

// LineupPlayer mirrors types.ts's LineupPlayer.
type LineupPlayer struct {
	Name     string  `json:"name"`
	Number   *int    `json:"number"`
	Position string  `json:"position"`
	Jersey   *string `json:"jersey"`
}

// TeamLineup mirrors types.ts's TeamLineup.
type TeamLineup struct {
	Formation string         `json:"formation"`
	Players   []LineupPlayer `json:"players"`
}

// MatchLineups mirrors types.ts's MatchLineups.
type MatchLineups struct {
	Home TeamLineup `json:"home"`
	Away TeamLineup `json:"away"`
}

// MatchVideo mirrors types.ts's MatchVideo.
type MatchVideo struct {
	ID        string  `json:"id"`
	Headline  string  `json:"headline"`
	Duration  *int    `json:"duration"`
	Thumbnail *string `json:"thumbnail"`
	Mp4URL    *string `json:"mp4Url"`
	IsGoal    bool    `json:"isGoal"`
}

// MatchInfo mirrors types.ts's MatchInfo.
type MatchInfo struct {
	Venue      *string `json:"venue"`
	City       *string `json:"city"`
	Referee    *string `json:"referee"`
	Attendance *int    `json:"attendance"`
}

// FormResult mirrors types.ts's FormResult.
type FormResult struct {
	Result   string `json:"result"` // "W" | "L" | "D"
	Opponent string `json:"opponent"`
	Score    string `json:"score"`
}

// MatchForm mirrors types.ts's MatchForm.
type MatchForm struct {
	Home []FormResult `json:"home"`
	Away []FormResult `json:"away"`
}

// CommentaryItem mirrors types.ts's CommentaryItem.
type CommentaryItem struct {
	Minute string `json:"minute"`
	Text   string `json:"text"`
}

// H2HMeeting mirrors types.ts's H2HMeeting.
type H2HMeeting struct {
	Date  string `json:"date"`
	Label string `json:"label"`
}

// MatchDetail is the on-demand detail fetched per match (port of
// providers/espn-summary.ts / types.ts's MatchSummaryData, plus the
// goal/card/shootout-aggregate fields inlined on the TS Match type). Stored
// as jsonb columns keyed by match id; comp/season/matchId are attached by
// the store layer (Task 6), not by the mapper (Task 3).
type MatchDetail struct {
	Scorers        []Scorer         `json:"scorers"`
	Cards          []Card           `json:"cards"`
	Shootout       *Shootout        `json:"shootout"`
	ShootoutDetail *ShootoutDetail  `json:"shootoutDetail"`
	Stats          *MatchStats      `json:"stats"`
	WinProbability *WinProbability  `json:"winProbability"`
	Lineups        *MatchLineups    `json:"lineups"`
	Videos         []MatchVideo     `json:"videos"`
	Info           *MatchInfo       `json:"info"`
	Form           *MatchForm       `json:"form"`
	Commentary     []CommentaryItem `json:"commentary"`
	H2H            []H2HMeeting     `json:"h2h"`
}
