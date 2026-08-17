package espn

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// FetchPlaysPage retrieves one page. Exported so the retention probe can ask
// for page one without pulling the whole stream.
func FetchPlaysPage(
	ctx context.Context,
	client *Client,
	slug, eventID string,
	page int,
) (model.PlayStream, error) {
	if client == nil {
		return model.PlayStream{}, fmt.Errorf("fetch plays page: client is required")
	}
	if slug == "" {
		return model.PlayStream{}, fmt.Errorf("fetch plays page: competition slug is required")
	}
	if eventID == "" {
		return model.PlayStream{}, fmt.Errorf("fetch plays page: event id is required")
	}
	if page < 1 {
		return model.PlayStream{}, fmt.Errorf("fetch plays page: page must be at least 1")
	}
	var raw json.RawMessage
	if err := client.GetJSON(
		ctx,
		CorePlaysURL(slug, eventID, page, corePlayPageLimit),
		&raw,
	); err != nil {
		return model.PlayStream{}, fmt.Errorf(
			"fetch plays event %s page %d: %w", eventID, page, err)
	}
	stream, err := MapPlays(raw)
	if err != nil {
		return model.PlayStream{}, fmt.Errorf(
			"map plays event %s page %d: %w", eventID, page, err)
	}
	if stream.Total == 0 && stream.PageCount == 0 && len(stream.Plays) == 0 {
		return stream, nil
	}
	if stream.PageSize != corePlayPageLimit {
		return model.PlayStream{}, fmt.Errorf(
			"espn plays %s: requested page size %d, provider returned %d",
			eventID, corePlayPageLimit, stream.PageSize)
	}
	if stream.PageIndex != page {
		return model.PlayStream{}, fmt.Errorf(
			"espn plays %s: requested page index %d, provider returned %d",
			eventID, page, stream.PageIndex)
	}
	return stream, nil
}

type rawPlayPage struct {
	Count     int       `json:"count"`
	PageIndex int       `json:"pageIndex"`
	PageSize  int       `json:"pageSize"`
	PageCount int       `json:"pageCount"`
	Items     []rawPlay `json:"items"`
}

type rawPlay struct {
	ID   string      `json:"id"`
	Type rawPlayType `json:"type"`
	Text string      `json:"text"`

	// $ref-bearing objects. We read the ref STRING and parse it; we never
	// follow it. See RefID for the arithmetic on why.
	Team         *rawRef              `json:"team"`
	Participants []rawPlayParticipant `json:"participants"`

	// rawPeriod and rawClock are shared with commentary mapping. Their pointer
	// numerics preserve an omitted provider measurement as NULL.
	Period rawPeriod `json:"period"`
	Clock  rawClock  `json:"clock"`

	HomeScore   *int   `json:"homeScore"`
	AwayScore   *int   `json:"awayScore"`
	ScoringPlay bool   `json:"scoringPlay"`
	ScoreValue  *int   `json:"scoreValue"`
	Wallclock   string `json:"wallclock"`

	OwnGoal      bool `json:"ownGoal"`
	PenaltyKick  bool `json:"penaltyKick"`
	YellowCard   bool `json:"yellowCard"`
	RedCard      bool `json:"redCard"`
	Substitution bool `json:"substitution"`
	Shootout     bool `json:"shootout"`

	FieldPositionX  *float64 `json:"fieldPositionX"`
	FieldPositionY  *float64 `json:"fieldPositionY"`
	FieldPosition2X *float64 `json:"fieldPosition2X"`
	FieldPosition2Y *float64 `json:"fieldPosition2Y"`
	GoalPositionY   *float64 `json:"goalPositionY"`
	GoalPositionZ   *float64 `json:"goalPositionZ"`
}

type rawRef struct {
	Ref string `json:"$ref"`
}

type rawPlayParticipant struct {
	Athlete rawRef `json:"athlete"`
	Order   int    `json:"order"`
	Type    string `json:"type"`
}

// MapPlays turns one page of the core API's play stream into domain Plays.
//
// It does NOT fetch anything. Every id it produces is parsed out of a $ref
// string already in the payload.
func MapPlays(raw []byte) (model.PlayStream, error) {
	var page rawPlayPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return model.PlayStream{}, fmt.Errorf("decode play stream: %w", err)
	}
	if err := validatePlayPage(page); err != nil {
		return model.PlayStream{}, err
	}

	stream := model.PlayStream{
		Total:     page.Count,
		PageIndex: page.PageIndex,
		PageSize:  page.PageSize,
		PageCount: page.PageCount,
		Plays:     make([]model.Play, 0, len(page.Items)),
	}
	// Provider order is the match's order. The ordinal is offset by the page
	// so page two continues page one rather than restarting.
	base := (page.PageIndex - 1) * page.PageSize
	for index, item := range page.Items {
		if item.ID == "" {
			return model.PlayStream{}, fmt.Errorf("play %d: missing provider id", base+index)
		}
		period, err := mapPlayPeriod(item.Period.Number)
		if err != nil {
			return model.PlayStream{}, fmt.Errorf("play %s period: %w", item.ID, err)
		}
		clockValue, err := mapCommentaryClock(item.Clock.Value)
		if err != nil {
			return model.PlayStream{}, fmt.Errorf("play %s clock: %w", item.ID, err)
		}
		play := model.Play{
			SourceID:     item.ID,
			Seq:          base + index,
			TypeID:       item.Type.ID,
			TypeKey:      item.Type.Type,
			TypeText:     item.Type.Text,
			Period:       period,
			ClockValue:   clockValue,
			ClockDisplay: item.Clock.DisplayValue,
			HomeScore:    item.HomeScore,
			AwayScore:    item.AwayScore,
			ScoringPlay:  item.ScoringPlay,
			ScoreValue:   item.ScoreValue,
			OwnGoal:      item.OwnGoal,
			PenaltyKick:  item.PenaltyKick,
			YellowCard:   item.YellowCard,
			RedCard:      item.RedCard,
			Substitution: item.Substitution,
			Shootout:     item.Shootout,
			Text:         item.Text,
			Coordinates:  mapPlayCoordinates(item),
		}
		if item.Team != nil {
			play.TeamSourceID = RefID(item.Team.Ref)
		}
		// participants[0] is the primary actor -- the passer, the shooter, the
		// fouler. Later entries are the receiver or the fouled player and are
		// deliberately not stored: one player-action per row is the same rule
		// match_event already follows, and a second column would make "how many
		// shots has this player taken" ambiguous.
		if len(item.Participants) > 0 {
			play.PlayerSourceID = RefID(item.Participants[0].Athlete.Ref)
		}
		if item.Wallclock != "" {
			at, err := time.Parse(time.RFC3339, item.Wallclock)
			if err != nil {
				return model.PlayStream{}, fmt.Errorf(
					"play %s wallclock: %w", item.ID, err)
			}
			play.Wallclock = &at
		}
		stream.Plays = append(stream.Plays, play)
	}
	return stream, nil
}

func validatePlayPage(page rawPlayPage) error {
	if page.Count < 0 {
		return fmt.Errorf("play stream count must be non-negative")
	}
	// ESPN's real empty envelope ignores the requested page controls and
	// returns pageIndex=0/pageSize=25/pageCount=0. It is a successful, explicit
	// empty result, not the silent page-size degradation guarded below.
	if page.Count == 0 && page.PageCount == 0 {
		if len(page.Items) != 0 {
			return fmt.Errorf("play stream count is zero with non-empty items")
		}
		return nil
	}
	if page.PageIndex < 1 {
		return fmt.Errorf("play stream pageIndex must be at least 1")
	}
	if page.PageSize < 1 {
		return fmt.Errorf("play stream pageSize must be at least 1")
	}
	if page.PageCount < 0 {
		return fmt.Errorf("play stream pageCount must be non-negative")
	}
	if page.PageCount == 0 && page.Count != 0 {
		return fmt.Errorf("play stream pageCount is zero for non-empty stream")
	}
	if page.PageCount > 0 && page.PageIndex > page.PageCount {
		return fmt.Errorf("play stream pageIndex exceeds pageCount")
	}
	return nil
}

func mapPlayPeriod(value *int) (*int, error) {
	if value == nil {
		return nil, nil
	}
	if err := validateCommentaryInteger(*value); err != nil {
		return nil, err
	}
	period := *value
	return &period, nil
}

// mapPlayCoordinates returns nil when nothing was located.
//
// ESPN uses 0 as its unset sentinel, not as the corner flag: the kickoff play
// carries fieldPositionX/Y of 0/0 while a real pass carries 50/50. Storing the
// zeros would put every unlocated play on the corner flag, and an xG model
// trained on that would treat the sentinel as a measurement.
func mapPlayCoordinates(item rawPlay) *model.PlayCoordinates {
	coordinates := &model.PlayCoordinates{
		StartX: located(item.FieldPositionX, item.FieldPositionY),
		StartY: located(item.FieldPositionY, item.FieldPositionX),
		EndX:   located(item.FieldPosition2X, item.FieldPosition2Y),
		EndY:   located(item.FieldPosition2Y, item.FieldPosition2X),
		GoalY:  nonZero(item.GoalPositionY),
		GoalZ:  nonZero(item.GoalPositionZ),
	}
	if coordinates.StartX == nil && coordinates.StartY == nil &&
		coordinates.EndX == nil && coordinates.EndY == nil &&
		coordinates.GoalY == nil && coordinates.GoalZ == nil {
		return nil
	}
	return coordinates
}

// located keeps a coordinate only when the PAIR is not the (0,0) sentinel. A
// genuine 0 on one axis -- a ball on the goal line, x=0 with y=50 -- is real
// and survives; only the pair being zero means "unset".
func located(value, partner *float64) *float64 {
	if value == nil {
		return nil
	}
	if *value == 0 && (partner == nil || *partner == 0) {
		return nil
	}
	return value
}

func nonZero(value *float64) *float64 {
	if value == nil || *value == 0 {
		return nil
	}
	return value
}

// analysableKeys is the Postgres tier. Everything else is archived to R2 and
// not rowed -- see the migration comment for the cost arithmetic.
var analysableKeys = map[string]bool{
	"goal": true, "own-goal": true, "shot-on-target": true,
	"shot-off-target": true, "shot-blocked": true, "save": true,
	"assist": true, "assists-shot": true, "yellow-card": true,
	"red-card": true, "substitution": true, "offside": true,
	"foul": true, "handball": true, "corner-awarded": true,
	"free-kick": true, "penalty-kick": true, "throw-in": true,
	"goal-kick": true, "kickoff": true, "halftime": true,
	"end-regular-time": true, "start-2nd-half": true,
}

// Analysable decides whether a play becomes a Postgres row.
//
// The default for an UNRECOGNISED type is to keep it. An unfamiliar key is far
// more likely to be a new key event (a VAR decision, a new card type) than a
// new kind of touch, and the cost of guessing wrong in that direction is a few
// hundred extra rows a season, against a silently missing feature in the
// other. Touch types are therefore listed explicitly and everything else is
// stored.
func Analysable(play model.Play) bool {
	if play.ScoringPlay || play.OwnGoal || play.YellowCard || play.RedCard ||
		play.Substitution || play.PenaltyKick {
		return true
	}
	if analysableKeys[play.TypeKey] {
		return true
	}
	return !model.IsTouchTier(play.TypeKey)
}
