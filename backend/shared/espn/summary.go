package espn

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Port of src/server/data/providers/espn-summary.ts. Reads ESPN's per-match
// summary/detail payload into our MatchDetail sub-shapes: scorers, cards,
// stats, winProbability, shootoutDetail, lineups, videos, info, form,
// commentary, h2h. Unlike the TS mappers (which take a homeId/awayId the
// caller already knows from the Match row), MapSummary derives home/away
// team ids itself from the payload's header.competitions[0].competitors,
// the same home/away tagging espn-matches.ts's mapScoreboard reads.
//
// Each TS mapper wraps its body in try/catch and falls back to null/[] on
// any shape surprise; here that resilience comes from using pointer/slice
// zero values plus permissive raw types (json.RawMessage for fields the TS
// code type-checks dynamically, e.g. `typeof x === 'number'`) rather than
// letting a shape mismatch fail the whole decode.

// ===== raw ESPN summary payload shapes =====

type rawSummary struct {
	Header          rawSummaryHeader    `json:"header"`
	GameInfo        *rawGameInfo        `json:"gameInfo"`
	LastFiveGames   []rawFormGroup      `json:"lastFiveGames"`
	HeadToHeadGames []rawH2HGroup       `json:"headToHeadGames"`
	Odds            []rawOdds           `json:"odds"`
	Rosters         []rawRosterEntry    `json:"rosters"`
	Videos          []json.RawMessage   `json:"videos"`
	KeyEvents       []rawKeyEvent       `json:"keyEvents"`
	Commentary      []rawCommentaryItem `json:"commentary"`
	Boxscore        rawBoxscore         `json:"boxscore"`
	Shootout        []rawShootoutTeam   `json:"shootout"`
}

type rawSummaryHeader struct {
	ID           flexibleString         `json:"id"`
	Competitions []rawHeaderCompetition `json:"competitions"`
}

type rawHeaderCompetition struct {
	Competitors []rawHeaderCompetitor `json:"competitors"`
	ID          flexibleString        `json:"id"`
	Status      *rawStatus            `json:"status"`
}

type rawHeaderCompetitor struct {
	HomeAway      string          `json:"homeAway"`
	Team          rawTeamIDRef    `json:"team"`
	Score         *flexibleString `json:"score"`
	ShootoutScore json.RawMessage `json:"shootoutScore"`
}

// rawTeamIDRef is the recurring `{ team: { id: "..." } }` shape used across
// boxscore, rosters, lastFiveGames, and the header competitors.
type rawTeamIDRef struct {
	ID flexibleString `json:"id"`
}

type rawGameInfo struct {
	Venue      *rawVenue       `json:"venue"`
	Attendance json.RawMessage `json:"attendance"`
	Officials  []rawOfficial   `json:"officials"`
}

type rawVenue struct {
	FullName string     `json:"fullName"`
	Address  rawAddress `json:"address"`
}

type rawAddress struct {
	City string `json:"city"`
}

type rawOfficial struct {
	DisplayName string          `json:"displayName"`
	Position    rawOfficialRole `json:"position"`
}

type rawOfficialRole struct {
	DisplayName string `json:"displayName"`
	Name        string `json:"name"`
}

type rawFormGroup struct {
	Team   rawTeamIDRef   `json:"team"`
	Events []rawFormEvent `json:"events"`
}

type rawFormEvent struct {
	HomeTeamID    string          `json:"homeTeamId"`
	AwayTeamID    string          `json:"awayTeamId"`
	HomeTeamScore json.RawMessage `json:"homeTeamScore"`
	AwayTeamScore json.RawMessage `json:"awayTeamScore"`
	GameResult    string          `json:"gameResult"`
	Opponent      rawOpponentRef  `json:"opponent"`
}

type rawOpponentRef struct {
	Abbreviation string `json:"abbreviation"`
}

type rawH2HGroup struct {
	Team   rawH2HTeamRef `json:"team"`
	Events []rawH2HEvent `json:"events"`
}

type rawH2HTeamRef struct {
	ID           string `json:"id"`
	Abbreviation string `json:"abbreviation"`
}

type rawH2HEvent struct {
	GameDate      string          `json:"gameDate"`
	HomeTeamID    string          `json:"homeTeamId"`
	HomeTeamScore json.RawMessage `json:"homeTeamScore"`
	AwayTeamScore json.RawMessage `json:"awayTeamScore"`
	Opponent      rawOpponentRef  `json:"opponent"`
}

type rawOdds struct {
	HomeTeamOdds rawTeamOdds  `json:"homeTeamOdds"`
	AwayTeamOdds rawTeamOdds  `json:"awayTeamOdds"`
	DrawOdds     rawMoneyLine `json:"drawOdds"`
}

type rawTeamOdds struct {
	MoneyLine *float64   `json:"moneyLine"`
	Team      rawTeamRef `json:"team"`
}

type rawMoneyLine struct {
	MoneyLine *float64 `json:"moneyLine"`
}

// rawTeamRef is odds' `{ team: { $ref: ".../teams/{id}?..." } }` — the
// betting provider's own home/away leg, resolved to a team id by regex
// since the API only gives us a self-link, not the id directly.
type rawTeamRef struct {
	Ref string `json:"$ref"`
}

type rawRosterEntry struct {
	Team      rawTeamIDRef      `json:"team"`
	Formation string            `json:"formation"`
	Roster    []rawRosterPlayer `json:"roster"`
}

type rawRosterPlayer struct {
	Starter  bool        `json:"starter"`
	Jersey   string      `json:"jersey"`
	Athlete  rawAthlete  `json:"athlete"`
	Position rawPosition `json:"position"`
}

type rawAthlete struct {
	// ID is what makes a player a person rather than a string. ESPN sends it on
	// every roster entry; before it was declared here encoding/json discarded it
	// silently, which is why nothing downstream could identify a player.
	ID           flexibleString   `json:"id"`
	DisplayName  string           `json:"displayName"`
	JerseyImages []rawJerseyImage `json:"jerseyImages"`
}

type rawJerseyImage struct {
	Href string   `json:"href"`
	Rel  []string `json:"rel"`
}

type rawPosition struct {
	Abbreviation string `json:"abbreviation"`
}

type rawKeyEvent struct {
	Type         rawEventType     `json:"type"`
	Clock        rawClock         `json:"clock"`
	ScoringPlay  bool             `json:"scoringPlay"`
	Team         *rawTeamIDRef    `json:"team"`
	Participants []rawParticipant `json:"participants"`
	PenaltyKick  bool             `json:"penaltyKick"`
	Shootout     bool             `json:"shootout"`
}

type rawEventType struct {
	Text string `json:"text"`
	// Type is ESPN's stable machine value ("goal", "yellow-card",
	// "substitution"). The legacy scorer/card mappers below classify by regex
	// over Text, which is English display prose; new code should prefer this.
	Type string `json:"type"`
}

type rawClock struct {
	// ESPN serializes whole-second values as JSON decimals (for example 0.0).
	// A pointer preserves a missing measurement instead of inventing zero.
	Value        *float64 `json:"value"`
	DisplayValue string   `json:"displayValue"`
}

type rawParticipant struct {
	Athlete rawAthleteName `json:"athlete"`
}

type rawAthleteName struct {
	ID          flexibleString `json:"id"`
	DisplayName string         `json:"displayName"`
}

type rawCommentaryItem struct {
	// A pointer distinguishes ESPN's real sequence 0 from a missing sequence.
	Sequence *int               `json:"sequence"`
	Time     rawClock           `json:"time"`
	Text     string             `json:"text"`
	Play     *rawCommentaryPlay `json:"play"`
}

// T7.12's play-stream branch will share these two provider shapes once it
// lands. They live here meanwhile because this branch starts from main and must
// preserve missing numeric fields as NULL rather than zero.
type rawPlayType struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Type string `json:"type"`
}

type rawPeriod struct {
	Number *int `json:"number"`
}

// rawCommentaryPlay is the structure attached to 86 of the recorded fixture's
// 91 lines. A pointer on rawCommentaryItem keeps the other 5 distinguishable
// from a measured period or clock of zero.
type rawCommentaryPlay struct {
	ID        string      `json:"id"`
	Type      rawPlayType `json:"type"`
	Period    rawPeriod   `json:"period"`
	Clock     rawClock    `json:"clock"`
	Wallclock string      `json:"wallclock"`
}

type rawBoxscore struct {
	Teams []rawBoxscoreTeam `json:"teams"`
}

type rawBoxscoreTeam struct {
	Team       rawTeamIDRef   `json:"team"`
	Statistics []rawStatEntry `json:"statistics"`
}

type rawStatEntry struct {
	Name         string `json:"name"`
	DisplayValue string `json:"displayValue"`
}

type rawShootoutTeam struct {
	ID    string         `json:"id"`
	Shots []rawShotEntry `json:"shots"`
}

type rawShotEntry struct {
	ShotNumber int    `json:"shotNumber"`
	Player     string `json:"player"`
	DidScore   bool   `json:"didScore"`
}

// rawVideoMeta covers the fields mapSummaryVideos reads off each video
// object directly; pickMp4 separately walks the *whole* raw video object
// (see below), since ESPN nests candidate mp4 urls at varying depths.
type rawVideoMeta struct {
	ID        json.RawMessage `json:"id"`
	CerebroID *string         `json:"cerebroId"`
	Headline  string          `json:"headline"`
	Duration  json.RawMessage `json:"duration"`
	Thumbnail *string         `json:"thumbnail"`
}

// parseRawSummary decodes raw ESPN summary JSON into rawSummary.
func parseRawSummary(raw []byte, out *rawSummary) error {
	return json.Unmarshal(raw, out)
}

// MapSummary ports providers/espn-summary.ts's collection of mapSummary*
// functions into a single MatchDetail. Home/away team ids are derived from
// the payload's header (mirroring how espn-matches.ts tags competitors),
// then threaded into every sub-mapper that needs to orient itself to OUR
// home/away rather than ESPN's.
func MapSummary(raw []byte) (MatchDetail, error) {
	var rs rawSummary
	if err := parseRawSummary(raw, &rs); err != nil {
		return MatchDetail{}, err
	}

	homeID, awayID := headerTeamIDs(rs)

	return MatchDetail{
		Scorers:        mapSummaryScorers(rs),
		Cards:          mapSummaryCards(rs),
		Shootout:       mapSummaryShootout(rs),
		ShootoutDetail: mapSummaryShootoutDetail(rs, homeID, awayID),
		Stats:          mapSummaryStats(rs, homeID, awayID),
		WinProbability: mapWinProbability(rs, homeID, awayID),
		Lineups:        mapSummaryLineups(rs, homeID, awayID),
		Videos:         mapSummaryVideos(rs),
		Info:           mapSummaryInfo(rs),
		Form:           mapSummaryForm(rs, homeID, awayID),
		Commentary:     mapSummaryCommentary(rs),
		H2H:            mapSummaryH2H(rs),
	}, nil
}

// ValidateSummary rejects structurally incomplete payloads before persistence.
func ValidateSummary(
	raw []byte,
	expectedMatchID, expectedHomeID, expectedAwayID string,
	requireFinal bool,
) error {
	var rs rawSummary
	if err := parseRawSummary(raw, &rs); err != nil {
		return err
	}

	if string(rs.Header.ID) != expectedMatchID || len(rs.Header.Competitions) == 0 ||
		string(rs.Header.Competitions[0].ID) != expectedMatchID {
		return fmt.Errorf("summary event identity does not match %q", expectedMatchID)
	}
	homeID, awayID := headerTeamIDs(rs)
	if homeID != expectedHomeID || awayID != expectedAwayID {
		return fmt.Errorf("summary teams do not match event %q", expectedMatchID)
	}
	if requireFinal {
		detail, err := MapSummary(raw)
		if err != nil {
			return err
		}
		if !hasSummaryDetail(detail) {
			return fmt.Errorf("final summary contains no detail sections")
		}
		competition := rs.Header.Competitions[0]
		if competition.Status == nil || !competition.Status.Type.Completed {
			return fmt.Errorf("summary event %q is not complete", expectedMatchID)
		}
		var homeScore, awayScore *flexibleString
		for _, competitor := range competition.Competitors {
			switch competitor.HomeAway {
			case "home":
				homeScore = competitor.Score
			case "away":
				awayScore = competitor.Score
			}
		}
		if scoreOf(homeScore) == nil || scoreOf(awayScore) == nil {
			return fmt.Errorf("summary event %q lacks final scores", expectedMatchID)
		}
	}
	return nil
}

func hasSummaryDetail(detail MatchDetail) bool {
	return len(detail.Scorers) > 0 ||
		len(detail.Cards) > 0 ||
		detail.Shootout != nil ||
		(detail.ShootoutDetail != nil &&
			(len(detail.ShootoutDetail.Home) > 0 || len(detail.ShootoutDetail.Away) > 0)) ||
		(detail.Stats != nil && !reflect.DeepEqual(*detail.Stats, MatchStats{})) ||
		(detail.WinProbability != nil &&
			!reflect.DeepEqual(*detail.WinProbability, WinProbability{})) ||
		(detail.Lineups != nil && !reflect.DeepEqual(*detail.Lineups, MatchLineups{})) ||
		len(detail.Videos) > 0 ||
		(detail.Info != nil && !reflect.DeepEqual(*detail.Info, MatchInfo{})) ||
		(detail.Form != nil &&
			(len(detail.Form.Home) > 0 || len(detail.Form.Away) > 0)) ||
		len(detail.Commentary) > 0 ||
		len(detail.H2H) > 0
}

func SummaryFinalScores(raw []byte) (*int, *int, error) {
	var summary rawSummary
	if err := parseRawSummary(raw, &summary); err != nil {
		return nil, nil, err
	}
	if len(summary.Header.Competitions) == 0 {
		return nil, nil, fmt.Errorf("summary missing competition")
	}
	var homeScore, awayScore *int
	for _, competitor := range summary.Header.Competitions[0].Competitors {
		switch competitor.HomeAway {
		case "home":
			homeScore = scoreOf(competitor.Score)
		case "away":
			awayScore = scoreOf(competitor.Score)
		}
	}
	if homeScore == nil || awayScore == nil {
		return nil, nil, fmt.Errorf("summary missing final scores")
	}
	return homeScore, awayScore, nil
}

func ParseShootoutNote(note, homeName, awayName string) *Shootout {
	match := shootoutNoteRe.FindStringSubmatch(note)
	if match == nil {
		return nil
	}
	first, firstErr := strconv.Atoi(match[1])
	second, secondErr := strconv.Atoi(match[2])
	if firstErr != nil || secondErr != nil {
		return nil
	}
	winner, loser := max(first, second), min(first, second)
	winnerMatch := shootoutWinnerRe.FindStringSubmatch(note)
	if winnerMatch == nil {
		return nil
	}
	winnerName := strings.TrimSpace(winnerMatch[1])
	switch {
	case homeName != "" && strings.EqualFold(winnerName, strings.TrimSpace(homeName)):
		return &Shootout{HomeScore: winner, AwayScore: loser}
	case awayName != "" && strings.EqualFold(winnerName, strings.TrimSpace(awayName)):
		return &Shootout{HomeScore: loser, AwayScore: winner}
	default:
		return nil
	}
}

func mapSummaryShootout(rs rawSummary) *Shootout {
	if len(rs.Header.Competitions) == 0 {
		return nil
	}
	var home, away float64
	var homeOK, awayOK bool
	for _, competitor := range rs.Header.Competitions[0].Competitors {
		score, ok := jsNumber(competitor.ShootoutScore)
		switch competitor.HomeAway {
		case "home":
			home, homeOK = score, ok
		case "away":
			away, awayOK = score, ok
		}
	}
	if !homeOK || !awayOK || (home == 0 && away == 0) {
		return nil
	}
	return &Shootout{HomeScore: int(home), AwayScore: int(away)}
}

// headerTeamIDs reads OUR home/away team ids off
// header.competitions[0].competitors, the same homeAway tagging
// espn-matches.ts's mapScoreboard reads off the scoreboard payload.
func headerTeamIDs(rs rawSummary) (homeID, awayID string) {
	if len(rs.Header.Competitions) == 0 {
		return "", ""
	}
	for _, c := range rs.Header.Competitions[0].Competitors {
		switch c.HomeAway {
		case "home":
			homeID = string(c.Team.ID)
		case "away":
			awayID = string(c.Team.ID)
		}
	}
	return homeID, awayID
}

var refereeRe = regexp.MustCompile(`(?i)referee`)
var shootoutNoteRe = regexp.MustCompile(`(?i)(\d+)\s*[-–]\s*(\d+)\s+on penalties`)
var shootoutWinnerRe = regexp.MustCompile(`(?i)^\s*(.+?)\s+(?:advances?|wins?)\b`)

// mapSummaryInfo ports mapSummaryInfo: venue, city, referee and attendance
// from summary.gameInfo.
func mapSummaryInfo(rs rawSummary) *MatchInfo {
	gi := rs.GameInfo
	if gi == nil {
		return nil
	}

	var venue, city *string
	if gi.Venue != nil {
		if gi.Venue.FullName != "" {
			v := gi.Venue.FullName
			venue = &v
		}
		if gi.Venue.Address.City != "" {
			c := gi.Venue.Address.City
			city = &c
		}
	}

	var referee *string
	for _, o := range gi.Officials {
		posText := o.Position.DisplayName
		if posText == "" {
			posText = o.Position.Name
		}
		if refereeRe.MatchString(posText) {
			r := o.DisplayName
			referee = &r
			break
		}
	}

	var attendance *int
	if n, ok := asNumber(gi.Attendance); ok {
		a := int(n)
		attendance = &a
	}

	if venue == nil && referee == nil && attendance == nil {
		return nil
	}
	return &MatchInfo{Venue: venue, City: city, Referee: referee, Attendance: attendance}
}

// mapFormEvents ports mapFormEvents: a team's last 5 results as W/L/D +
// opponent + score, oriented to that team (not necessarily OUR home/away).
func mapFormEvents(entry rawFormGroup) []FormResult {
	teamID := string(entry.Team.ID)
	events := entry.Events
	if len(events) > 5 {
		events = events[:5]
	}
	out := make([]FormResult, 0, len(events))
	for _, e := range events {
		home := e.HomeTeamID == teamID
		gf, ga := e.AwayTeamScore, e.HomeTeamScore
		if home {
			gf, ga = e.HomeTeamScore, e.AwayTeamScore
		}
		res := "D"
		if e.GameResult == "W" || e.GameResult == "L" {
			res = e.GameResult
		}
		out = append(out, FormResult{
			Result:   res,
			Opponent: e.Opponent.Abbreviation,
			Score:    scoreString(gf) + "-" + scoreString(ga),
		})
	}
	return out
}

// mapSummaryForm ports mapSummaryForm: each team's last-5 form from
// summary.lastFiveGames, mapped to home/away by id.
func mapSummaryForm(rs rawSummary, homeID, awayID string) *MatchForm {
	var homeEntry, awayEntry *rawFormGroup
	for i := range rs.LastFiveGames {
		if string(rs.LastFiveGames[i].Team.ID) == homeID {
			homeEntry = &rs.LastFiveGames[i]
		}
		if string(rs.LastFiveGames[i].Team.ID) == awayID {
			awayEntry = &rs.LastFiveGames[i]
		}
	}
	if homeEntry == nil && awayEntry == nil {
		return nil
	}
	form := &MatchForm{Home: []FormResult{}, Away: []FormResult{}}
	if homeEntry != nil {
		form.Home = mapFormEvents(*homeEntry)
	}
	if awayEntry != nil {
		form.Away = mapFormEvents(*awayEntry)
	}
	return form
}

// mapSummaryCommentary ports mapSummaryCommentary: minute-by-minute
// commentary from summary.commentary, dropping empty-text entries.
func mapSummaryCommentary(rs rawSummary) []CommentaryItem {
	out := make([]CommentaryItem, 0, len(rs.Commentary))
	for _, c := range rs.Commentary {
		if c.Text == "" {
			continue
		}
		out = append(out, CommentaryItem{Minute: c.Time.DisplayValue, Text: c.Text})
	}
	return out
}

// mapSummaryH2H ports mapSummaryH2H: recent head-to-head meetings from
// summary.headToHeadGames. The single group is keyed on a reference `team`;
// events carry home/away ids + the `opponent`.
func mapSummaryH2H(rs rawSummary) []H2HMeeting {
	out := []H2HMeeting{}
	if len(rs.HeadToHeadGames) == 0 {
		return out
	}
	group := rs.HeadToHeadGames[0]
	refID := group.Team.ID
	refAbbr := group.Team.Abbreviation
	events := group.Events
	if len(events) > 5 {
		events = events[:5]
	}
	for _, e := range events {
		oppAbbr := e.Opponent.Abbreviation
		homeIsRef := e.HomeTeamID == refID
		homeAbbr, awayAbbr := oppAbbr, refAbbr
		if homeIsRef {
			homeAbbr, awayAbbr = refAbbr, oppAbbr
		}
		score := scoreString(e.HomeTeamScore) + "-" + scoreString(e.AwayTeamScore)
		label := strings.TrimSpace(homeAbbr + " " + score + " " + awayAbbr)
		out = append(out, H2HMeeting{Date: e.GameDate, Label: label})
	}
	return out
}

// mapSummaryShootoutDetail ports mapSummaryShootout: kick-by-kick penalty
// shootout from summary.shootout (per-team `shots` with `didScore`), mapped
// to OUR home/away by team id. nil when no shootout.
func mapSummaryShootoutDetail(rs rawSummary, homeID, awayID string) *ShootoutDetail {
	teams := rs.Shootout
	if len(teams) < 2 {
		return nil
	}
	var homeEntry, awayEntry *rawShootoutTeam
	for i := range teams {
		if teams[i].ID == homeID {
			homeEntry = &teams[i]
		}
		if teams[i].ID == awayID {
			awayEntry = &teams[i]
		}
	}
	if homeEntry == nil || awayEntry == nil {
		return nil
	}
	kicksOf := func(entry *rawShootoutTeam) []PenaltyKick {
		out := make([]PenaltyKick, 0, len(entry.Shots))
		for _, s := range entry.Shots {
			out = append(out, PenaltyKick{Order: s.ShotNumber, Player: s.Player, Scored: s.DidScore})
		}
		return out
	}
	home := kicksOf(homeEntry)
	away := kicksOf(awayEntry)
	if len(home) == 0 && len(away) == 0 {
		return nil
	}
	return &ShootoutDetail{Home: home, Away: away}
}

// goalRe flags a video as a "goal" clip (vs. analysis/interview/presser)
// when the headline mentions scoring, keeping goal highlights sortable to
// the front.
var goalRe = regexp.MustCompile(`(?i)\b(goals?|scores?|scored|winner|equali[sz]er|penalt|hat[- ]?trick|brace|strike)\b`)

var (
	mp4URLRe = regexp.MustCompile(`(?i)^https?://[^"']+\.mp4(\?|$)`)
	p720Re   = regexp.MustCompile(`(?i)720p`)
	p540Re   = regexp.MustCompile(`(?i)540p|360p`)
)

// pickMp4 ports pickMp4: picks a progressive MP4 that plays directly in an
// HTML5 <video> (prefer 720p, then any .mp4). ESPN nests candidate URLs
// across links/source, so this scans the whole video object.
func pickMp4(rawVideo json.RawMessage) *string {
	var v interface{}
	if err := json.Unmarshal(rawVideo, &v); err != nil {
		return nil
	}
	var urls []string
	var walk func(v interface{})
	walk = func(v interface{}) {
		switch x := v.(type) {
		case string:
			if mp4URLRe.MatchString(x) {
				urls = append(urls, x)
			}
		case []interface{}:
			for _, e := range x {
				walk(e)
			}
		case map[string]interface{}:
			for _, e := range x {
				walk(e)
			}
		}
	}
	walk(v)
	if len(urls) == 0 {
		return nil
	}
	for _, u := range urls {
		if p720Re.MatchString(u) {
			r := u
			return &r
		}
	}
	for _, u := range urls {
		if p540Re.MatchString(u) {
			r := u
			return &r
		}
	}
	r := urls[0]
	return &r
}

// mapSummaryVideos ports mapSummaryVideos: maps summary.videos into
// MatchVideo, dropping clips with no playable mp4 and sorting goal clips
// first (stable within each group, otherwise ESPN's order).
func mapSummaryVideos(rs rawSummary) []MatchVideo {
	type indexed struct {
		v MatchVideo
		i int
	}
	mapped := make([]indexed, 0, len(rs.Videos))
	for i, raw := range rs.Videos {
		var meta rawVideoMeta
		if err := json.Unmarshal(raw, &meta); err != nil {
			continue
		}
		mp4 := pickMp4(raw)
		if mp4 == nil {
			continue
		}
		headline := meta.Headline
		id := headline
		if len(meta.ID) > 0 && string(meta.ID) != "null" {
			id = jsonScalarToString(meta.ID)
		} else if meta.CerebroID != nil {
			id = *meta.CerebroID
		}
		var duration *int
		if n, ok := asNumber(meta.Duration); ok {
			d := int(n)
			duration = &d
		}
		mapped = append(mapped, indexed{
			v: MatchVideo{
				ID:        id,
				Headline:  headline,
				Duration:  duration,
				Thumbnail: meta.Thumbnail,
				Mp4URL:    mp4,
				IsGoal:    goalRe.MatchString(headline),
			},
			i: i,
		})
	}
	sort.SliceStable(mapped, func(a, b int) bool {
		if mapped[a].v.IsGoal != mapped[b].v.IsGoal {
			return mapped[a].v.IsGoal // goal clips first
		}
		return mapped[a].i < mapped[b].i
	})
	out := make([]MatchVideo, 0, len(mapped))
	for _, m := range mapped {
		out = append(out, m.v)
	}
	return out
}

// leadingFloatRe mirrors JS's parseFloat: an optional sign, digits with an
// optional decimal point, optional exponent — parsed from the start of the
// string and ignoring any trailing non-numeric characters.
var leadingFloatRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`)

// parseStat ports parseStat: finds a named stat and parseFloat()s its
// displayValue, matching JS's tolerance of trailing non-numeric characters.
func parseStat(stats []rawStatEntry, name string) *float64 {
	for _, s := range stats {
		if s.Name != name {
			continue
		}
		m := leadingFloatRe.FindString(strings.TrimSpace(s.DisplayValue))
		if m == "" {
			return nil
		}
		f, err := strconv.ParseFloat(m, 64)
		if err != nil {
			return nil
		}
		return &f
	}
	return nil
}

// parsePct ports parsePct: accuracy stats (passPct, shotPct, …) arrive as
// 0-1 fractions from ESPN, unlike possessionPct which is already 0-100.
// Normalizes to a 0-100 percent.
func parsePct(stats []rawStatEntry, name string) *float64 {
	v := parseStat(stats, name)
	if v == nil {
		return nil
	}
	r := math.Round(*v * 100)
	return &r
}

// moneylineToProb ports moneylineToProb: American moneyline -> implied
// probability (0..1).
func moneylineToProb(ml *float64) (float64, bool) {
	if ml == nil {
		return 0, false
	}
	m := *ml
	if m > 0 {
		return 100 / (m + 100), true
	}
	return -m / (-m + 100), true
}

var teamRefIDRe = regexp.MustCompile(`/teams/(\d+)`)

// teamIdFromRef ports teamIdFromRef: extracts the numeric team id out of an
// odds leg's `{ team: { $ref } }` self-link.
func teamIdFromRef(ref string) string {
	m := teamRefIDRe.FindStringSubmatch(ref)
	if m == nil {
		return ""
	}
	return m[1]
}

// mapWinProbability ports mapWinProbability: market-implied win/draw/win
// probability from the first betting provider's moneylines, with the
// bookmaker margin removed (normalised to 100). Mapped to OUR home/away by
// team id. nil if no usable 3-way moneyline is present.
func mapWinProbability(rs rawSummary, homeID, awayID string) *WinProbability {
	for _, o := range rs.Odds {
		pHome, okHome := moneylineToProb(o.HomeTeamOdds.MoneyLine)
		pAway, okAway := moneylineToProb(o.AwayTeamOdds.MoneyLine)
		pDraw, okDraw := moneylineToProb(o.DrawOdds.MoneyLine)
		if !okHome || !okAway || !okDraw {
			continue
		}

		ourHome, ourAway := pHome, pAway
		homeLegID := teamIdFromRef(o.HomeTeamOdds.Team.Ref)
		if homeLegID != "" && homeLegID == awayID {
			ourHome, ourAway = pAway, pHome
		}

		total := ourHome + ourAway + pDraw
		if total <= 0 {
			continue
		}
		return &WinProbability{
			Home: math.Round(ourHome/total*1000) / 10,
			Draw: math.Round(pDraw/total*1000) / 10,
			Away: math.Round(ourAway/total*1000) / 10,
		}
	}
	return nil
}

// buildTeamStats ports buildTeamStats: pulls the fixed stat set out of a
// boxscore team's `statistics` array.
func buildTeamStats(stats []rawStatEntry) TeamStats {
	return TeamStats{
		Possession:     parseStat(stats, "possessionPct"),
		Shots:          parseStat(stats, "totalShots"),
		ShotsOnTarget:  parseStat(stats, "shotsOnTarget"),
		ShotAccuracy:   parsePct(stats, "shotPct"),
		Corners:        parseStat(stats, "wonCorners"),
		Offsides:       parseStat(stats, "offsides"),
		Passes:         parseStat(stats, "totalPasses"),
		PassAccuracy:   parsePct(stats, "passPct"),
		Crosses:        parseStat(stats, "totalCrosses"),
		CrossAccuracy:  parsePct(stats, "crossPct"),
		LongBalls:      parseStat(stats, "totalLongBalls"),
		Tackles:        parseStat(stats, "totalTackles"),
		TackleAccuracy: parsePct(stats, "tacklePct"),
		Interceptions:  parseStat(stats, "interceptions"),
		Clearances:     parseStat(stats, "totalClearance"),
		BlockedShots:   parseStat(stats, "blockedShots"),
		Saves:          parseStat(stats, "saves"),
		Fouls:          parseStat(stats, "foulsCommitted"),
		YellowCards:    parseStat(stats, "yellowCards"),
		RedCards:       parseStat(stats, "redCards"),
	}
}

// mapSummaryStats ports mapSummaryStats: boxscore.teams[] mapped to OUR
// home/away by team id.
func mapSummaryStats(rs rawSummary, homeID, awayID string) *MatchStats {
	teams := rs.Boxscore.Teams
	if len(teams) < 2 {
		return nil
	}
	var homeEntry, awayEntry *rawBoxscoreTeam
	for i := range teams {
		if string(teams[i].Team.ID) == homeID {
			homeEntry = &teams[i]
		}
		if string(teams[i].Team.ID) == awayID {
			awayEntry = &teams[i]
		}
	}
	if homeEntry == nil || awayEntry == nil {
		return nil
	}
	stats := &MatchStats{
		Home: buildTeamStats(homeEntry.Statistics),
		Away: buildTeamStats(awayEntry.Statistics),
	}
	if reflect.DeepEqual(*stats, MatchStats{}) {
		return nil
	}
	return stats
}

// mapSummaryScorers ports mapSummaryScorers: goal events from
// summary.keyEvents.
func mapSummaryScorers(rs rawSummary) []Scorer {
	out := make([]Scorer, 0)
	for _, e := range rs.KeyEvents {
		if !e.ScoringPlay || e.Team == nil || e.Team.ID == "" {
			continue
		}
		out = append(out, Scorer{
			TeamID:   string(e.Team.ID),
			Player:   participantName(e.Participants),
			Minute:   e.Clock.DisplayValue,
			Penalty:  e.PenaltyKick,
			Shootout: e.Shootout,
		})
	}
	return out
}

var (
	cardTypeRe = regexp.MustCompile(`(?i)card`)
	redCardRe  = regexp.MustCompile(`(?i)red`)
)

// mapSummaryCards ports mapSummaryCards: yellow / red cards from the
// summary keyEvents (same shape as goals). "Yellow Red Card" (second yellow
// -> sending off) counts as a red.
func mapSummaryCards(rs rawSummary) []Card {
	out := make([]Card, 0)
	for _, e := range rs.KeyEvents {
		if !cardTypeRe.MatchString(e.Type.Text) || e.Team == nil || e.Team.ID == "" {
			continue
		}
		cardType := "yellow"
		if redCardRe.MatchString(e.Type.Text) {
			cardType = "red"
		}
		out = append(out, Card{
			TeamID: string(e.Team.ID),
			Player: participantName(e.Participants),
			Minute: e.Clock.DisplayValue,
			Type:   cardType,
		})
	}
	return out
}

func participantName(participants []rawParticipant) string {
	if len(participants) == 0 {
		return ""
	}
	return participants[0].Athlete.DisplayName
}

// jerseyImage ports jerseyImage: picks the light-mode player kit image from
// ESPN's jerseyImages list.
func jerseyImage(images []rawJerseyImage) *string {
	if len(images) == 0 {
		return nil
	}
	light := &images[0]
	for i := range images {
		isDark := false
		for _, rel := range images[i].Rel {
			if rel == "dark" {
				isDark = true
				break
			}
		}
		if !isDark {
			light = &images[i]
			break
		}
	}
	if light.Href == "" {
		return nil
	}
	href := light.Href
	return &href
}

// mapSummaryLineups ports mapSummaryLineups: starting XI + formation from
// summary.rosters, mapped to OUR home/away by team id. Rosters can be
// present before lineups are published (no starters yet) — that's treated
// as "no lineup" so the UI doesn't render an empty XI.
func mapSummaryLineups(rs rawSummary, homeID, awayID string) *MatchLineups {
	var homeEntry, awayEntry *rawRosterEntry
	for i := range rs.Rosters {
		if string(rs.Rosters[i].Team.ID) == homeID {
			homeEntry = &rs.Rosters[i]
		}
		if string(rs.Rosters[i].Team.ID) == awayID {
			awayEntry = &rs.Rosters[i]
		}
	}
	if homeEntry == nil || awayEntry == nil {
		return nil
	}

	toTeamLineup := func(entry *rawRosterEntry) TeamLineup {
		players := make([]LineupPlayer, 0)
		for _, p := range entry.Roster {
			if !p.Starter {
				continue
			}
			var number *int
			if p.Jersey != "" {
				if n, err := strconv.Atoi(p.Jersey); err == nil {
					number = &n
				}
			}
			players = append(players, LineupPlayer{
				Name:     p.Athlete.DisplayName,
				Number:   number,
				Position: p.Position.Abbreviation,
				Jersey:   jerseyImage(p.Athlete.JerseyImages),
			})
		}
		return TeamLineup{Formation: entry.Formation, Players: players}
	}

	home := toTeamLineup(homeEntry)
	away := toTeamLineup(awayEntry)
	if len(home.Players) == 0 || len(away.Players) == 0 {
		return nil
	}
	return &MatchLineups{Home: home, Away: away}
}

// asNumber reports whether raw holds a JSON number (as opposed to a string,
// bool, object, missing field, or JSON null) and its value — mirroring the
// TS mappers' `typeof x === 'number'` checks (e.g. gameInfo.attendance,
// video.duration).
func asNumber(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, false
	}
	var v float64
	if err := json.Unmarshal([]byte(trimmed), &v); err != nil {
		return 0, false
	}
	return v, true
}

// scoreString ports the `${gf ?? 0}` template interpolation used by
// mapFormEvents/mapSummaryH2H: renders a raw JSON scalar (string or number,
// ESPN uses both across endpoints) as plain text, defaulting to "0" when
// missing or null.
func scoreString(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return "0"
	}
	var s string
	if err := json.Unmarshal([]byte(trimmed), &s); err == nil {
		return s
	}
	return trimmed
}

// jsonScalarToString ports `String(v.id)`: renders a raw JSON scalar
// (string or number) as plain text.
func jsonScalarToString(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	var s string
	if err := json.Unmarshal([]byte(trimmed), &s); err == nil {
		return s
	}
	return trimmed
}
