package espn

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func loadPlays(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// pageCount is why this cannot be a single request. A fresh match is 1,542
// plays at a hard cap of 1,000 per page.
func TestMapPlaysReportsPagination(t *testing.T) {
	stream, err := MapPlays(loadPlays(t, "espn-plays.json"))
	if err != nil {
		t.Fatal(err)
	}
	if stream.Total != 1542 {
		t.Fatalf("Total = %d, want 1542", stream.Total)
	}
	if stream.PageCount != 2 {
		t.Fatalf("PageCount = %d, want 2 -- a single-request fetch would silently lose 542 plays",
			stream.PageCount)
	}
	if stream.PageSize != 1000 {
		t.Fatalf("PageSize = %d, want 1000 -- the provider silently degrades to 25 above its cap",
			stream.PageSize)
	}
	if len(stream.Plays) != 1000 {
		t.Fatalf("plays = %d, want 1000", len(stream.Plays))
	}
}

// The constraint. Refs are parsed, never fetched.
func TestMapPlaysResolvesRefsByParsing(t *testing.T) {
	stream, err := MapPlays(loadPlays(t, "espn-plays.json"))
	if err != nil {
		t.Fatal(err)
	}
	var withTeam, withAthlete int
	for _, play := range stream.Plays {
		if play.TeamSourceID != "" {
			withTeam++
		}
		if play.PlayerSourceID != "" {
			withAthlete++
		}
	}
	if withTeam == 0 {
		t.Fatal("no play carried a team id; the $ref was not parsed")
	}
	if withAthlete == 0 {
		t.Fatal("no play carried an athlete id; the participant $ref was not parsed")
	}
}

// Coordinates exist. This test is the standing refutation of the roadmap's
// "no pass or touch coordinates exist in any response we can reach".
func TestMapPlaysCarriesPitchCoordinates(t *testing.T) {
	stream, err := MapPlays(loadPlays(t, "espn-plays.json"))
	if err != nil {
		t.Fatal(err)
	}
	var located, shotsWithGoalMouth int
	for _, play := range stream.Plays {
		if play.Coordinates != nil {
			located++
			if play.Coordinates.GoalY != nil && play.Coordinates.GoalZ != nil {
				shotsWithGoalMouth++
			}
		}
	}
	if located < len(stream.Plays)/2 {
		t.Fatalf("located = %d of %d; the fixture had over 90%% coordinate coverage",
			located, len(stream.Plays))
	}
	if shotsWithGoalMouth == 0 {
		t.Fatal("no play carried goalPositionY/Z; shot placement was dropped")
	}
}

// ESPN sends 0 as its unset sentinel -- the kickoff play is 0/0 while a real
// pass is 50/50. Storing 0 would put every unlocated play on the corner flag,
// and an xG model would read that as a measurement.
func TestMapPlaysTreatsZeroZeroAsUnlocated(t *testing.T) {
	raw := []byte(`{"count":1,"pageIndex":1,"pageSize":1000,"pageCount":1,"items":[
	  {"id":"1","type":{"id":"80","text":"Kickoff","type":"kickoff"},
	   "period":{"number":1},"clock":{"value":0,"displayValue":""},
	   "fieldPositionX":0,"fieldPositionY":0}]}`)
	stream, err := MapPlays(raw)
	if err != nil {
		t.Fatal(err)
	}
	if stream.Plays[0].Coordinates != nil {
		t.Fatalf("Coordinates = %#v for a 0/0 play, want nil", stream.Plays[0].Coordinates)
	}
}

// The pruned world. The mapper must handle it without complaint -- it is not
// an error, it is a nine-month-old match -- and the caller needs to be able to
// tell the two apart, which is what HasTouchTier is for.
func TestMapPlaysDetectsAPrunedStream(t *testing.T) {
	fresh, err := MapPlays(loadPlays(t, "espn-plays.json"))
	if err != nil {
		t.Fatal(err)
	}
	pruned, err := MapPlays(loadPlays(t, "espn-plays-pruned.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !fresh.HasTouchTier() {
		t.Fatal("the fresh fixture must report a touch tier")
	}
	if pruned.HasTouchTier() {
		t.Fatal("the pruned fixture must not report a touch tier")
	}
	// But its shots and their coordinates are still there -- which is why a
	// shot map backfills further than a pass network does, though NOT on
	// comparable terms: a pruned match's coordinates are on a 0-1 scale with
	// goal-mouth placement zeroed, so they cannot be plotted or trained on
	// alongside current-season shots until the frames are reconciled.
	var located int
	for _, play := range pruned.Plays {
		if play.Coordinates != nil {
			located++
		}
	}
	if located == 0 {
		t.Fatal("the pruned fixture lost its coordinates; it should not have")
	}
}

// The Postgres/R2 split, expressed as one predicate in one place.
func TestAnalysablePlaysAreTheKeyEventTier(t *testing.T) {
	for _, key := range []string{
		"goal", "own-goal", "shot-on-target", "shot-off-target", "shot-blocked",
		"save", "assist", "yellow-card", "red-card", "substitution",
		"offside", "foul", "corner-awarded", "free-kick", "penalty-kick",
	} {
		if !Analysable(Play{TypeKey: key}) {
			t.Fatalf("%q must be stored in Postgres", key)
		}
	}
	for _, key := range []string{
		"pass", "ball-touch", "tackle", "take-on", "aerial", "clear",
		"cross", "dispossessed", "interception", "blocked-pass", "out",
	} {
		if Analysable(Play{TypeKey: key}) {
			t.Fatalf("%q is touch tier and must stay in R2 only", key)
		}
	}
	// A type we have never seen is kept. An unknown key is far more likely to
	// be a new key event than a new kind of touch, and the cost of being wrong
	// is a few extra rows rather than a silently missing feature.
	if !Analysable(Play{TypeKey: "var-decision"}) {
		t.Fatal("an unrecognised type must default to stored, not dropped")
	}
	// Unless it is scoring, in which case there is no question at all.
	if !Analysable(Play{TypeKey: "pass", ScoringPlay: true}) {
		t.Fatal("a scoring play must be stored whatever its type")
	}
}

func TestMapPlaysPreservesMissingPeriodAndClock(t *testing.T) {
	raw := []byte(`{"count":1,"pageIndex":1,"pageSize":1000,"pageCount":1,"items":[
	  {"id":"1","type":{"id":"80","text":"Kickoff","type":"kickoff"}}]}`)
	stream, err := MapPlays(raw)
	if err != nil {
		t.Fatal(err)
	}
	play := stream.Plays[0]
	if play.Period != nil || play.ClockValue != nil {
		t.Fatalf("missing period/clock mapped to %v/%v, want nil/nil", play.Period, play.ClockValue)
	}
}

func TestMapPlaysRejectsMalformedWallclock(t *testing.T) {
	raw := []byte(`{"count":1,"pageIndex":1,"pageSize":1000,"pageCount":1,"items":[
	  {"id":"1","type":{"id":"80","text":"Kickoff","type":"kickoff"},
	   "wallclock":"not-a-timestamp"}]}`)
	_, err := MapPlays(raw)
	if err == nil {
		t.Fatal("want malformed wallclock to fail")
	}
	if !strings.Contains(err.Error(), "wallclock") {
		t.Fatalf("err = %v, want wallclock context", err)
	}
}

func TestMapPlaysRejectsInvalidNumericFields(t *testing.T) {
	cases := []struct {
		name string
		item string
		want string
	}{
		{
			name: "negative period",
			item: `{"id":"1","type":{"id":"80","text":"Kickoff","type":"kickoff"},
				"period":{"number":-1}}`,
			want: "period",
		},
		{
			name: "fractional clock",
			item: `{"id":"1","type":{"id":"80","text":"Kickoff","type":"kickoff"},
				"clock":{"value":1.5}}`,
			want: "clock",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			raw := []byte(`{"count":1,"pageIndex":1,"pageSize":1000,"pageCount":1,"items":[` +
				test.item + `]}`)
			_, err := MapPlays(raw)
			if err == nil {
				t.Fatal("want invalid provider numeric field to fail")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("err = %v, want %q context", err, test.want)
			}
		})
	}
}

func TestMapPlaysRejectsInvalidPagination(t *testing.T) {
	raw := []byte(`{"count":1,"pageIndex":0,"pageSize":1000,"pageCount":1,"items":[
	  {"id":"1","type":{"id":"80","text":"Kickoff","type":"kickoff"}}]}`)
	_, err := MapPlays(raw)
	if err == nil {
		t.Fatal("want invalid pageIndex to fail")
	}
	if !strings.Contains(err.Error(), "pageIndex") {
		t.Fatalf("err = %v, want pageIndex context", err)
	}
}

func TestFetchPlaysPageRefusesAnUnexpectedPageSize(t *testing.T) {
	client := NewWithOptions(Options{
		HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"count":1542,"pageIndex":1,"pageSize":25,"pageCount":62,"items":[]}`,
				)),
			}, nil
		})},
		MaxAttempts: 1,
	})

	_, err := FetchPlaysPage(context.Background(), client, "mex.1", "401877018", 1)
	if err == nil || !strings.Contains(err.Error(), "page size") {
		t.Fatalf("err = %v, want page size mismatch", err)
	}
}
