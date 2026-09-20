package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func newRecoveryPostgres(t *testing.T) (*store.Store, *pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("recovery"), postgres.WithUsername("postgres"), postgres.WithPassword("postgres"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(time.Minute)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = container.Terminate(ctx) })
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	files, err := filepath.Glob("../migrations/*.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("apply %s: %v", path, err)
		}
	}
	repo, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repo.Close)
	return repo, pool, dsn
}

func TestRecoveryPipelineWithPostgresAcrossRestart(t *testing.T) {
	ctx := context.Background()
	repo, pool, _ := newRecoveryPostgres(t)
	comp, _, src, now := recoveryFixture()
	if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
		t.Fatal(err)
	}
	r := testRunner(src.fakeSource, &fakeRepository{}, comp)
	r.repo, r.source, r.now = repo, src, func() time.Time { return now }
	stuck := src.fresh
	stuck.State, stuck.StatusName = model.MatchStateLive, "STATUS_FIRST_HALF"
	oldScore := 0
	stuck.AwayScore = &oldScore
	identity, err := r.resolveMatch(ctx, comp, comp.CurrentSeasonId, stuck)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertMatch(ctx, identity, stuck); err != nil {
		t.Fatal(err)
	}
	src.err = errors.New("temporary provider outage")
	season := comp.Seasons[comp.CurrentSeasonId]
	if _, _, err := r.recoverOverdueMatches(ctx, comp, season); err == nil {
		t.Fatal("outage reported as success")
	}
	restarted := testRunner(src.fakeSource, &fakeRepository{}, comp)
	restarted.repo, restarted.source, restarted.now = repo, src, func() time.Time { return now }
	src.err = nil
	if _, _, err := restarted.recoverOverdueMatches(ctx, comp, season); err != nil {
		t.Fatal(err)
	}
	if src.calls != 1 {
		t.Fatal("new runner lost persisted retry deadline")
	}
	now = now.Add(5 * time.Minute)
	result, _, err := restarted.recoverOverdueMatches(ctx, comp, season)
	if err != nil {
		t.Fatal(err)
	}
	if !result.finalized || src.calls != 2 || src.summaryCalls != 0 {
		t.Fatalf("recovery=%+v lookups=%d duplicate summaries=%d", result, src.calls, src.summaryCalls)
	}
	var state string
	var away int
	var finalized, observed *time.Time
	if err := pool.QueryRow(ctx, `SELECT m.state,m.away_score,m.finalized_at,s.observed_at
		FROM match m JOIN match_sync_status s ON s.match_id=m.id WHERE m.id=$1`,
		identity.MatchID).Scan(&state, &away, &finalized, &observed); err != nil {
		t.Fatal(err)
	}
	if state != "finished" || away != 1 || finalized == nil || observed == nil || !observed.Equal(now) {
		t.Fatalf("stored recovery state=%s away=%d final=%v observed=%v", state, away, finalized, observed)
	}
	now = now.Add(24 * time.Hour)
	if _, _, err := restarted.recoverOverdueMatches(ctx, comp, season); err != nil {
		t.Fatal(err)
	}
	if src.calls != 2 {
		t.Fatal("finalized match was recovered twice")
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM match`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("duplicate match: rows=%d err=%v", rows, err)
	}
}

type additiveFailureStore struct {
	*store.Store
	kind string
}

func (s additiveFailureStore) WriteParticipation(ctx context.Context, source string, id uuid.UUID, home, away string, part *model.MatchParticipation) (store.ParticipationStats, error) {
	if s.kind == "participation" {
		return store.ParticipationStats{}, errors.New("participation write unavailable")
	}
	return s.Store.WriteParticipation(ctx, source, id, home, away, part)
}

func (s additiveFailureStore) WriteCommentary(ctx context.Context, id uuid.UUID, lines []model.CommentaryLine) (int, error) {
	if s.kind == "commentary" {
		return 0, errors.New("commentary write unavailable")
	}
	return s.Store.WriteCommentary(ctx, id, lines)
}

func TestAcceptedLiveRecoveryResetsBackoffDespiteAdditiveFailure(t *testing.T) {
	for _, kind := range []string{"participation", "commentary"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			repo, pool, dsn := newRecoveryPostgres(t)
			comp, _, src, now := recoveryFixture()
			if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
				t.Fatal(err)
			}
			src.fresh.State, src.fresh.StatusName = model.MatchStateLive, "STATUS_SECOND_HALF"
			r := testRunner(src.fakeSource, &fakeRepository{}, comp)
			r.repo, r.source, r.now = repo, src, func() time.Time { return now }
			identity, err := r.resolveMatch(ctx, comp, comp.CurrentSeasonId, src.fresh)
			if err != nil {
				t.Fatal(err)
			}
			if err := repo.UpsertMatch(ctx, identity, src.fresh); err != nil {
				t.Fatal(err)
			}
			season := comp.Seasons[comp.CurrentSeasonId]
			src.err = errors.New("provider outage")
			for i := range 3 {
				if _, _, err := r.recoverOverdueMatches(ctx, comp, season); err == nil {
					t.Fatal("provider failure hidden")
				}
				now = now.Add(matchRecoveryDelay(i))
			}
			src.err = nil
			r.repo = additiveFailureStore{Store: repo, kind: kind}
			_, accepted, err := r.recoverOverdueMatches(ctx, comp, season)
			if err == nil || !accepted[identity.MatchID] {
				t.Fatalf("core acceptance or ancillary error lost: accepted=%v err=%v", accepted, err)
			}
			var observed, retryAt time.Time
			var attempts int
			var lastError string
			if err := pool.QueryRow(ctx, `SELECT observed_at,retry_at,attempts,last_error
				FROM match_sync_status WHERE match_id=$1`, identity.MatchID).
				Scan(&observed, &retryAt, &attempts, &lastError); err != nil {
				t.Fatal(err)
			}
			if !observed.Equal(now) || !retryAt.Equal(now.Add(5*time.Minute)) || attempts != 0 || lastError != "" {
				t.Fatalf("accepted core observation retained failure backoff: at=%v retry=%v attempts=%d err=%q", observed, retryAt, attempts, lastError)
			}
			restarted, err := store.New(ctx, dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer restarted.Close()
			for _, tc := range []struct {
				delta time.Duration
				want  int
			}{{5*time.Minute - time.Millisecond, 0}, {5 * time.Minute, 1}} {
				pending, err := restarted.PendingMatchRecovery(ctx, comp.ID, season.ID, sourceESPN, now.Add(tc.delta), 5)
				if err != nil || len(pending) != tc.want {
					t.Fatalf("restart boundary=%v pending=%d want=%d err=%v", tc.delta, len(pending), tc.want, err)
				}
			}

		})
	}
}

func TestTerminalRecoveryPreservesKnownScoresAndRecordsSuccess(t *testing.T) {
	for _, status := range []string{"STATUS_CANCELED", "STATUS_ABANDONED", "STATUS_FORFEIT"} {
		t.Run(status, func(t *testing.T) {
			ctx := context.Background()
			repo, pool, _ := newRecoveryPostgres(t)
			comp, _, src, now := recoveryFixture()
			if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
				t.Fatal(err)
			}
			r := testRunner(src.fakeSource, &fakeRepository{}, comp)
			r.repo, r.source, r.now = repo, src, func() time.Time { return now }
			live := src.fresh
			home, away := 1, 0
			live.State, live.StatusName = model.MatchStateLive, "STATUS_SECOND_HALF"
			live.HomeScore, live.AwayScore = &home, &away
			id, err := r.resolveMatch(ctx, comp, comp.CurrentSeasonId, live)
			if err != nil {
				t.Fatal(err)
			}
			if err := repo.UpsertMatch(ctx, id, live); err != nil {
				t.Fatal(err)
			}
			src.fresh.StatusName = status
			src.fresh.HomeScore, src.fresh.AwayScore = nil, nil
			r.runCycle(ctx, true)
			var state, storedStatus, lastError, poll string
			var finalized, observed *time.Time
			var attempts int
			if err := pool.QueryRow(ctx, `SELECT m.state,m.status_name,m.home_score,m.away_score,
							m.finalized_at,s.observed_at,s.attempts,s.last_error,p.outcome
							FROM match m JOIN match_sync_status s ON s.match_id=m.id
							JOIN match_poll_status p ON p.competition_id=m.competition_id AND p.season_id=m.season_id
							WHERE m.id=$1`, id.MatchID).Scan(&state, &storedStatus, &home, &away,
				&finalized, &observed, &attempts, &lastError, &poll); err != nil {
				t.Fatal(err)
			}
			if state != "finished" || storedStatus != status || home != 1 || away != 0 ||
				finalized == nil || observed == nil || !observed.Equal(now) ||
				attempts != 0 || lastError != "" || poll != "ok" {
				t.Fatalf("valid terminal result not accepted: state=%s status=%s score=%d-%d finalized=%v observed=%v attempts=%d error=%q poll=%q",
					state, storedStatus, home, away, finalized, observed, attempts, lastError, poll)
			}
			bad := src.fresh
			changedScore := 9
			bad.HomeScore = &changedScore
			if err := repo.RecordMatchObservation(ctx, id, bad, now.Add(time.Minute)); err == nil {
				t.Fatal("supplied contradictory terminal score renewed freshness")
			}
		})
	}
}

func TestGroupRecoveryFinalizesShootoutWinnerBeforeProviderFlags(t *testing.T) {
	for _, homeWins := range []bool{true, false} {
		for _, reversed := range []bool{false, true} {
			t.Run(fmt.Sprintf("homeWins=%t/reversed=%t", homeWins, reversed), func(t *testing.T) {
				ctx := context.Background()
				repo, pool, _ := newRecoveryPostgres(t)
				comp, _, src, now := recoveryFixture()
				comp.ESPNSlug = "concacaf.leagues.cup"
				comp.Seasons["2026"] = config.Season{ID: "2026", HasBracket: true}
				if err := repo.ApplyCompetitionSeed(ctx, []config.Competition{comp}); err != nil {
					t.Fatal(err)
				}
				r := testRunner(src.fakeSource, &fakeRepository{}, comp)
				r.repo, r.now = repo, func() time.Time { return now }
				live := src.fresh
				one, group := 1, false
				live.State, live.StatusName = model.MatchStateLive, "STATUS_SECOND_HALF"
				live.HomeScore, live.AwayScore = &one, &one
				live.BracketRequired, live.BracketConfirmed = &group, true
				id, err := r.resolveMatch(ctx, comp, comp.CurrentSeasonId, live)
				if err != nil {
					t.Fatal(err)
				}
				wrong, want := id.AwayTeamID, id.HomeTeamID
				homePK, awayPK := 4, 3
				if !homeWins {
					wrong, want = id.HomeTeamID, id.AwayTeamID
					homePK, awayPK = 3, 4
				}
				id.WinnerTeamID = &wrong
				if err := repo.UpsertMatch(ctx, id, live); err != nil {
					t.Fatal(err)
				}
				body := fmt.Sprintf(`{"header":{"id":"m1","league":{"slug":"concacaf.leagues.cup"},"season":{"year":2026},
					"competitions":[{"id":"m1","date":"2026-09-15T08:00:00Z",
					"status":{"type":{"name":"STATUS_FINAL_PEN","state":"post","completed":true}},
					"competitors":[
						{"homeAway":"home","team":{"id":"home"},"score":"1","shootoutScore":%d,"winner":%t},
						{"homeAway":"away","team":{"id":"away"},"score":"1","shootoutScore":%d,"winner":%t}
					]}]},"gameInfo":{"venue":{"fullName":"Test venue"}}}`,
					homePK, reversed && !homeWins, awayPK, reversed && homeWins)
				provider := source.NewESPN(espn.NewWithOptions(espn.Options{
					HTTP: &http.Client{Transport: summaryResponseTransport(body)}, MaxAttempts: 1,
				}))
				r.source = validatedMatchSource{src.fakeSource, provider}
				result, _, err := r.recoverOverdueMatches(ctx, comp, comp.Seasons["2026"])
				if err != nil || !result.finalized {
					t.Fatalf("group recovery failed: result=%+v err=%v", result, err)
				}
				var winner string
				var home, away int
				var finalized time.Time
				var shootout []byte
				if err := pool.QueryRow(ctx, `SELECT m.winner_id,m.home_score,m.away_score,m.finalized_at,d.shootout
					FROM match m JOIN match_detail d ON d.match_id=m.id WHERE m.id=$1`,
					id.MatchID).Scan(&winner, &home, &away, &finalized, &shootout); err != nil {
					t.Fatal(err)
				}
				var totals model.Shootout
				if err := json.Unmarshal(shootout, &totals); err != nil {
					t.Fatal(err)
				}
				if winner != want || home != 1 || away != 1 || finalized.IsZero() ||
					totals.HomeScore != homePK || totals.AwayScore != awayPK {
					t.Fatalf("sealed wrong shootout result: winner=%s want=%s regular=%d-%d penalties=%+v", winner, want, home, away, totals)
				}
			})
		}
	}
}
