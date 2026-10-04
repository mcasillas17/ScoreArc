package model

// Domain types persisted by the ingester. They are shaped after the frontend's
// src/server/data/types.ts (same JSON tags as the TS property names), but are
// not field-for-field identical: the remaining incompatibilities are
// characterized in src/server/data/contracts/reader-contract.json.
//
// Match here is deliberately narrower than the TS `Match` interface: comp
// and season are added by the ingester (they're not present in a single
// ESPN payload), and the "detail" fields the TS type inlines (scorers,
// cards, stats, winProbability, shootout, shootoutDetail) live instead on
// MatchDetail, stored separately as jsonb. The scoreboard and bracket mappers
// (Tasks 2, 5) fill no MatchDetail field; their own shootout evidence rides
// off the wire on Match.Shootout (and BracketMatch.Shootout) into the summary
// precedence, whose result MatchDetail stores. Match additionally carries
// Round: the bracket mapper (Task 5) tags knockout matches with a round slug (e.g.
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
	ID               string     `json:"id"`
	Kickoff          string     `json:"kickoff"` // ISO date string
	State            MatchState `json:"state"`
	Round            string     `json:"round"` // knockout round slug, e.g. "round-of-16"; "" for group stage
	Minute           *string    `json:"minute"`
	StatusDetail     string     `json:"statusDetail"`
	StatusName       string     `json:"statusName"`
	Home             Team       `json:"home"`
	Away             Team       `json:"away"`
	HomeScore        *int       `json:"homeScore"`
	AwayScore        *int       `json:"awayScore"`
	WinnerID         *string    `json:"winnerId"`
	Note             *string    `json:"note"`
	HomePlaceholder  bool       `json:"-"`
	AwayPlaceholder  bool       `json:"-"`
	BracketRequired  *bool      `json:"-"`
	BracketConfirmed bool       `json:"-"`
	// Shootout is the scoreboard's own penalty-shootout evidence (structured
	// competitor totals, else the note). It is carried to the summary mapper,
	// where the summary header outranks it; MatchDetail stores the result.
	Shootout *Shootout `json:"-"`
	// WinnerFlagID is ESPN's own winner flag, kept apart from a WinnerID a
	// decisive aggregate derived: when a higher tier's aggregate supersedes
	// that one and is level, the winner falls back to the flag.
	WinnerFlagID *string `json:"-"`
}

// BracketTeam is shaped after types.ts's BracketTeam. It is distinct from Team
// because knockout brackets can name a not-yet-determined slot ("Round of 32
// Winner 5") before the feeding match resolves; Placeholder flags that case
// so the reader can render a TBD slot instead of a real crest.
//
// A placeholder's crestUrl is null, here and in the frontend: an empty provider
// logo is no crest (T16.2).
type BracketTeam struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Abbr        string  `json:"abbr"`
	CrestURL    *string `json:"crestUrl"`
	Placeholder bool    `json:"placeholder"`
}

// BracketMatch is shaped after types.ts's BracketMatch. Round is a string here
// but takes only the OpenAPI KnockoutRound values (espn.KnockoutRounds(), the
// TS KnockoutRoundSlug union; T16.2). It is the
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
	// Shootout is the observation's structured shootout totals, carried to the
	// ingester's candidate so the summary precedence ranks them above the note.
	// Not part of the served bracket.
	Shootout *Shootout `json:"-"`
	// WinnerFlagID is ESPN's own winner flag (see Match.WinnerFlagID).
	WinnerFlagID *string `json:"-"`
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

// TopScorer is the reader's goals-only leaderboard row. The frontend has no
// TopScorer type; its StatLeader differs (gap T10.2-leaders).
type TopScorer struct {
	Rank         int     `json:"rank"`
	Player       string  `json:"player"`
	TeamAbbr     string  `json:"teamAbbr"`
	TeamName     string  `json:"teamName"`
	TeamCrestURL *string `json:"teamCrestUrl"`
	Goals        int     `json:"goals"`
	Matches      *int    `json:"matches"`
}

// StatLeader is one row of any season leaderboard.
//
// It is shaped after the TypeScript StatLeader in src/server/data/types.ts,
// without its athleteId/teamId/playerSlug (gap T10.2-leaders). The metric-specific `Goals` on
// TopScorer becomes `Value`, because a field called Goals holding an assist
// count is a lie that every reader of this struct then has to remember.
//
// TopScorer stays for now: it is the shape the reader serializes today, and
// removing it belongs to slice 1d's cutover, not here.
//
// TeamSourceID is the provider's team id, never serialized or stored: the
// ingester resolves it to the canonical team whose key its crest mirrors under.
type StatLeader struct {
	Rank         int     `json:"rank"`
	Player       string  `json:"player"`
	TeamSourceID string  `json:"-"`
	TeamAbbr     string  `json:"teamAbbr"`
	TeamName     string  `json:"teamName"`
	TeamCrestURL *string `json:"teamCrestUrl"`
	Value        int     `json:"value"`
	Matches      *int    `json:"matches"`
}

// ===== MatchDetail sub-shapes (stored as jsonb) =====
// These mirror types.ts's MatchSummaryData plus the goal/card/shootout
// fields that live inline on the TS Match type. Port of providers/espn-summary.ts.

// Scorer mirrors types.ts's Scorer except playerSlug, which the frontend's
// match route fills from AthleteID (withSummaryPlayerSlugs). match_detail
// stores the provider's team id; the reader serves the canonical side it names,
// or null (reader/attribution.go). An own goal is credited to the side that
// benefits. OwnGoal and AthleteID (the provider athlete id) are null, unknown,
// on rows stored before they were captured.
type Scorer struct {
	TeamID    *string `json:"teamId"`
	Player    string  `json:"player"`
	Minute    string  `json:"minute"`
	Penalty   bool    `json:"penalty"`
	Shootout  bool    `json:"shootout"`
	OwnGoal   *bool   `json:"ownGoal"`
	AthleteID *string `json:"athleteId"`
}

// Card mirrors types.ts's Card; TeamID is translated like Scorer's.
type Card struct {
	TeamID *string `json:"teamId"`
	Player string  `json:"player"`
	Minute string  `json:"minute"`
	Type   string  `json:"type"` // "yellow" | "red"
}

// TeamStats is shaped after types.ts's TeamStats, without the accuracy
// numerators and with provider-fraction percentages (gap T10.2-team-stats).
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

// MatchStats is shaped after types.ts's MatchStats; its TeamStats sides carry
// gap T10.2-team-stats.
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

// LineupPlayer is shaped after types.ts's LineupPlayer, without
// starter/stats/athleteId/playerSlug (gap T10.2-lineups).
type LineupPlayer struct {
	Name     string  `json:"name"`
	Number   *int    `json:"number"`
	Position string  `json:"position"`
	Jersey   *string `json:"jersey"`
}

// TeamLineup is shaped after types.ts's TeamLineup; its players carry gap
// T10.2-lineups.
type TeamLineup struct {
	Formation string         `json:"formation"`
	Players   []LineupPlayer `json:"players"`
}

// MatchLineups is shaped after types.ts's MatchLineups (gap T10.2-lineups).
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
