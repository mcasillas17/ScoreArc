package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/mcasillas17/scorearc-backend/config"
)

func newIntegrationStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	container, err := postgrescontainer.Run(
		ctx,
		"postgres:16-alpine",
		postgrescontainer.WithDatabase("scorearc"),
		postgrescontainer.WithUsername("scorearc_admin"),
		postgrescontainer.WithPassword("scorearc_admin"),
		postgrescontainer.BasicWaitStrategies(),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	testcontainers.CleanupContainer(t, container)

	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("postgres connection string: %v", err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	t.Cleanup(pool.Close)

	for _, migration := range []string{
		"../migrations/0001_init.up.sql",
		"../migrations/0002_snapshots.up.sql",
		"../migrations/0003_ingester_delete_grant.up.sql",
		"../migrations/0004_ingester_hardening.up.sql",
	} {
		sql, err := os.ReadFile(migration)
		if err != nil {
			t.Fatalf("read migration %s: %v", migration, err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("apply migration %s: %v", migration, err)
		}
	}

	seedIntegrationData(t, pool)
	if _, err := pool.Exec(ctx, `
		CREATE USER scorearc_reader_test WITH PASSWORD 'reader_test_password';
		GRANT scorearc_reader TO scorearc_reader_test;
	`); err != nil {
		t.Fatalf("create reader login: %v", err)
	}
	readerConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse reader connection: %v", err)
	}
	readerConfig.ConnConfig.User = "scorearc_reader_test"
	readerConfig.ConnConfig.Password = "reader_test_password"
	readerPool, err := pgxpool.NewWithConfig(ctx, readerConfig)
	if err != nil {
		t.Fatalf("connect as reader: %v", err)
	}
	t.Cleanup(readerPool.Close)
	if err := readerPool.Ping(ctx); err != nil {
		t.Fatalf("ping as reader: %v", err)
	}
	return NewStore(readerPool), pool
}

func seedIntegrationData(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	statements := []string{
		`INSERT INTO team (id, name, abbr, crest_url) VALUES
			('arg', 'Argentina', 'ARG', 'https://cdn.scorearc.futbol/arg.png'),
			('fra', 'France', 'FRA', 'https://cdn.scorearc.futbol/fra.png'),
			('tbd', 'Semifinal Winner', 'TBD', NULL),
			('crestless', 'Crestless FC', 'CLF', NULL)`,
		`INSERT INTO match
			(id, comp_id, season_id, round, kickoff, state, home_team_id, away_team_id,
			 home_score, away_score, minute, status_detail, status_name, winner_id, note,
			 home_placeholder, away_placeholder)
		 VALUES
			('match-final', 'world-cup', '2026', 'final', '2026-07-19T19:00:00Z', 'live', 'arg', 'fra', 2, 2, '84''', '84''', 'STATUS_IN_PROGRESS', NULL, NULL, true, false),
			('match-semi', 'world-cup', '2026', 'semifinals', '2026-07-15T19:00:00Z', 'scheduled', 'tbd', 'crestless', NULL, NULL, NULL, 'TBD', 'STATUS_SCHEDULED', NULL, NULL, true, false),
			('other-comp', 'premier-league', '2026-27', NULL, '2026-08-15T14:00:00Z', 'scheduled', 'arg', 'fra', NULL, NULL, NULL, 'Scheduled', 'STATUS_SCHEDULED', NULL, NULL, false, false)`,
		`INSERT INTO match_detail
			(match_id, scorers, cards, stats, win_probability, shootout, shootout_detail,
			 lineups, videos, info, form, commentary, h2h)
		 VALUES
			('match-final',
			 '[{"teamId":"arg","player":"Lionel Messi","minute":"23''","penalty":false,"shootout":false}]',
			 '[]',
			 '{"home":{"possession":51,"shots":10,"shotsOnTarget":5,"shotAccuracy":50,"corners":4,"offsides":1,"passes":500,"passAccuracy":88,"crosses":12,"crossAccuracy":25,"longBalls":30,"tackles":15,"tackleAccuracy":80,"interceptions":7,"clearances":9,"blockedShots":2,"saves":3,"fouls":8,"yellowCards":1,"redCards":0},"away":{"possession":49,"shots":8,"shotsOnTarget":4,"shotAccuracy":50,"corners":3,"offsides":2,"passes":470,"passAccuracy":86,"crosses":10,"crossAccuracy":20,"longBalls":35,"tackles":16,"tackleAccuracy":75,"interceptions":6,"clearances":11,"blockedShots":1,"saves":3,"fouls":10,"yellowCards":2,"redCards":0}}',
			 '{"home":40,"draw":30,"away":30}', NULL, NULL,
			 '{"home":{"formation":"4-3-3","players":[]},"away":{"formation":"4-2-3-1","players":[]}}',
			 '[]', '{"venue":"MetLife Stadium","city":"East Rutherford","referee":null,"attendance":82500}',
			 '{"home":[],"away":[]}', '[]', '[]')`,
		`INSERT INTO standing
			(comp_id, season_id, team_id, group_id, group_name, rank, played, wins, draws, losses,
			 goals_for, goals_against, goal_difference, points, advanced)
		 VALUES
			('world-cup', '2026', 'arg', 'A', 'Group A', 1, 3, 3, 0, 0, 7, 1, 6, 9, true),
			('world-cup', '2026', 'fra', 'A', 'Group A', 2, 3, 2, 0, 1, 5, 2, 3, 6, true),
			('premier-league', '2026-27', 'arg', NULL, NULL, 1, 1, 1, 0, 0, 2, 0, 2, 3, false)`,
		`INSERT INTO top_scorer
			(comp_id, season_id, rank, player, team_abbr, team_name, team_crest_url, goals, matches)
		 VALUES ('world-cup', '2026', 1, 'Lionel Messi', 'ARG', 'Argentina', 'https://cdn.scorearc.futbol/arg.png', 7, 6),
		        ('world-cup', '2026', 2, 'Mystery Player', NULL, NULL, NULL, 5, NULL)`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("seed database: %v\nSQL: %s", err, statement)
		}
	}
}

func TestStoreIntegration(t *testing.T) {
	store, pool := newIntegrationStore(t)
	ctx := context.Background()

	t.Run("matches reconstruct exact detail and isolate competition", func(t *testing.T) {
		matches, err := store.Matches(ctx, "world-cup", "2026")
		if err != nil {
			t.Fatal(err)
		}
		if len(matches) != 2 {
			t.Fatalf("len(matches) = %d, want 2", len(matches))
		}
		if matches[1].ID != "match-final" || matches[1].Kickoff != "2026-07-19T19:00:00Z" || len(matches[1].Scorers) != 1 || matches[1].Cards == nil || matches[1].Stats == nil || matches[1].WinProbability == nil {
			t.Fatalf("final match = %+v", matches[1])
		}
		if matches[0].Scorers == nil || matches[0].Cards == nil {
			t.Fatalf("left-joined detail collections must be non-nil: %+v", matches[0])
		}
		empty, err := store.Matches(ctx, "world-cup", "1998")
		if err != nil || empty == nil || len(empty) != 0 {
			t.Fatalf("empty matches = %#v, err %v", empty, err)
		}
	})

	t.Run("standings group rows and use a league default", func(t *testing.T) {
		groups, err := store.Standings(ctx, "world-cup", "2026", "World Cup")
		if err != nil {
			t.Fatal(err)
		}
		if len(groups) != 1 || groups[0].ID != "A" || groups[0].Name != "Group A" || len(groups[0].Standings) != 2 {
			t.Fatalf("groups = %+v", groups)
		}
		league, err := store.Standings(ctx, "premier-league", "2026-27", "Premier League")
		if err != nil {
			t.Fatal(err)
		}
		if len(league) != 1 || league[0].ID != "Premier League" || league[0].Name != "Premier League" {
			t.Fatalf("league groups = %+v", league)
		}
	})

	t.Run("bracket uses canonical round order and placeholder state", func(t *testing.T) {
		rounds, err := store.Bracket(ctx, "world-cup", "2026")
		if err != nil {
			t.Fatal(err)
		}
		if len(rounds) != 2 || rounds[0].Slug != "semifinals" || rounds[1].Slug != "final" {
			t.Fatalf("rounds = %+v", rounds)
		}
		if !rounds[0].Matches[0].Home.Placeholder || rounds[0].Matches[0].Away.Placeholder {
			t.Fatalf("placeholder legs = %+v", rounds[0].Matches[0])
		}
		if !rounds[1].Matches[0].Home.Placeholder {
			t.Fatalf("persisted placeholder ignored for crested team: %+v", rounds[1].Matches[0])
		}
	})

	t.Run("match summary reconstructs every collection", func(t *testing.T) {
		summary, err := store.MatchSummary(ctx, "match-final")
		if err != nil {
			t.Fatal(err)
		}
		if len(summary.Scorers) != 1 || summary.Cards == nil || summary.Videos == nil || summary.Commentary == nil || summary.H2H == nil || summary.Lineups == nil || summary.Info == nil || summary.Form == nil {
			t.Fatalf("summary = %+v", summary)
		}
		_, err = store.MatchSummary(ctx, "missing")
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("missing summary error = %v, want ErrNotFound", err)
		}
	})

	t.Run("top scorers normalize nullable team text", func(t *testing.T) {
		scorers, err := store.TopScorers(ctx, "world-cup", "2026")
		if err != nil {
			t.Fatal(err)
		}
		if len(scorers) != 2 || scorers[0].Player != "Lionel Messi" || scorers[1].TeamAbbr != "" || scorers[1].TeamName != "" || scorers[1].Matches != nil {
			t.Fatalf("top scorers = %+v", scorers)
		}
	})

	t.Run("router serves database rows through the reader login", func(t *testing.T) {
		registry, err := config.Load()
		if err != nil {
			t.Fatal(err)
		}
		app := &App{
			store:    store,
			registry: registry,
			logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
			news:     &fakeNewsReader{},
			limiter:  newIPRateLimiter(100, 100),
			health:   newHealthChecker(context.Background(), store.Ping),
		}
		request := httptest.NewRequest(http.MethodGet, "/v1/competitions/world-cup/2026/matches", nil)
		request.RemoteAddr = "192.0.2.1:1234"
		response := httptest.NewRecorder()
		app.router().ServeHTTP(response, request)
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "public, max-age=10" {
			t.Fatalf("response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
		}
	})

	t.Run("reader role is select only", func(t *testing.T) {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		if _, err := conn.Exec(ctx, "SET ROLE scorearc_reader"); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, "SELECT id FROM team LIMIT 1"); err != nil {
			t.Fatalf("reader SELECT denied: %v", err)
		}
		denied := []string{
			"INSERT INTO team (id, name, abbr) VALUES ('blocked', 'Blocked', 'BLK')",
			"UPDATE team SET name = 'Blocked' WHERE id = 'arg'",
			"DELETE FROM team WHERE id = 'arg'",
			"CREATE TABLE public.reader_must_not_create (id int)",
		}
		for _, statement := range denied {
			if _, err := conn.Exec(ctx, statement); err == nil {
				t.Fatalf("reader unexpectedly executed %q", statement)
			}
		}
	})

	t.Run("parameter-looking input stays data", func(t *testing.T) {
		matches, err := store.Matches(ctx, "world-cup' OR '1'='1", "2026")
		if err != nil || matches == nil || len(matches) != 0 {
			t.Fatalf("injection-shaped query = %#v, err %v", matches, err)
		}
	})

	t.Run("ping reports connectivity", func(t *testing.T) {
		pingCtx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		if err := store.Ping(pingCtx); err != nil {
			t.Fatal(err)
		}
	})
}
