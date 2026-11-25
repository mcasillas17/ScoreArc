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

func TestPlayersNeedingBioHonorsLimitAndRequiresEditionMembershipOrAppearance(t *testing.T) {
	bioStore, pool := newIntegrationStore(t)
	matchID := mustParticipationMatch(t, bioStore, pool)
	for index := range 25 {
		mustBioPlayer(t, bioStore, pool, matchID, fmt.Sprintf("appeared-%02d", index), true)
	}
	mustBioPlayer(t, bioStore, pool, matchID, "never-appeared", false)

	if hidden, err := bioStore.PlayersNeedingBio(context.Background(), "espn", time.Now(), 20, []string{"pilot/live"}); err != nil || len(hidden) != 0 {
		t.Fatalf("selected outside eligible editions: %v %v", hidden, err)
	}
	candidates, err := bioStore.PlayersNeedingBio(
		context.Background(), "espn", time.Now(), 20, []string{"premier-league/2026-27"},
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

func TestBioRetryLeavesRoomForLaterPlayersAndPreservesOldHistory(t *testing.T) {
	ctx := context.Background()
	s, pool, dsn := newIntegrationStoreDSN(t)
	matchID := mustParticipationMatch(t, s, pool)
	first := mustBioPlayer(t, s, pool, matchID, "missing-history", true)
	second := mustBioPlayer(t, s, pool, matchID, "next-player", true)
	third := mustBioPlayer(t, s, pool, matchID, "untried-player", true)
	old := time.Now().UTC().Add(-90 * 24 * time.Hour).Truncate(time.Microsecond)
	if err := s.ReplaceTeamHistory(ctx, first, "espn", []model.TeamHistoryEntry{{TeamSourceID: "222", TeamName: "Former club", Seasons: "2018"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE player SET bio_observed_at=$1,bio_fetched_at=$1 WHERE id=$2`, old, first); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE player SET bio_observed_at=$1,bio_fetched_at=$1 WHERE id IN ($2,$3)`, old.Add(time.Hour), second, third); err != nil {
		t.Fatal(err)
	}
	queue, _ := newIngesterRoleStore(t, pool, dsn)
	selectOne := func() uuid.UUID {
		t.Helper()
		rows, err := queue.PlayersNeedingBio(ctx, "espn", time.Now().Add(-30*24*time.Hour), 1, []string{"premier-league/2026-27"})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 {
			t.Fatalf("want exactly one eligible bio, got %v", rows)
		}
		for _, id := range rows {
			return id
		}
		return uuid.Nil
	}
	if got := selectOne(); got != first {
		t.Fatalf("oldest candidate=%v want %v", got, first)
	}
	if err := queue.DeferBioRetries(ctx, []uuid.UUID{first}, time.Now().Add(6*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := selectOne(); got == first {
		t.Fatal("deferred malformed history occupied the only batch slot")
	}
	if _, err := pool.Exec(ctx, `UPDATE player SET bio_retry_after=now()-interval '1 second' WHERE id=$1`, first); err != nil {
		t.Fatal(err)
	}
	if got := selectOne(); got == first {
		t.Fatal("repeated failure ranked ahead of untried stale histories")
	}
	if _, err := pool.Exec(ctx, `UPDATE player SET bio_fetched_at=now() WHERE id IN ($1,$2)`, second, third); err != nil {
		t.Fatal(err)
	}
	if got := selectOne(); got != first {
		t.Fatal("failed history did not return after its retry deadline")
	}
	var fetched, observed time.Time
	var history int
	if err := pool.QueryRow(ctx, `SELECT bio_fetched_at,bio_observed_at,(SELECT count(*) FROM player_team_history WHERE player_id=$1) FROM player WHERE id=$1`, first).Scan(&fetched, &observed, &history); err != nil {
		t.Fatal(err)
	}
	if !fetched.Equal(old) || !observed.Equal(old) || history != 1 {
		t.Fatalf("retry modified prior history: fetched=%s observed=%s rows=%d", fetched, observed, history)
	}
}

func TestPlayersNeedingBioIncludesRosterMemberBeforeDebut(t *testing.T) {
	bioStore, pool := newIntegrationStore(t)
	matchID := mustParticipationMatch(t, bioStore, pool)
	id := mustBioPlayer(t, bioStore, pool, matchID, "before-debut", false)
	if _, err := pool.Exec(context.Background(), `INSERT INTO squad_membership
 (competition_id,season_id,team_id,player_id,source) VALUES ('premier-league','2026-27','eng-arsenal',$1,'espn')`, id); err != nil {
		t.Fatal(err)
	}
	candidates, err := bioStore.PlayersNeedingBio(context.Background(), "espn", time.Now(), 20, []string{"premier-league/2026-27"})
	if err != nil || candidates["before-debut"] != id {
		t.Fatalf("roster member missing from bio refresh: %v %v", candidates, err)
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
		context.Background(), "espn", time.Now().Add(-30*24*time.Hour), 20, []string{"premier-league/2026-27"},
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
		context.Background(), "espn", time.Now(), 20, []string{"premier-league/2026-27"},
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
		"0028_resource_observation.down.sql",
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
		"0028_resource_observation.up.sql",
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
