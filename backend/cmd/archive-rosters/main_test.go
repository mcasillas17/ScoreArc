package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestRunRequiresApplyForDatabaseAccess(t *testing.T) {
	rows := []model.Standing{
		{Team: model.Team{ID: "477", Name: "Croatia"}},
		{Team: model.Team{ID: "654", Name: "Senegal"}},
	}
	squads := map[string]model.Squad{"477": {TeamSourceID: "477", Players: []model.SquadMember{{SourceID: "19278"}}}}
	for _, tc := range []struct {
		name                          string
		args                          []string
		providerErr, writerErr        bool
		wantFetch, wantWrite, wantErr bool
	}{
		{name: "default dry run", wantFetch: true},
		{name: "explicit apply", args: []string{"--apply"}, wantFetch: true, wantWrite: true},
		{name: "explicit false", args: []string{"--apply=false"}, wantFetch: true},
		{name: "invalid scope", args: []string{"--apply", "2026"}, wantErr: true},
		{name: "invalid option", args: []string{"--comp", "another"}, wantErr: true},
		{name: "failed provider blocks apply", args: []string{"--apply"}, providerErr: true, wantFetch: true, wantErr: true},
		{name: "failed write reports failure", args: []string{"--apply"}, writerErr: true, wantFetch: true, wantWrite: true, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			fetched, wrote := false, false
			err := run(context.Background(), tc.args, &out, func(context.Context) ([]model.Standing, map[string]model.Squad, error) {
				fetched = true
				if tc.providerErr {
					return nil, nil, errors.New("upstream failure")
				}
				return rows, squads, nil
			}, func(_ context.Context, gotRows []model.Standing, gotSquads map[string]model.Squad) error {
				wrote = true
				if len(gotRows) != 2 || len(gotSquads) != 1 {
					t.Fatalf("wrong write %v %v", gotRows, gotSquads)
				}
				if tc.writerErr {
					return errors.New("transaction aborted")
				}
				return nil
			})
			if (err != nil) != tc.wantErr || fetched != tc.wantFetch || wrote != tc.wantWrite {
				t.Fatalf("err=%v fetched=%v wrote=%v", err, fetched, wrote)
			}
			if err != nil {
				return
			}
			var got struct {
				Mode, Competition, Season string
				Entrants, Squads, Players int
				Unavailable               []struct {
					Team, ESPNID string
					HTTPStatus   int
				}
			}
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			wantMode := "dry-run"
			if tc.wantWrite {
				wantMode = "applied"
			}
			if got.Mode != wantMode || got.Competition != "world-cup" || got.Season != "2002" || got.Entrants != 2 || got.Squads != 1 || got.Players != 1 || len(got.Unavailable) != 1 || got.Unavailable[0].ESPNID != "654" || got.Unavailable[0].HTTPStatus != 404 {
				t.Fatalf("summary=%s", out.Bytes())
			}
		})
	}
}

func TestApplyConnectionErrorHidesCredentials(t *testing.T) {
	const secret = "private-archive-secret"
	t.Setenv("POOLED_DSN", "postgresql://user:"+secret+"@localhost:badport/db")
	err := applyArchive(context.Background(), nil, nil)
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("unsafe connection error: %v", err)
	}
}
