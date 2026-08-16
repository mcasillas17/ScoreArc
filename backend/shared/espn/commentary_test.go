package espn

import (
	"os"
	"testing"
)

// The measurements this task is justified by, asserted so they cannot silently
// stop being true.
func TestMapCommentaryLinesKeepsWhatTheJsonbDrops(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 91 {
		t.Fatalf("lines = %d, want 91 -- the recorded fixture's count", len(lines))
	}

	var withPlay, blankDisplay int
	for _, line := range lines {
		if line.PlayType != "" {
			withPlay++
		}
		if line.ClockDisplay == "" {
			blankDisplay++
		}
	}
	if withPlay != 86 {
		t.Fatalf("lines with a play type = %d, want 86", withPlay)
	}
	// The reason clock_value exists: a meaningful fraction of lines carry an
	// EMPTY displayValue, so the jsonb array cannot be ordered or filtered by
	// minute without losing them.
	if blankDisplay == 0 {
		t.Fatal("no line had a blank displayValue; the fixture has several")
	}

	// Sequence is what makes order a guarantee rather than a coincidence.
	for i := 1; i < len(lines); i++ {
		if lines[i].Seq <= lines[i-1].Seq {
			t.Fatalf("seq %d then %d at index %d; sequence is not monotonic",
				lines[i-1].Seq, lines[i].Seq, i)
		}
	}
}

// The fixture's kickoff line, field by field. A structural assertion beats a
// count: it fails when a field moves, not only when the file changes size.
func TestMapCommentaryLinesReadsTheKickoff(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	var kickoff *CommentaryLine
	for i := range lines {
		if lines[i].Seq == 1 {
			kickoff = &lines[i]
			break
		}
	}
	if kickoff == nil {
		t.Fatal("sequence 1 kickoff line is missing")
	}
	if kickoff.Text != "First Half begins." {
		t.Fatalf("Text = %q", kickoff.Text)
	}
	if kickoff.PlayType != "kickoff" {
		t.Fatalf("PlayType = %q, want the MACHINE value kickoff, not the label", kickoff.PlayType)
	}
	if kickoff.PlayTypeText != "Kickoff" {
		t.Fatalf("PlayTypeText = %q, want the label Kickoff", kickoff.PlayTypeText)
	}
	if kickoff.Period == nil || *kickoff.Period != 1 {
		t.Fatalf("Period = %v, want 1", kickoff.Period)
	}
	// 0 is a real clock value at kickoff and must survive as 0, not as nil.
	if kickoff.ClockValue == nil || *kickoff.ClockValue != 0 {
		t.Fatalf("ClockValue = %v, want a measured 0", kickoff.ClockValue)
	}
	// The empty display string is stored verbatim.
	if kickoff.ClockDisplay != "" {
		t.Fatalf("ClockDisplay = %q, want the empty string as sent", kickoff.ClockDisplay)
	}
	if kickoff.Wallclock == nil {
		t.Fatal("Wallclock is nil; the fixture carries play.wallclock")
	}
}

// A line with no `play` object still happened. 5 of the fixture's 91 have none.
func TestMapCommentaryLinesKeepsALineWithNoPlay(t *testing.T) {
	raw := []byte(`{"commentary":[
	  {"sequence":7,"time":{"value":12,"displayValue":"12'"},"text":"Substitution warming up."}]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 {
		t.Fatalf("lines = %d, want 1", len(lines))
	}
	if lines[0].PlayType != "" || lines[0].Period != nil || lines[0].Wallclock != nil {
		t.Fatalf("line = %#v; a missing play object must leave those empty, not invented",
			lines[0])
	}
	// time.value is the fallback when play.clock is absent.
	if lines[0].ClockValue == nil || *lines[0].ClockValue != 12 {
		t.Fatalf("ClockValue = %v, want 12 from time.value", lines[0].ClockValue)
	}
}

// Missing numeric provider fields remain unknown. In particular, they must not
// collide with a measured 0 at kickoff.
func TestMapCommentaryLinesKeepsMissingNumbersNull(t *testing.T) {
	raw := []byte(`{"commentary":[{
	  "sequence":7,
	  "time":{"displayValue":""},
	  "text":"An event without numeric timing.",
	  "play":{"type":{"text":"Unknown","type":"unknown"},"wallclock":"2026-08-15T19:42:00Z"}
	}]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if lines[0].Period != nil || lines[0].ClockValue != nil {
		t.Fatalf("Period=%v ClockValue=%v, want missing values to remain nil",
			lines[0].Period, lines[0].ClockValue)
	}
}

func TestMapCommentaryLinesKeepsLineWithMalformedWallclock(t *testing.T) {
	raw := []byte(`{"commentary":[{
	  "sequence":7,
	  "time":{"value":12,"displayValue":"12'"},
	  "text":"Malformed timestamp.",
	  "play":{"period":{"number":1},"clock":{"value":12},"wallclock":"not-a-time"}
	}]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0].Wallclock != nil {
		t.Fatalf("lines = %#v, want one line with a nil wallclock", lines)
	}
}

func TestMapCommentaryLinesKeepsLineWithFractionalClockValue(t *testing.T) {
	raw := []byte(`{"commentary":[{
	  "sequence":7,
	  "time":{"value":12.5,"displayValue":"12'"},
	  "text":"Malformed clock."
	}]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0].ClockValue != nil {
		t.Fatalf("lines = %#v, want one line with a nil clock", lines)
	}
}

func TestMapCommentaryLinesNormalizesNumbersPostgresCannotRepresent(t *testing.T) {
	tests := map[string]struct {
		item       string
		wantSeq    int
		wantClock  *int
		wantPeriod *int
	}{
		"negative sequence": {
			item:      `{"sequence":-1,"time":{"value":1},"text":"Bad sequence."}`,
			wantSeq:   0,
			wantClock: intPointer(1),
		},
		"negative clock": {
			item:    `{"sequence":1,"time":{"value":-1},"text":"Bad clock."}`,
			wantSeq: 1,
		},
		"oversized period": {
			item:      `{"sequence":1,"time":{"value":1},"text":"Bad period.","play":{"period":{"number":2147483648}}}`,
			wantSeq:   1,
			wantClock: intPointer(1),
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			raw := []byte(`{"commentary":[` + test.item + `]}`)
			lines, err := MapCommentaryLines(raw)
			if err != nil {
				t.Fatal(err)
			}
			if len(lines) != 1 {
				t.Fatalf("lines = %d, want 1", len(lines))
			}
			if lines[0].Seq != test.wantSeq ||
				!equalIntPointers(lines[0].ClockValue, test.wantClock) ||
				!equalIntPointers(lines[0].Period, test.wantPeriod) {
				t.Fatalf("line = %#v, want seq=%d clock=%v period=%v",
					lines[0], test.wantSeq, test.wantClock, test.wantPeriod)
			}
		})
	}
}

func intPointer(value int) *int {
	return &value
}

func equalIntPointers(left, right *int) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func TestMapCommentaryLinesSynthesizesMissingSequences(t *testing.T) {
	raw := []byte(`{"commentary":[
	  {"time":{"value":1,"displayValue":"1'"},"text":"First"},
	  {"time":{"value":2,"displayValue":"2'"},"text":"Second"}
	]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if lines[0].Seq != 0 || lines[1].Seq != 1 {
		t.Fatalf("sequences = %d, %d; want provider-order fallbacks 0, 1", lines[0].Seq, lines[1].Seq)
	}
}

func TestMapCommentaryLinesMissingSequenceDoesNotCollideWithItsNeighbor(t *testing.T) {
	raw := []byte(`{"commentary":[
	  {"sequence":0,"time":{"value":1},"text":"First"},
	  {"time":{"value":2},"text":"Missing sequence"},
	  {"sequence":2,"time":{"value":3},"text":"Third"}
	]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if lines[0].Seq != 0 || lines[1].Seq != 1 || lines[2].Seq != 2 {
		t.Fatalf("sequences = %d, %d, %d; want 0, 1, 2",
			lines[0].Seq, lines[1].Seq, lines[2].Seq)
	}
}

func TestMapCommentaryLinesInvalidSequenceDoesNotCollideWithProviderSequence(t *testing.T) {
	raw := []byte(`{"commentary":[
	  {"sequence":1,"time":{"value":1},"text":"Provider sequence"},
	  {"sequence":1.5,"time":{"value":2},"text":"Invalid sequence"}
	]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if lines[0].Seq != 1 || lines[1].Seq != 2 {
		t.Fatalf("sequences = %d, %d; want collision-free 1, 2",
			lines[0].Seq, lines[1].Seq)
	}
}

func TestMapCommentaryLinesFallbackDoesNotClaimFutureProviderSequence(t *testing.T) {
	raw := []byte(`{"commentary":[
	  {"time":{"value":1},"text":"Missing sequence"},
	  {"sequence":0,"time":{"value":2},"text":"Provider sequence"}
	]}`)
	lines, err := MapCommentaryLines(raw)
	if err != nil {
		t.Fatal(err)
	}
	if lines[0].Seq != 1 || lines[1].Seq != 0 {
		t.Fatalf("sequences = %d, %d; want collision-free 1, 0",
			lines[0].Seq, lines[1].Seq)
	}
}

// Coverage varies by competition and has been observed at ZERO. An empty array
// is a Tuesday, not a failure.
func TestMapCommentaryLinesAcceptsNoCommentary(t *testing.T) {
	lines, err := MapCommentaryLines([]byte(`{"commentary":[]}`))
	if err != nil {
		t.Fatalf("empty commentary must not be an error: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("lines = %d, want 0", len(lines))
	}
	if lines, err = MapCommentaryLines([]byte(`{}`)); err != nil || len(lines) != 0 {
		t.Fatalf("absent commentary key: lines=%d err=%v", len(lines), err)
	}
}

// The existing jsonb mapper must be untouched. Two mappers over one payload is
// only safe if the one the reader depends on does not move.
func TestMapSummaryCommentaryIsUnchanged(t *testing.T) {
	raw, err := os.ReadFile("testdata/espn-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	detail, err := MapSummary(raw)
	if err != nil {
		t.Fatal(err)
	}
	// mapSummaryCommentary drops empty-text entries; MapCommentaryLines does
	// not need to, because a row with a sequence and a type is useful even
	// without prose. The counts may therefore differ, and that is fine -- what
	// must not change is the jsonb shape the reader serves.
	if len(detail.Commentary) == 0 {
		t.Fatal("the jsonb commentary array is empty; the existing mapper regressed")
	}
	for _, item := range detail.Commentary {
		if item.Text == "" {
			t.Fatal("an empty-text entry reached the jsonb array; the existing filter regressed")
		}
	}
}
