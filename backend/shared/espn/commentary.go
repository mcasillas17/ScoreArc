package espn

import (
	"encoding/json"
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
// Optional metadata that PostgreSQL cannot represent is normalized to its
// existing unknown value (nil, or the array ordinal for sequence): relational
// enrichment must never make the core score and detail unavailable.
//
// Nothing here parses the prose. E6 owns the shot parser and is gated on T6.1's
// per-competition coverage probe.
func MapCommentaryLines(raw []byte) ([]model.CommentaryLine, error) {
	var summary rawSummary
	if err := parseRawSummary(raw, &summary); err != nil {
		return nil, fmt.Errorf("decode commentary: %w", err)
	}

	reservedSequences := make(map[int]struct{}, len(summary.Commentary))
	for _, item := range summary.Commentary {
		if seq := normalizeCommentaryInteger(item.Sequence); seq != nil {
			reservedSequences[*seq] = struct{}{}
		}
	}
	usedSequences := make(map[int]struct{}, len(summary.Commentary))
	lines := make([]model.CommentaryLine, 0, len(summary.Commentary))
	for index, item := range summary.Commentary {
		seq := 0
		providerSeq := normalizeCommentaryInteger(item.Sequence)
		if providerSeq != nil {
			if _, duplicate := usedSequences[*providerSeq]; !duplicate {
				seq = *providerSeq
			} else {
				var available bool
				seq, available = nextCommentarySequence(index, reservedSequences, usedSequences)
				if !available {
					continue
				}
			}
		} else {
			var available bool
			seq, available = nextCommentarySequence(index, reservedSequences, usedSequences)
			if !available {
				continue
			}
		}
		usedSequences[seq] = struct{}{}

		line := model.CommentaryLine{
			Seq:          seq,
			ClockValue:   normalizeCommentaryInteger(item.Time.Value),
			ClockDisplay: item.Time.DisplayValue,
			Text:         item.Text,
		}

		if item.Play != nil {
			line.PlayType = item.Play.Type.Type
			line.PlayTypeText = item.Play.Type.Text
			line.Period = normalizeCommentaryInteger(item.Play.Period.Number)
			if playClock := normalizeCommentaryInteger(item.Play.Clock.Value); playClock != nil {
				line.ClockValue = playClock
			}
			if wallclock := normalizeCommentaryString(item.Play.Wallclock); wallclock != "" {
				at, err := time.Parse(time.RFC3339, wallclock)
				if err == nil {
					line.Wallclock = &at
				}
			}
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func nextCommentarySequence(
	preferred int,
	reserved, used map[int]struct{},
) (int, bool) {
	if preferred < 0 || preferred > maxPostgresInteger {
		preferred = 0
	}
	for candidate := preferred; candidate <= maxPostgresInteger; candidate++ {
		if _, reserved := reserved[candidate]; reserved {
			continue
		}
		if _, used := used[candidate]; !used {
			return candidate, true
		}
	}
	for candidate := 0; candidate < preferred; candidate++ {
		if _, reserved := reserved[candidate]; reserved {
			continue
		}
		if _, used := used[candidate]; !used {
			return candidate, true
		}
	}
	return 0, false
}

func normalizeCommentaryInteger(raw json.RawMessage) *int {
	var value *float64
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil
	}
	if math.IsNaN(*value) || math.IsInf(*value, 0) ||
		*value < 0 || *value > maxPostgresInteger || math.Trunc(*value) != *value {
		return nil
	}
	integer := int(*value)
	return &integer
}

func normalizeCommentaryString(raw json.RawMessage) string {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return value
}
