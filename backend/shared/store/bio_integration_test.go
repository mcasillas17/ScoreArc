package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func mustBioPlayer(
	t *testing.T,
	bioStore *Store,
	pool *pgxpool.Pool,
	matchID uuid.UUID,
	sourceID string,
	appeared bool,
) uuid.UUID {
	t.Helper()
	playerID, err := bioStore.Player(context.Background(), "espn", PlayerRef{
		SourceID: sourceID,
		FullName: "Player " + sourceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if appeared {
		if _, err := pool.Exec(context.Background(), `
INSERT INTO appearance (match_id, player_id, team_id, starter)
VALUES ($1,$2,'eng-arsenal',true)`,
			matchID, playerID,
		); err != nil {
			t.Fatal(err)
		}
	}
	return playerID
}

func TestPlayersNeedingBioHonorsLimitAndRequiresAppearance(t *testing.T) {
	bioStore, pool := newIntegrationStore(t)
	matchID := mustParticipationMatch(t, bioStore, pool)
	for index := range 25 {
		mustBioPlayer(t, bioStore, pool, matchID, fmt.Sprintf("appeared-%02d", index), true)
	}
	mustBioPlayer(t, bioStore, pool, matchID, "never-appeared", false)

	candidates, err := bioStore.PlayersNeedingBio(
		context.Background(), "espn", time.Now(), 20,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 20 {
		t.Fatalf("bio candidates = %d, want hard limit 20", len(candidates))
	}
	if _, selected := candidates["never-appeared"]; selected {
		t.Fatal("player with no appearance was selected for a bio fetch")
	}
}

func TestReplaceTeamHistoryEmptyResultStampsTTLAndIsNotReselected(t *testing.T) {
	bioStore, pool := newIntegrationStore(t)
	matchID := mustParticipationMatch(t, bioStore, pool)
	playerID := mustBioPlayer(t, bioStore, pool, matchID, "empty-history", true)

	if err := bioStore.ReplaceTeamHistory(
		context.Background(), playerID, "espn", []model.TeamHistoryEntry{},
	); err != nil {
		t.Fatal(err)
	}
	candidates, err := bioStore.PlayersNeedingBio(
		context.Background(), "espn", time.Now().Add(-30*24*time.Hour), 20,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, selected := candidates["empty-history"]; selected {
		t.Fatal("empty history was immediately selected again")
	}
	if got := countRows(t, pool, `
SELECT count(*) FROM player WHERE id=$1 AND bio_fetched_at IS NOT NULL`, playerID); got != 1 {
		t.Fatalf("players with stamped bio TTL = %d, want 1", got)
	}
}

func TestReplaceTeamHistoryDropsCorrectedTailAndPreservesOrder(t *testing.T) {
	bioStore, pool := newIntegrationStore(t)
	matchID := mustParticipationMatch(t, bioStore, pool)
	playerID := mustBioPlayer(t, bioStore, pool, matchID, "career", true)

	initial := []model.TeamHistoryEntry{
		{TeamSourceID: "222", TeamName: "Querétaro", Seasons: "2025-CURRENT"},
		{TeamSourceID: "233", TeamName: "Pumas UNAM", Seasons: "2023-2025"},
	}
	if err := bioStore.ReplaceTeamHistory(context.Background(), playerID, "espn", initial); err != nil {
		t.Fatal(err)
	}
	corrected := []model.TeamHistoryEntry{
		{TeamSourceID: "233", TeamName: "Pumas", Seasons: "2023-2025"},
	}
	if err := bioStore.ReplaceTeamHistory(context.Background(), playerID, "espn", corrected); err != nil {
		t.Fatal(err)
	}

	var teamID, teamName string
	var ord int
	if err := pool.QueryRow(context.Background(), `
SELECT team_source_id, team_name, ord
FROM player_team_history WHERE player_id=$1`,
		playerID,
	).Scan(&teamID, &teamName, &ord); err != nil {
		t.Fatal(err)
	}
	if teamID != "233" || teamName != "Pumas" || ord != 0 {
		t.Fatalf("corrected history = %s/%q ord %d", teamID, teamName, ord)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_team_history WHERE player_id=$1`, playerID); got != 1 {
		t.Fatalf("history rows = %d, want 1", got)
	}
}

func TestReplaceTeamHistoryAsTheIngesterRole(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	matchID := mustParticipationMatch(t, owner, pool)
	playerID := mustBioPlayer(t, owner, pool, matchID, "role-player", true)
	roleStore, roleName := newIngesterRoleStore(t, pool, dsn)

	candidates, err := roleStore.PlayersNeedingBio(
		context.Background(), "espn", time.Now(), 20,
	)
	if err != nil {
		t.Fatalf("PlayersNeedingBio as %s: %v", roleName, err)
	}
	if candidates["role-player"] != playerID {
		t.Fatalf("as %s: candidate = %v, want %s", roleName, candidates, playerID)
	}

	entries := []model.TeamHistoryEntry{
		{TeamSourceID: "222", TeamName: "Querétaro", Seasons: "2025-CURRENT"},
		{TeamSourceID: "233", TeamName: "Pumas", Seasons: "2023-2025"},
	}
	if err := roleStore.ReplaceTeamHistory(context.Background(), playerID, "espn", entries); err != nil {
		t.Fatalf("ReplaceTeamHistory as %s: %v", roleName, err)
	}
	if err := roleStore.ReplaceTeamHistory(
		context.Background(), playerID, "espn", []model.TeamHistoryEntry{},
	); err != nil {
		t.Fatalf("clear TeamHistory as %s: %v", roleName, err)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM player_team_history WHERE player_id=$1`, playerID); got != 0 {
		t.Fatalf("as %s: history rows = %d, want 0", roleName, got)
	}
}

func TestSquadAndBioMigrationsRollbackInReverseOrder(t *testing.T) {
	_, pool := newIntegrationStore(t)
	ctx := context.Background()
	read := func(name string) string {
		t.Helper()
		raw, err := os.ReadFile("../../migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	for _, name := range []string{
		"0012_player_bio.down.sql",
		"0011_squad_and_season_stats.down.sql",
	} {
		if _, err := pool.Exec(ctx, read(name)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	for _, table := range []string{
		"squad_membership", "player_season_stat", "player_team_history",
	} {
		if got := countRows(t, pool,
			`SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)`, table); got != 0 {
			t.Fatalf("table %s survived rollback", table)
		}
	}
	if got := countRows(t, pool, `
SELECT count(*) FROM information_schema.columns
WHERE table_name='player' AND column_name='bio_fetched_at'`); got != 0 {
		t.Fatal("player.bio_fetched_at survived rollback")
	}
	if got := countRows(t, pool, `
SELECT count(*) FROM information_schema.columns
WHERE table_name='player' AND column_name IN ('birth_date','nationality')`); got != 2 {
		t.Fatalf("pre-existing player demographics after rollback = %d columns, want 2", got)
	}

	for _, name := range []string{
		"0011_squad_and_season_stats.up.sql",
		"0012_player_bio.up.sql",
	} {
		if _, err := pool.Exec(ctx, read(name)); err != nil {
			t.Fatalf("reapply %s: %v", name, err)
		}
	}
	for _, table := range []string{
		"squad_membership", "player_season_stat", "player_team_history",
	} {
		if got := countRows(t, pool,
			`SELECT count(*) FROM pg_class WHERE oid=to_regclass($1)`, table); got != 1 {
			t.Fatalf("table %s missing after reapply", table)
		}
	}
}
