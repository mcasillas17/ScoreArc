package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	postgrescontainer "github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/mcasillas17/scorearc-backend/config"
)

func newIntegrationStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	return newIntegrationStoreThrough(t, "")
}

// An empty lastMigration applies the complete chain. A filename pins a test
// to a historical schema so it can exercise a forward migration in place.
func newIntegrationStoreThrough(t *testing.T, lastMigration string) (*Store, *pgxpool.Pool) {
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
		if lastMigration != "" && filepath.Base(migration) > lastMigration {
			break
		}
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

const ligaTeamPath = "/v1/competitions/liga-mx/2026-apertura/teams/mex-america"

// Synthetic roster data covers UUIDs, measured zeroes, unmeasured fields,
// an absent statistics row, and a present all-null statistics row.
func seedLigaTeam(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO competition (id, name, short_name, kind) VALUES ('liga-mx', 'Liga MX', 'Liga MX', 'league');
		INSERT INTO season (competition_id, id, label) VALUES
		('liga-mx', '2026-apertura', 'Apertura 2026'), ('liga-mx', '2026-clausura', 'Clausura 2026');
		INSERT INTO team (id, kind, name, abbr) VALUES
		('mex-america', 'club', 'América', 'AME'), ('mex-empty', 'club', 'Empty Club', 'EMP');
		INSERT INTO standing (competition_id, season_id, team_id, rank, played,
		wins, draws, losses, goals_for, goals_against, goal_difference, points, source)
		VALUES ('liga-mx', '2026-apertura', 'mex-america', 2, 5, 3, 1, 1, 9, 4, 5, 10, 'espn');
		INSERT INTO player (id, full_name, known_as, nationality) VALUES
		('018f0000-0000-7000-8000-000000000101', 'Measured Player', 'Captain', 'Mexico'),
		('018f0000-0000-7000-8000-000000000102', 'Unmeasured Player', NULL, NULL),
		('018f0000-0000-7000-8000-000000000103', 'Null Statistics', NULL, NULL);
		INSERT INTO squad_membership (competition_id, season_id, team_id, player_id, shirt_number, position, source) VALUES
		('liga-mx', '2026-apertura', 'mex-america', '018f0000-0000-7000-8000-000000000101', 9, 'F', 'espn'),
		('liga-mx', '2026-apertura', 'mex-america', '018f0000-0000-7000-8000-000000000102', NULL, NULL, 'espn'),
		('liga-mx', '2026-apertura', 'mex-america', '018f0000-0000-7000-8000-000000000103', 20, 'D', 'espn');
		INSERT INTO player_season_stat (competition_id, season_id, player_id, team_id, appearances, goals, assists, source) VALUES
		('liga-mx', '2026-apertura', '018f0000-0000-7000-8000-000000000101', 'mex-america', 5, 3, 0, 'espn'),
		('liga-mx', '2026-apertura', '018f0000-0000-7000-8000-000000000103', NULL, NULL, NULL, NULL, 'espn'),
		('liga-mx', '2026-clausura', '018f0000-0000-7000-8000-000000000102', 'mex-america', 8, 8, 8, 'espn');
		INSERT INTO match (id, competition_id, season_id, kickoff, state, home_team_id, away_team_id, source) VALUES
		('018f0000-0000-7000-8000-000000000201', 'liga-mx', '2026-apertura', '2026-09-06T00:00:00Z', 'scheduled', 'mex-america', 'nat-arg', 'espn'),
		('018f0000-0000-7000-8000-000000000202', 'liga-mx', '2026-apertura', '2026-09-07T00:00:00Z', 'scheduled', 'nat-fra', 'mex-america', 'espn'),
		('018f0000-0000-7000-8000-000000000203', 'liga-mx', '2026-clausura', '2026-02-07T00:00:00Z', 'scheduled', 'nat-fra', 'mex-america', 'espn'),
		('018f0000-0000-7000-8000-000000000204', 'world-cup', '2026', '2026-07-07T00:00:00Z', 'scheduled', 'nat-fra', 'mex-america', 'espn'),
		('018f0000-0000-7000-8000-000000000205', 'liga-mx', '2026-apertura', '2026-09-08T00:00:00Z', 'scheduled', 'nat-fra', 'nat-arg', 'espn');
		INSERT INTO match_detail (match_id, scorers, cards, shootout_detail) VALUES
		('018f0000-0000-7000-8000-000000000201', 'null', 'null', '{"home":null,"away":null}');
	`)
	if err != nil {
		t.Fatalf("seed Liga MX: %v", err)
	}
}

func teamIntegrationApp(t *testing.T, store *Store, logs *bytes.Buffer) *App {
	t.Helper()
	app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
	app.store = store
	app.health = newHealthChecker(context.Background(), store.Ping)
	app.logger = slog.New(slog.NewJSONHandler(logs, nil))
	return app
}

func assertTeamResponse(t *testing.T, response *httptest.ResponseRecorder) TeamProfile {
	t.Helper()
	if response.Code != 200 || response.Header().Get("Cache-Control") != "public, max-age=120" {
		t.Fatalf("team response: status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	var value any
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	schema := loadOpenAPI(t).Paths.Value("/v1/competitions/{comp}/{season}/teams/{teamId}").Get.Responses.Status(200).Value.Content.Get("application/json").Schema
	if err := schema.Value.VisitJSON(value); err != nil {
		t.Fatalf("team response violates OpenAPI: %v", err)
	}
	var profile TeamProfile
	if err := json.Unmarshal(response.Body.Bytes(), &profile); err != nil {
		t.Fatal(err)
	}
	return profile
}

func assertTeamFailure(t *testing.T, response *httptest.ResponseRecorder, logs *bytes.Buffer, operation, sqlstate string) {
	t.Helper()
	if response.Code != 500 || response.Body.String() != "{\"error\":\"internal error\"}\n" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("failure disguised or leaked: status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	requestID := response.Header().Get("X-Request-Id")
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["msg"] == "team" {
			if requestID == "" || entry["request_id"] != requestID || entry["operation"] != operation || entry["sqlstate"] != sqlstate {
				t.Errorf("team error lacks request-linked diagnostics: %s", line)
			}
			return
		}
	}
	t.Fatal("no team error log")
}

func TestTeamProfileIntegration(t *testing.T) {
	store, pool := newIntegrationStore(t)
	seedLigaTeam(t, pool)
	if _, err := pool.Exec(context.Background(), `UPDATE team SET color='ffff91', alternate_color='000080' WHERE id='mex-america'`); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	router := teamIntegrationApp(t, store, &logs).router()
	profile := assertTeamResponse(t, performRequest(router, "GET", ligaTeamPath))
	if profile.Team.ID != "mex-america" || profile.Color == nil || *profile.Color != "#ffff91" || profile.AltColor == nil || *profile.AltColor != "#000080" || profile.Record == nil || profile.Record.Summary != "3-1-1" || profile.Record.Points == nil || *profile.Record.Points != 10 || profile.StandingSummary == nil || *profile.StandingSummary != "2 in liga-mx" {
		t.Fatalf("identity/standing = %+v", profile)
	}
	if len(profile.Squad) != 3 {
		t.Fatalf("squad length = %d", len(profile.Squad))
	}
	measured, nullStats, unmeasured := profile.Squad[0], profile.Squad[1], profile.Squad[2]
	if measured.ID != "018f0000-0000-7000-8000-000000000101" || measured.Name != "Captain" || measured.Stats == nil || measured.Stats.Appearances == nil || *measured.Stats.Appearances != 5 || measured.Stats.TotalGoals == nil || *measured.Stats.TotalGoals != 3 || measured.Stats.GoalAssists == nil || *measured.Stats.GoalAssists != 0 || measured.Stats.TotalShots != nil {
		t.Fatalf("measured player = %+v stats=%+v", measured, measured.Stats)
	}
	if nullStats.Stats == nil || *nullStats.Stats != (PlayerSeasonStats{}) {
		t.Fatalf("all-null statistics must retain their block: %+v", nullStats)
	}
	if unmeasured.Name != "Unmeasured Player" || unmeasured.Stats != nil || unmeasured.Jersey != nil || unmeasured.Position != "" || unmeasured.Nationality != nil || unmeasured.Age != nil || unmeasured.HeadshotURL != nil {
		t.Fatalf("unmeasured player = %+v", unmeasured)
	}
	if len(profile.Schedule) != 2 || profile.Schedule[0].Home.ID != "mex-america" || profile.Schedule[1].Away.ID != "mex-america" || profile.Schedule[0].Kickoff >= profile.Schedule[1].Kickoff {
		t.Fatalf("schedule order/scope = %+v", profile.Schedule)
	}
	for _, match := range profile.Schedule {
		if match.Scorers == nil || match.Cards == nil || match.HomeScore != nil || match.AwayScore != nil {
			t.Fatalf("schedule normalization = %+v", match)
		}
	}
	if detail := profile.Schedule[0].ShootoutDetail; detail == nil || detail.Home == nil || detail.Away == nil {
		t.Fatalf("shootout normalization = %+v", detail)
	}
	empty := assertTeamResponse(t, performRequest(router, "GET", strings.Replace(ligaTeamPath, "mex-america", "mex-empty", 1)))
	if empty.Squad == nil || len(empty.Squad) != 0 || empty.Schedule == nil || len(empty.Schedule) != 0 || empty.Record != nil || empty.StandingSummary != nil || empty.Color != nil || empty.AltColor != nil || empty.Team.CrestURL != nil {
		t.Fatalf("legitimate empty team = %+v", empty)
	}
	for _, tc := range []struct {
		path, body string
		status     int
	}{
		{strings.Replace(ligaTeamPath, "mex-america", "unknown", 1), "{\"error\":\"unknown team\"}\n", 404},
		{strings.Replace(ligaTeamPath, "liga-mx", "unknown", 1), "{\"error\":\"unknown competition or season\"}\n", 400},
		{strings.Replace(ligaTeamPath, "2026-apertura", "unknown", 1), "{\"error\":\"unknown competition or season\"}\n", 400},
	} {
		response := performRequest(router, "GET", tc.path)
		if response.Code != tc.status || response.Body.String() != tc.body || response.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: status=%d body=%s", tc.path, response.Code, response.Body.String())
		}
	}
}

func TestTeamProfileMissingColoursMigration(t *testing.T) {
	store, pool := newIntegrationStoreThrough(t, "0021_finalization_invariants.up.sql")
	seedLigaTeam(t, pool)
	ctx := context.Background()
	profile, err := store.Team(ctx, "mex-america", "liga-mx", "2026-apertura")
	var pgErr *pgconn.PgError
	if profile != nil || !errors.As(err, &pgErr) || pgErr.Code != "42703" || pgErr.Message != "column t.color does not exist" {
		t.Fatalf("expected production regression, got profile=%+v err=%v", profile, err)
	}
	t.Logf("before migration 0022: %s (SQLSTATE %s)", pgErr.Message, pgErr.Code)
	var logs bytes.Buffer
	router := teamIntegrationApp(t, store, &logs).router()
	if health := performRequest(router, "GET", "/healthz"); health.Code != 200 {
		t.Fatalf("schema mismatch should still allow connectivity health: %d", health.Code)
	}
	assertTeamFailure(t, performRequest(router, "GET", ligaTeamPath), &logs, "identity", "42703")
	// Repair only the disposable local database using the existing migration.
	sql, err := os.ReadFile("../migrations/0022_team_colours.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(sql)); err != nil {
		t.Fatal(err)
	}
	profileAfter := assertTeamResponse(t, performRequest(router, "GET", ligaTeamPath))
	if profileAfter.Color != nil || profileAfter.AltColor != nil || len(profileAfter.Squad) != 3 || len(profileAfter.Schedule) != 2 {
		t.Fatalf("profile after migration = %+v", profileAfter)
	}
	t.Log("after migration 0022: HTTP 200, complete OpenAPI-valid profile; colours remain null")
}

func TestTeamProfileQueryFailures(t *testing.T) {
	store, pool := newIntegrationStore(t)
	seedLigaTeam(t, pool)
	for _, tc := range []struct{ table, operation string }{{"standing", "identity"}, {"squad_membership", "squad"}, {"match", "schedule"}} {
		t.Run(tc.operation, func(t *testing.T) {
			// The table name is a fixed test-owned value, never caller input.
			if _, err := pool.Exec(context.Background(), "REVOKE SELECT ON "+tc.table+" FROM scorearc_reader"); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if _, err := pool.Exec(context.Background(), "GRANT SELECT ON "+tc.table+" TO scorearc_reader"); err != nil {
					t.Error(err)
				}
			})
			var logs bytes.Buffer
			router := teamIntegrationApp(t, store, &logs).router()
			assertTeamFailure(t, performRequest(router, "GET", ligaTeamPath), &logs, tc.operation, "42501")
		})
	}
	t.Run("malformed schedule JSON", func(t *testing.T) {
		if _, err := pool.Exec(context.Background(), `UPDATE match_detail SET scorers='{}' WHERE match_id='018f0000-0000-7000-8000-000000000201'`); err != nil {
			t.Fatal(err)
		}
		var logs bytes.Buffer
		router := teamIntegrationApp(t, store, &logs).router()
		assertTeamFailure(t, performRequest(router, "GET", ligaTeamPath), &logs, "schedule", "")
	})
}
