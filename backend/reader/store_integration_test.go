package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
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

	migrations, err := filepath.Glob("../migrations/*.up.sql")
	if err != nil {
		t.Fatalf("list migrations: %v", err)
	}
	sort.Strings(migrations)
	for _, migration := range migrations {
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

// Canonical ids throughout: slug-keyed teams with a kind, uuid-keyed matches
// carrying provenance, and competition/season rows the match foreign keys need.
// The reader is crosswalk-blind by design — it never joins *_external_ref — so
// this fixture deliberately has none.
const (
	finalMatchID   = "018f0000-0000-7000-8000-000000000001"
	semiMatchID    = "018f0000-0000-7000-8000-000000000002"
	otherCompMatch = "018f0000-0000-7000-8000-000000000003"
)

func seedIntegrationData(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	statements := []string{
		`INSERT INTO competition (id, name, short_name, kind) VALUES
			('world-cup', 'FIFA World Cup', 'World Cup', 'cup'),
			('premier-league', 'Premier League', 'Premier League', 'league')`,
		`INSERT INTO season (competition_id, id, label, has_bracket) VALUES
			('world-cup', '2026', '2026', true),
			('world-cup', '1998', '1998', true),
			('premier-league', '2026-27', '2026-27', false)`,
		`INSERT INTO team (id, kind, name, abbr, crest_url, provisional) VALUES
			('nat-arg', 'national', 'Argentina', 'ARG', 'https://cdn.scorearc.futbol/arg.png', false),
			('nat-fra', 'national', 'France', 'FRA', 'https://cdn.scorearc.futbol/fra.png', false),
			('prov-espn-9991', 'national', 'Semifinal Winner', 'TBD', NULL, true),
			('eng-crestless', 'club', 'Crestless FC', 'CLF', NULL, false)`,
		`INSERT INTO match
			(id, competition_id, season_id, round, kickoff, state, home_team_id, away_team_id,
			 home_score, away_score, minute, status_detail, status_name, winner_id, note,
			 home_placeholder, away_placeholder, source)
		 VALUES
			('` + finalMatchID + `', 'world-cup', '2026', 'final', '2026-07-19T19:00:00Z', 'live', 'nat-arg', 'nat-fra', 2, 2, '84''', '84''', 'STATUS_IN_PROGRESS', NULL, NULL, true, false, 'espn'),
			('` + semiMatchID + `', 'world-cup', '2026', 'semifinals', '2026-07-15T19:00:00Z', 'scheduled', 'prov-espn-9991', 'eng-crestless', NULL, NULL, NULL, 'TBD', 'STATUS_SCHEDULED', NULL, NULL, true, false, 'espn'),
			('` + otherCompMatch + `', 'premier-league', '2026-27', NULL, '2026-08-15T14:00:00Z', 'scheduled', 'nat-arg', 'nat-fra', NULL, NULL, NULL, 'Scheduled', 'STATUS_SCHEDULED', NULL, NULL, false, false, 'espn')`,
		`INSERT INTO match_detail
			(match_id, scorers, cards, stats, win_probability, shootout, shootout_detail,
			 lineups, videos, info, form, commentary, h2h)
		 VALUES
			('` + finalMatchID + `',
			 '[{"teamId":"nat-arg","player":"Lionel Messi","minute":"23''","penalty":false,"shootout":false}]',
			 '[]',
			 '{"home":{"possession":51,"shots":10,"shotsOnTarget":5,"shotAccuracy":50,"corners":4,"offsides":1,"passes":500,"passAccuracy":88,"crosses":12,"crossAccuracy":25,"longBalls":30,"tackles":15,"tackleAccuracy":80,"interceptions":7,"clearances":9,"blockedShots":2,"saves":3,"fouls":8,"yellowCards":1,"redCards":0},"away":{"possession":49,"shots":8,"shotsOnTarget":4,"shotAccuracy":50,"corners":3,"offsides":2,"passes":470,"passAccuracy":86,"crosses":10,"crossAccuracy":20,"longBalls":35,"tackles":16,"tackleAccuracy":75,"interceptions":6,"clearances":11,"blockedShots":1,"saves":3,"fouls":10,"yellowCards":2,"redCards":0}}',
			 '{"home":40,"draw":30,"away":30}', NULL, NULL,
			 '{"home":{"formation":"4-3-3","players":[]},"away":{"formation":"4-2-3-1","players":[]}}',
			 '[]', '{"venue":"MetLife Stadium","city":"East Rutherford","referee":null,"attendance":82500}',
			 '{"home":[],"away":[]}', '[]', '[]')`,
		`INSERT INTO standing
			(competition_id, season_id, team_id, group_id, group_name, rank, played, wins, draws, losses,
			 goals_for, goals_against, goal_difference, points, advanced, source)
		 VALUES
			('world-cup', '2026', 'nat-arg', 'A', 'Group A', 1, 3, 3, 0, 0, 7, 1, 6, 9, true, 'espn'),
			('world-cup', '2026', 'nat-fra', 'A', 'Group A', 2, 3, 2, 0, 1, 5, 2, 3, 6, true, 'espn'),
			('premier-league', '2026-27', 'nat-arg', NULL, NULL, 1, 1, 1, 0, 0, 2, 0, 2, 3, false, 'espn')`,
		`INSERT INTO top_scorer
			(competition_id, season_id, category, rank, player, team_abbr, team_name, team_crest_url, goals, matches, source)
		 VALUES ('world-cup', '2026', 'goals', 1, 'Lionel Messi', 'ARG', 'Argentina', 'https://cdn.scorearc.futbol/arg.png', 7, 6, 'espn'),
		        ('world-cup', '2026', 'goals', 2, 'Mystery Player', NULL, NULL, NULL, 5, NULL, 'espn'),
		        ('world-cup', '2026', 'assists', 1, 'Playmaker', 'FRA', 'France', 'https://cdn.scorearc.futbol/fra.png', 6, 6, 'espn')`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatalf("seed database: %v\nSQL: %s", err, statement)
		}
	}
}

// The reader's contract does not change: /top-scorers is still goals.
func TestReaderTopScorersFiltersToGoals(t *testing.T) {
	store, _ := newIntegrationStore(t)
	scorers, err := store.TopScorers(context.Background(), "world-cup", "2026")
	if err != nil {
		t.Fatal(err)
	}
	if len(scorers) != 2 {
		t.Fatalf("top scorers = %+v, want exactly the two goals rows", scorers)
	}
	for _, scorer := range scorers {
		if scorer.Player == "Playmaker" {
			t.Fatalf("top scorers included assists row: %+v", scorers)
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
		if matches[1].ID != finalMatchID || matches[1].Kickoff != "2026-07-19T19:00:00Z" || len(matches[1].Scorers) != 1 || matches[1].Cards == nil || matches[1].Stats == nil || matches[1].WinProbability == nil {
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
		summary, err := store.MatchSummary(ctx, finalMatchID)
		if err != nil {
			t.Fatal(err)
		}
		if len(summary.Scorers) != 1 || summary.Cards == nil || summary.Videos == nil || summary.Commentary == nil || summary.H2H == nil || summary.Lineups == nil || summary.Info == nil || summary.Form == nil {
			t.Fatalf("summary = %+v", summary)
		}
		// A well-formed id nobody has, and a path segment that is not an id at
		// all, are both plainly 404s — the second must not reach Postgres as a
		// uuid type error.
		for _, id := range []string{"018f0000-0000-7000-8000-0000000000ff", "missing"} {
			if _, err := store.MatchSummary(ctx, id); !errors.Is(err, ErrNotFound) {
				t.Fatalf("summary for %q error = %v, want ErrNotFound", id, err)
			}
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
			"INSERT INTO team (id, kind, name, abbr) VALUES ('blocked', 'club', 'Blocked', 'BLK')",
			"UPDATE team SET name = 'Blocked' WHERE id = 'nat-arg'",
			"DELETE FROM team WHERE id = 'nat-arg'",
			"INSERT INTO team_external_ref (source, source_id, team_id) VALUES ('espn', '202', 'nat-arg')",
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
