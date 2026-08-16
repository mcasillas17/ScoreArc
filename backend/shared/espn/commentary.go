package espn

import (
	"fmt"
	"math"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

const maxPostgresInteger = 1<<31 - 1

// MapCommentaryLines reads commentary with the structure
// mapSummaryCommentary discards.
//
// It is a sibling of that function, not a replacement. mapSummaryCommentary
// produces the jsonb contract returned by the reader; this function produces
// ingester-only relational rows. It deliberately keeps empty-text lines because
// a sequence, period and play type remain useful without display prose.
//
// Nothing here parses the prose. E6 owns the shot parser and is gated on T6.1's
// per-competition coverage probe.
func MapCommentaryLines(raw []byte) ([]model.CommentaryLine, error) {
	var summary rawSummary
	if err := parseRawSummary(raw, &summary); err != nil {
		return nil, fmt.Errorf("decode commentary: %w", err)
	}

	lines := make([]model.CommentaryLine, 0, len(summary.Commentary))
	for index, item := range summary.Commentary {
		seq := index + 1
		if item.Sequence != nil {
			seq = *item.Sequence
		}
		if err := validateCommentaryInteger(seq); err != nil {
			return nil, fmt.Errorf("commentary sequence: %w", err)
		}

		clockValue, err := mapCommentaryClock(item.Time.Value)
		if err != nil {
			return nil, fmt.Errorf("commentary sequence %d time clock: %w", seq, err)
		}
		line := model.CommentaryLine{
			Seq:          seq,
			ClockValue:   clockValue,
			ClockDisplay: item.Time.DisplayValue,
			Text:         item.Text,
		}

		if item.Play != nil {
			line.PlayType = item.Play.Type.Type
			line.PlayTypeText = item.Play.Type.Text
			if item.Play.Period.Number != nil {
				period := *item.Play.Period.Number
				if err := validateCommentaryInteger(period); err != nil {
					return nil, fmt.Errorf("commentary sequence %d period: %w", seq, err)
				}
				line.Period = &period
			}
			if item.Play.Clock.Value != nil {
				playClock, err := mapCommentaryClock(item.Play.Clock.Value)
				if err != nil {
					return nil, fmt.Errorf("commentary sequence %d play clock: %w", seq, err)
				}
				line.ClockValue = playClock
			}
			if item.Play.Wallclock != "" {
				at, err := time.Parse(time.RFC3339, item.Play.Wallclock)
				if err != nil {
					return nil, fmt.Errorf("commentary sequence %d wallclock: %w", seq, err)
				}
				line.Wallclock = &at
			}
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func mapCommentaryClock(value *float64) (*int, error) {
	if value == nil {
		return nil, nil
	}
	if math.IsNaN(*value) || math.IsInf(*value, 0) ||
		*value < 0 || *value > maxPostgresInteger || math.Trunc(*value) != *value {
		return nil, fmt.Errorf("must be a whole non-negative PostgreSQL integer")
	}
	clock := int(*value)
	return &clock, nil
}

func validateCommentaryInteger(value int) error {
	if value < 0 || int64(value) > maxPostgresInteger {
		return fmt.Errorf("must be a non-negative PostgreSQL integer")
	}
	return nil
}
