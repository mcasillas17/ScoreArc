package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	writerstore "github.com/mcasillas17/scorearc-backend/shared/store"
)

type careerResponseTransport string

func (body careerResponseTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
}

func TestCareerObservationRejectsIncompleteSourceBeforeWriterAndReader(t *testing.T) {
	ctx := context.Background()
	reader, owner := newIntegrationStore(t)
	writer, err := writerstore.New(ctx, owner.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	if _, err := owner.Exec(ctx, `INSERT INTO player(id,full_name) VALUES ($1,'Measured Player')`, testPlayerID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO squad_membership(competition_id,season_id,team_id,player_id,source) VALUES ('world-cup','2026','nat-arg',$1,'espn')`, testPlayerID); err != nil {
		t.Fatal(err)
	}
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.store = reader
	now := time.Now().UTC().Add(time.Minute)
	app.now = func() time.Time { return now }
	old := now.Add(-33 * 24 * time.Hour).Truncate(time.Microsecond)
	ingest := func(raw string) error {
		client := espn.NewWithOptions(espn.Options{MaxAttempts: 1, HTTP: &http.Client{Transport: careerResponseTransport(raw)}})
		entries, err := source.NewESPN(client).AthleteBio(ctx, config.Competition{ESPNSlug: "mex.1"}, "297287")
		if err != nil {
			return err
		}
		return writer.ReplaceTeamHistory(ctx, uuid.MustParse(testPlayerID), "espn", entries)
	}
	valid := `{"teamHistory":[{"id":"222","displayName":"Querétaro","seasons":"2025-CURRENT"},{"id":"233","displayName":"Pumas","seasons":"2023-2025"}]}`
	for name, raw := range map[string]string{
		"truncated empty":         `{"teamHistory":[],"truncated":true}`,
		"incomplete empty":        `{"teamHistory":[],"hasMore":true}`,
		"malformed empty":         `{"teamHistory":[{}]}`,
		"malformed tail":          `{"teamHistory":[{"id":"222","displayName":"Querétaro","seasons":"2025-CURRENT"},{}]}`,
		"truncated nonempty":      `{"teamHistory":[{"id":"222","displayName":"Querétaro","seasons":"2025-CURRENT"}],"pagination":{"total":2}}`,
		"contradictory not found": `{"code":404,"truncated":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := ingest(valid); err != nil {
				t.Fatal(err)
			}
			if _, err := owner.Exec(ctx, `UPDATE player SET bio_fetched_at=$1,bio_observed_at=$1 WHERE id=$2`, old, testPlayerID); err != nil {
				t.Fatal(err)
			}
			if err := ingest(raw); err == nil {
				t.Error("unvalidated history accepted by source and written")
			}
			var fetched, observed time.Time
			var rows int
			if err := owner.QueryRow(ctx, `SELECT bio_fetched_at,bio_observed_at,(SELECT count(*) FROM player_team_history WHERE player_id=$1) FROM player WHERE id=$1`, testPlayerID).Scan(&fetched, &observed, &rows); err != nil {
				t.Fatal(err)
			}
			if rows != 2 || !observed.Equal(old) || !fetched.Equal(old) {
				t.Errorf("retained history=%d observed=%v fetched=%v; want two rows at %v", rows, observed, fetched, old)
			}
			response := performRequest(app.router(), "GET", playerPath)
			if response.Code != 200 {
				t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
			}
			career := resourceHeader(t, response.Header()).Resources["career"]
			if career.Status != "stale" || career.Availability != "complete" || career.ObservedAt == nil || !career.ObservedAt.Equal(old) {
				t.Errorf("retained career metadata=%+v", career)
			}
			var profile PlayerProfile
			if err := json.Unmarshal(response.Body.Bytes(), &profile); err != nil {
				t.Fatal(err)
			}
			if len(profile.Career) != 2 || profile.Career[0].TeamName != "Querétaro" || profile.Career[1].TeamName != "Pumas" {
				t.Fatalf("retained career facts=%+v", profile.Career)
			}
		})
	}
	for _, raw := range []string{`{"teamHistory":[]}`, `{"code":404}`} {
		if err := ingest(valid); err != nil {
			t.Fatal(err)
		}
		if err := ingest(raw); err != nil {
			t.Fatal(err)
		}
		response := performRequest(app.router(), "GET", playerPath)
		if response.Code != 200 {
			t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
		}
		career := resourceHeader(t, response.Header()).Resources["career"]
		if career.Status != "empty" || career.Availability != "empty" || career.ObservedAt == nil || !career.ObservedAt.After(old) {
			t.Fatalf("validated empty career=%+v", career)
		}
	}
}
