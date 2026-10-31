package source

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestAthleteBioObservationRejectsIncompleteOrMalformedHistory(t *testing.T) {
	valid := `{"id":"222","displayName":"Querétaro","seasons":"2025-CURRENT"}`
	cases := map[string]string{
		"malformed empty":                  `{"teamHistory":[{}]}`,
		"malformed tail":                   `{"teamHistory":[` + valid + `,{}]}`,
		"null row":                         `{"teamHistory":[null]}`,
		"missing team name":                `{"teamHistory":[{"id":"222","seasons":"2025-CURRENT"}]}`,
		"missing seasons":                  `{"teamHistory":[{"id":"222","displayName":"Querétaro"}]}`,
		"blank identity":                   `{"teamHistory":[{"id":" ","displayName":"Querétaro","seasons":"2025-CURRENT"}]}`,
		"duplicate stints":                 `{"teamHistory":[` + valid + `,` + valid + `]}`,
		"null code":                        `{"code":null,"teamHistory":[]}`,
		"not found with history":           `{"code":404,"teamHistory":[` + valid + `]}`,
		"not found with malformed history": `{"code":404,"teamHistory":[{}]}`,
		"not found with truncation":        `{"code":404,"truncated":true}`,
	}
	for _, rows := range []string{"", valid} {
		for _, metadata := range []string{`"hasMore":true`, `"truncated":true`, `"pageCount":2`, `"offset":1`, `"total":2`, `"pagination":{"pageIndex":2}`, `"pagination":{"count":"invalid"}`} {
			cases[rows+metadata] = `{"teamHistory":[` + rows + `],` + metadata + `}`
		}
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			client := espn.NewWithOptions(espn.Options{MaxAttempts: 1, HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(raw))}, nil
			})}})
			if entries, err := NewESPN(client).AthleteBio(context.Background(), config.Competition{ESPNSlug: "mex.1"}, "297287"); err == nil {
				t.Fatalf("invalid source history accepted for replacement: %+v", entries)
			}
		})
	}
}

func TestAthleteBioObservationAcceptsExplicitEmptyAndNotFound(t *testing.T) {
	for _, raw := range []string{`{"teamHistory":[]}`, `{"teamHistory":[],"total":0,"hasMore":false}`, `{"code":404}`, `{"code":404,"teamHistory":null}`, `{"code":404,"teamHistory":[]}`} {
		t.Run(raw, func(t *testing.T) {
			client := espn.NewWithOptions(espn.Options{MaxAttempts: 1, HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(raw))}, nil
			})}})
			entries, err := NewESPN(client).AthleteBio(context.Background(), config.Competition{ESPNSlug: "mex.1"}, "297287")
			if err != nil || entries == nil || len(entries) != 0 {
				t.Fatalf("accepted empty history=%+v err=%v", entries, err)
			}
		})
	}
}
