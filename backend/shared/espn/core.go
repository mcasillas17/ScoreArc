package espn

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// core is ESPN's "core" API host. It is a DIFFERENT host from `site` at the
// top of client.go, serves a different shape, and is the only place the
// touch-level play stream, the officials list and the full odds ladder live.
const core = "https://sports.core.api.espn.com/v2/sports/soccer/leagues"

// CorePlaysBase is exposed for providers that need a test-only base override
// while keeping the production host in one place.
const CorePlaysBase = core

// corePlayPageLimit is the provider's real page cap.
//
// Verified 2026-08-15 against mex.1 event 401877018 (1,542 plays):
//
//	limit=100  -> pageSize=100,  pageCount=16
//	limit=400  -> pageSize=400,  pageCount=4
//	limit=1000 -> pageSize=1000, pageCount=2
//	limit=1001 -> pageSize=25,   pageCount=62   <-- silent fallback, no error
//	limit=2000 -> pageSize=25,   pageCount=62
//
// Asking for more than 1000 does not fail, it quietly returns the default page
// size, turning a two-request fetch into a sixty-two-request one with nothing
// in the logs. Clamp here, and assert the returned pageSize at the call site.
const corePlayPageLimit = 1000

// CorePlayPageLimit is the page size callers must request and verify.
const CorePlayPageLimit = corePlayPageLimit

// CorePlaysURL builds one page of a match's play stream.
//
// The event id appears twice, as the event and as the competition. In soccer
// they are always the same value, but the path distinguishes them and
// collapsing that here would break the first time they diverge.
func CorePlaysURL(slug, eventID string, page, limit int) string {
	return CorePlaysURLOn(core, slug, eventID, page, limit)
}

// CorePlaysURLOn builds a plays URL against an explicit base. Production calls
// use CorePlaysURL; the override lets source tests use an httptest server.
func CorePlaysURLOn(base, slug, eventID string, page, limit int) string {
	if limit <= 0 || limit > corePlayPageLimit {
		limit = corePlayPageLimit
	}
	if page < 1 {
		page = 1
	}
	return fmt.Sprintf("%s/plays?limit=%d&page=%d",
		coreCompetitionURLOn(base, slug, eventID), limit, page)
}

// CoreOfficialsURL builds the core API URL for a match's officiating crew.
func CoreOfficialsURL(slug, eventID string) string {
	return CoreOfficialsURLOn(core, slug, eventID)
}

// CoreOfficialsURLOn builds an officials URL against an explicit base.
func CoreOfficialsURLOn(base, slug, eventID string) string {
	return coreCompetitionURLOn(base, slug, eventID) + "/officials"
}

// CoreOddsURL builds the core API URL for a match's provider odds.
func CoreOddsURL(slug, eventID string) string {
	return CoreOddsURLOn(core, slug, eventID)
}

// CoreOddsURLOn builds an odds URL against an explicit base.
func CoreOddsURLOn(base, slug, eventID string) string {
	return coreCompetitionURLOn(base, slug, eventID) + "/odds"
}

func coreCompetitionURLOn(base, slug, eventID string) string {
	event := url.PathEscape(eventID)
	return fmt.Sprintf("%s/%s/events/%s/competitions/%s",
		strings.TrimRight(base, "/"), url.PathEscape(slug), event, event)
}

// refIDRe pulls the last path segment before the query string, requiring it to
// be numeric. Numeric on purpose: a non-numeric tail is a ref shape we have not
// seen, and returning it would attribute a play to whatever entity happened to
// match that string.
var refIDRe = regexp.MustCompile(`/(\d+)(?:\?|$)`)

// RefID returns the entity id embedded in a core-API $ref URL.
//
// This function is why the play stream is affordable. A play's team, athlete
// and position arrive as $ref URLs rather than embedded objects:
//
//	"team": {"$ref": ".../seasons/2026/teams/223?lang=en&region=us"}
//
// A match carries ~1,500 plays with two or three refs each. Resolving them by
// following the URL is ~4,500 HTTP requests per match, against a keyless
// public API, for nine competitions concurrently -- rate-limited inside one
// cycle, and slower than the match it is describing.
//
// So: NEVER FETCH A $ref. Parse the id, and resolve it against the team and
// player crosswalks the ingester has already populated from the summary
// payloads.
func RefID(ref string) string {
	match := refIDRe.FindStringSubmatch(ref)
	if match == nil {
		return ""
	}
	return match[1]
}
