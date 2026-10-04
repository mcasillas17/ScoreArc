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

// jsNumber reads a summary header's shootout total by its wider numeric rule
// (parseSuppliedShootoutScore): a non-negative integral JSON number, or a
// string holding one after trimming, with null and "" read as 0; absent and
// anything else are not finite. Scoreboard and bracket totals pass the narrower
// scoreboardTotal first, which admits only digit strings.
func jsNumber(raw json.RawMessage) (value float64, finite bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		return f, f >= 0 && math.Trunc(f) == f
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		s = strings.TrimSpace(s)
		if s == "" {
			return 0, true
		}
		if fv, err := strconv.ParseFloat(s, 64); err == nil {
			return fv, fv >= 0 && math.Trunc(fv) == fv
		}
	}
	return 0, false
}

// shootoutFirstWinnerID gives a finished match's decisive shootout aggregate
// precedence over provider flags; a live shootout's totals are partial and name
// no winner. The caller resolves the aggregate from its validated evidence.
// Without a decisive aggregate, two asserted winners are explicitly ambiguous.
// Callers validate the home/away identities before resolving the winner.
func shootoutFirstWinnerID(
	homeID, awayID string,
	shootout *Shootout,
	homeWinner, awayWinner, finished bool,
) (*string, error) {
	decisive := ShootoutWinner(shootout, homeID, awayID) != nil
	if decisive && finished {
		return ShootoutWinner(shootout, homeID, awayID), nil
	}
	if homeWinner && awayWinner {
		if decisive {
			return nil, nil
		}
		return nil, fmt.Errorf("ambiguous winner flags without decisive shootout totals")
	}
	return flaggedWinnerID(homeID, awayID, homeWinner, awayWinner), nil
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
