package espn

import (
	"strings"
	"testing"
)

func TestCorePlaysURL(t *testing.T) {
	// The core host is NOT the site host every other builder in this package
	// uses, and the event id appears twice: once as the event and once as the
	// competition. For soccer they are the same value; hard-coding one of them
	// would break the first time they are not.
	got := CorePlaysURL("mex.1", "401877018", 1, 1000)
	want := "http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1" +
		"/events/401877018/competitions/401877018/plays?limit=1000&page=1"
	if got != want {
		t.Fatalf("CorePlaysURL =\n%s\nwant\n%s", got, want)
	}
}

// Verified 2026-08-15: limit=1000 returns pageSize=1000, and limit=1001 returns
// pageSize=25 with NO error. Silently making 62 requests instead of 2 is worse
// than refusing, so the builder clamps.
func TestCorePlaysURLClampsToTheProviderCap(t *testing.T) {
	for _, limit := range []int{1001, 2000, 0, -1} {
		got := CorePlaysURL("mex.1", "1", 1, limit)
		if !strings.Contains(got, "limit=1000") {
			t.Fatalf("limit=%d produced %q, want it clamped to 1000", limit, got)
		}
	}
}

func TestCorePlaysURLEncodesItsInputs(t *testing.T) {
	if got := CorePlaysURL("mex.1", "../../secret", 1, 100); strings.Contains(got, "../") {
		t.Fatalf("CorePlaysURL = %q, want the event id encoded", got)
	}
}

// The whole point: a play's team/athlete/position arrive as $ref URLs, and a
// match has ~1,500 plays with two or three each. Fetching them is ~4,500
// requests per match against a keyless API. The id is in the URL.
func TestRefIDParsesWithoutFetching(t *testing.T) {
	cases := map[string]string{
		"http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/seasons/2026/teams/223?lang=en&region=us":                       "223",
		"http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/seasons/2026/athletes/295847?lang=en":                           "295847",
		"http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/positions/20?lang=en&region=us":                                 "20",
		"http://sports.core.api.espn.com/v2/sports/soccer/leagues/mex.1/events/401877018/competitions/401877018/plays/50929858?lang=en": "50929858",
	}
	for ref, want := range cases {
		if got := RefID(ref); got != want {
			t.Fatalf("RefID(%q) = %q, want %q", ref, got, want)
		}
	}
	// A ref shape we have not seen must yield "" so the caller stores NULL,
	// rather than yielding a fragment that resolves to the wrong entity.
	for _, bad := range []string{"", "not a url", "http://example.com/teams/", "http://example.com/teams/abc"} {
		if got := RefID(bad); got != "" {
			t.Fatalf("RefID(%q) = %q, want empty", bad, got)
		}
	}
}
