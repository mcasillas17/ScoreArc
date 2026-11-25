package source

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func TestFeedObserverReceivesAcceptedAndRejectedPayloads(t *testing.T) {
	for _, tc := range []struct {
		endpoint, raw string
		valid         bool
	}{
		{"bio", `{"code":404}`, true},
		{"bio", `{"newField":3}`, false},
		{"roster", `{"status":"success","league":{"slug":"fifa.world"},"season":{"year":2026},"team":{"id":"227"},"athletes":[],"newField":3}`, true},
		{"roster", `{"status":"newStatus","league":{"slug":"fifa.world"},"season":{"year":2026},"team":{"id":"227"},"athletes":[]}`, false},
	} {
		t.Run(tc.endpoint, func(t *testing.T) {
			requests, observations := 0, 0
			client := espn.NewWithOptions(espn.Options{HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				requests++
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(tc.raw))}, nil
			})}, MaxAttempts: 1})
			provider := NewObservedESPN(client, func(endpoint, competition string, raw []byte) {
				observations++
				if endpoint != tc.endpoint || competition != "world-cup" || !bytes.Equal(raw, []byte(tc.raw)) {
					t.Fatalf("unexpected observation: endpoint=%s competition=%s", endpoint, competition)
				}
			})
			comp := config.Competition{ID: "world-cup", ESPNSlug: "fifa.world"}
			var err error
			if tc.endpoint == "bio" {
				_, err = provider.AthleteBio(context.Background(), comp, "7")
			} else {
				_, err = provider.Roster(context.Background(), comp, config.Season{ID: "2026"}, "227")
			}
			if requests != 1 || observations != 1 || (err == nil) != tc.valid {
				t.Fatalf("requests=%d observations=%d err=%v", requests, observations, err)
			}
		})
	}
}
