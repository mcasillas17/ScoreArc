package espn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// parseSuppliedShootoutScore preserves absent totals and the existing null/empty
// zero coercion. Supplied invalid values fail before conversion to model ints.
func parseSuppliedShootoutScore(raw json.RawMessage) (int, bool, error) {
	if len(raw) == 0 {
		return 0, false, nil
	}
	score, valid := jsNumber(raw)
	// The bound is exclusive: float64(MaxInt64) rounds up to 2^63.
	intLimit := math.Ldexp(1, strconv.IntSize-1)
	if !valid || math.IsInf(score, 0) || score >= intLimit {
		return 0, false, fmt.Errorf("invalid shootout score: expected a nonnegative integer below %g", intLimit)
	}
	return int(score), true, nil
}

// shootoutFirstWinnerID gives decisive validated totals precedence over provider
// flags. Without decisive totals, two asserted winners are explicitly ambiguous.
// Callers validate the home/away identities before resolving the winner.
func shootoutFirstWinnerID(
	homeID, awayID string,
	homeShootout, awayShootout json.RawMessage,
	homeWinner, awayWinner bool,
) (*string, error) {
	hs, homeSupplied, err := parseSuppliedShootoutScore(homeShootout)
	if err != nil {
		return nil, err
	}
	as, awaySupplied, err := parseSuppliedShootoutScore(awayShootout)
	if err != nil {
		return nil, err
	}
	if homeSupplied && awaySupplied && hs != as {
		if hs > as {
			return &homeID, nil
		}
		return &awayID, nil
	}
	if homeWinner && awayWinner {
		return nil, fmt.Errorf("ambiguous winner flags without decisive shootout totals")
	}
	if homeWinner {
		return &homeID, nil
	}
	if awayWinner {
		return &awayID, nil
	}
	return nil, nil
}

// rawObservationStatus distinguishes explicit incompletion from missing/null
// completion metadata before match observations can refresh stored facts.
type rawObservationStatus struct {
	DisplayClock string `json:"displayClock"`
	Type         struct {
		State       string `json:"state"`
		Completed   *bool  `json:"completed"`
		Name        string `json:"name"`
		ShortDetail string `json:"shortDetail"`
	} `json:"type"`
}

func terminalMatchStatus(name string) bool {
	return name == "STATUS_CANCELED" || name == "STATUS_ABANDONED" || name == "STATUS_FORFEIT"
}

func observedMatchState(status *rawObservationStatus) (MatchState, error) {
	if status == nil || status.Type.Completed == nil || !strings.HasPrefix(status.Type.Name, "STATUS_") {
		return "", fmt.Errorf("ESPN observation missing status type/completion")
	}
	state, name, completed := status.Type.State, status.Type.Name, *status.Type.Completed
	if state != "pre" && state != "in" && state != "post" {
		return "", fmt.Errorf("ESPN observation has unknown status state %q", state)
	}
	switch {
	case name == "STATUS_SUSPENDED" || name == "STATUS_POSTPONED":
		if !completed {
			return MatchStateScheduled, nil
		}
	case terminalMatchStatus(name):
		if state == "post" {
			return MatchStateFinished, nil
		}
	case name == "STATUS_FINAL" || name == "STATUS_FINAL_AET" || name == "STATUS_FINAL_PEN" || name == "STATUS_FULL_TIME":
		if state == "post" && completed {
			return MatchStateFinished, nil
		}
	case name == "STATUS_SCHEDULED" || name == "STATUS_DELAYED":
		if state == "pre" && !completed {
			return MatchStateScheduled, nil
		}
	case name == "STATUS_IN_PROGRESS" || name == "STATUS_FIRST_HALF" ||
		name == "STATUS_HALFTIME" || name == "STATUS_SECOND_HALF":
		if state == "in" && !completed {
			return MatchStateLive, nil
		}
	default:
		// New provider names can use explicit state/completion flags, but
		// post alone is ambiguous and must never synthesize a final result.
		switch {
		case state == "pre" && !completed:
			return MatchStateScheduled, nil
		case state == "in" && !completed:
			return MatchStateLive, nil
		case state == "post" && completed:
			return MatchStateFinished, nil
		}
	}
	return "", fmt.Errorf("ESPN observation has contradictory status %q (state=%q completed=%t)", name, state, completed)
}

func validateArrayEnvelope(raw []byte, field string) error {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	value, ok := envelope[field]
	if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return fmt.Errorf("ESPN payload missing %q array", field)
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(value, &rows); err != nil {
		return fmt.Errorf("ESPN payload %q: %w", field, err)
	}
	return nil
}
