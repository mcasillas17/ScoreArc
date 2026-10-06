package store

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"os"
	"testing"
	"time"
)

func TestParticipationEnrollmentIsAtomicAndPrivate(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	id := mustParticipationMatch(t, owner, pool)
	role, _ := newIngesterRoleStore(t, pool, dsn)
	ctx := context.Background()
	if _, err := role.pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_participation_status WHERE match_id=$1 AND completed_at IS NULL`, id); n != 1 {
		t.Fatalf("enrollment count=%d", n)
	}
	for _, sql := range []string{
		`INSERT INTO match_participation_status(match_id) VALUES($1)`,
		`DELETE FROM match_participation_status WHERE match_id=$1`,
		`UPDATE match_participation_status SET enrolled_at=now() WHERE match_id=$1`,
	} {
		if _, err := role.pool.Exec(ctx, sql, id); err == nil {
			t.Fatalf("ingester allowed: %s", sql)
		}
	}
	var reader bool
	if err := pool.QueryRow(ctx, `SELECT has_table_privilege('scorearc_reader','match_participation_status','SELECT')`).Scan(&reader); err != nil {
		t.Fatal(err)
	}
	if reader {
		t.Fatal("private participation ledger exposed to reader")
	}
	if _, err := role.pool.Exec(ctx, `UPDATE match_participation_status SET last_attempted_at=$2,retry_at=$3,attempts=1,last_error='pending' WHERE match_id=$1`, id, time.Now(), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
}

func recoveryParticipation() *model.MatchParticipation {
	p := &model.MatchParticipation{HomeTeamSourceID: "359", AwayTeamSourceID: "363", EventsPresent: true}
	for i := 0; i < 11; i++ {
		p.Home = append(p.Home, model.SquadPlayer{SourceID: fmt.Sprintf("h%d", i), Name: fmt.Sprintf("Home %d", i), Starter: true})
		p.Away = append(p.Away, model.SquadPlayer{SourceID: fmt.Sprintf("a%d", i), Name: fmt.Sprintf("Away %d", i), Starter: true})
	}
	return p
}

func TestParticipationRecoveryCompletesAtomicallyAndStaysSealed(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	id := mustParticipationMatch(t, owner, pool)
	role, _ := newIngesterRoleStore(t, pool, dsn)
	ctx := context.Background()
	if _, err := role.pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	pending, err := role.PendingParticipation(ctx, "espn", now, 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("pending=%+v err=%v", pending, err)
	}
	item := pending[0]
	if item.Match.ID != "401" || item.Match.Home.ID != "359" || item.Match.Away.ID != "363" || item.Identity.MatchID != id {
		t.Fatalf("provider identity lost: %+v", item)
	}
	claimed, err := role.BeginParticipation(ctx, id, now, now.Add(time.Hour))
	if err != nil || !claimed {
		t.Fatalf("claim=%v %v", claimed, err)
	}
	if claimed, err = role.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil || claimed {
		t.Fatalf("duplicate claim=%v %v", claimed, err)
	}
	if err := role.FailParticipation(ctx, id, now, "provider_failure"); err != nil {
		t.Fatal(err)
	}
	if list, err := role.PendingParticipation(ctx, "espn", now.Add(time.Minute), 10); err != nil || len(list) != 0 {
		t.Fatalf("backoff lost: %+v %v", list, err)
	}
	bad := item.Match
	one := 1
	bad.HomeScore = &one
	if _, err := role.CompleteParticipation(ctx, item.Identity, bad, recoveryParticipation(), now); err == nil {
		t.Fatal("changed score accepted")
	}
	part := recoveryParticipation()
	part.Home = part.Home[:10]
	if _, err := role.CompleteParticipation(ctx, item.Identity, item.Match, part, now); err == nil {
		t.Fatal("incomplete roster accepted")
	}
	// Every failure stage must leave player creation, facts and completion atomic.
	for _, table := range []string{"player", "appearance", "match_event", "match_participation_status"} {
		if table == "match_event" {
			part = recoveryParticipation()
			part.Events = []model.PlayerEvent{{TeamSourceID: "359", PlayerSourceID: "h0", PlayerName: "Home 0", Type: model.PlayerEventYellow, Minute: "42"}}
		} else {
			part = recoveryParticipation()
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s ADD CONSTRAINT injected_failure CHECK (false) NOT VALID`, table)); err != nil {
			t.Fatal(err)
		}
		if _, err := role.CompleteParticipation(ctx, item.Identity, item.Match, part, now); err == nil {
			t.Fatalf("%s failure accepted", table)
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(`ALTER TABLE %s DROP CONSTRAINT injected_failure`, table)); err != nil {
			t.Fatal(err)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM player`); n != 0 {
			t.Fatalf("%s failure leaked %d players", table, n)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 0 {
			t.Fatalf("%s failure leaked %d facts", table, n)
		}
		if n := countRows(t, pool, `SELECT count(*) FROM match_participation_status WHERE match_id=$1 AND completed_at IS NOT NULL`, id); n != 0 {
			t.Fatal("failure marked complete")
		}
	}
	stats, err := role.CompleteParticipation(ctx, item.Identity, item.Match, recoveryParticipation(), now)
	if err != nil || stats.Appearances != 22 || stats.Events != 0 {
		t.Fatalf("completion=%+v %v", stats, err)
	}
	if _, err := role.CompleteParticipation(ctx, item.Identity, bad, nil, now); err != nil {
		t.Fatalf("completed replay should ignore changed input: %v", err)
	}
	if _, err := role.pool.Exec(ctx, `UPDATE match_participation_status SET completed_at=NULL WHERE match_id=$1`, id); !IsImmutableViolation(err) {
		t.Fatalf("completion reopened: %v", err)
	}
	if _, err := role.pool.Exec(ctx, `DELETE FROM appearance WHERE match_id=$1`, id); !IsImmutableViolation(err) {
		t.Fatalf("completed facts mutable: %v", err)
	}
	if list, err := role.PendingParticipation(ctx, "espn", now.Add(24*time.Hour), 10); err != nil || len(list) != 0 {
		t.Fatalf("completed work requeued: %+v %v", list, err)
	}
}

func TestParticipationMigrationLegacyBoundaryAndRollback(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	ctx := context.Background()
	apply := func(direction string) {
		t.Helper()
		raw, err := os.ReadFile("../../migrations/0025_participation_recovery." + direction + ".sql")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	apply("down")
	id := mustParticipationMatch(t, owner, pool)
	if _, err := pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	apply("up")
	if n := countRows(t, pool, `SELECT count(*) FROM match_participation_status`); n != 0 {
		t.Fatal("migration enrolled legacy history")
	}
	role, _ := newIngesterRoleStore(t, pool, dsn)
	if claimed, err := role.BeginParticipation(ctx, id, time.Now(), time.Now().Add(time.Hour)); err != nil || claimed {
		t.Fatalf("legacy claimed=%v %v", claimed, err)
	}
	player, err := owner.Player(ctx, "espn", PlayerRef{SourceID: "legacy-player", FullName: "Legacy"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := role.pool.Exec(ctx, `INSERT INTO appearance(match_id,player_id,team_id,starter) VALUES($1,$2,'eng-arsenal',true)`, id, player); !IsImmutableViolation(err) {
		t.Fatalf("legacy reopened: %v", err)
	}
	// A new finalization fails as a whole if enrollment fails.
	next := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO match(id,competition_id,season_id,home_team_id,away_team_id,kickoff,state,status_name,source) VALUES($1,'premier-league','2026-27','eng-arsenal','eng-chelsea','2026-08-22','finished','STATUS_FULL_TIME','espn')`, next); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE match_participation_status ADD CONSTRAINT injected_failure CHECK (false) NOT VALID`); err != nil {
		t.Fatal(err)
	}
	if _, err := role.pool.Exec(ctx, `UPDATE match SET finalized_at=now() WHERE id=$1`, next); err == nil {
		t.Fatal("enrollment failure did not abort finalization")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match WHERE id=$1 AND finalized_at IS NOT NULL`, next); n != 0 {
		t.Fatal("half-finalized match")
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE match_participation_status DROP CONSTRAINT injected_failure`); err != nil {
		t.Fatal(err)
	}
	if _, err := role.pool.Exec(ctx, `UPDATE match SET finalized_at=now() WHERE id=$1`, next); err != nil {
		t.Fatal(err)
	}
	apply("down")
	if _, err := role.pool.Exec(ctx, `INSERT INTO appearance(match_id,player_id,team_id,starter) VALUES($1,$2,'eng-arsenal',true)`, next, player); !IsImmutableViolation(err) {
		t.Fatalf("rollback did not reseal: %v", err)
	}
	apply("up")
	if n := countRows(t, pool, `SELECT count(*) FROM match_participation_status`); n != 0 {
		t.Fatal("reapply enrolled old pending history")
	}
}

func TestParticipationCompletionSerializesLateFactWrites(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	id := mustParticipationMatch(t, owner, pool)
	role, _ := newIngesterRoleStore(t, pool, dsn)
	ctx := context.Background()
	if _, err := role.pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	player, err := owner.Player(ctx, "espn", PlayerRef{SourceID: "late", FullName: "Late"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := role.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	tx, err := role.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(ctx, tx)
	if _, err := tx.Exec(ctx, `SELECT id FROM match WHERE id=$1 FOR UPDATE`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE match_participation_status SET completed_at=$2 WHERE match_id=$1`, id, now); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		_, err := role.pool.Exec(bounded, `INSERT INTO appearance(match_id,player_id,team_id,starter) VALUES($1,$2,'eng-arsenal',true)`, id, player)
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("late fact did not wait for completion: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !IsImmutableViolation(err) {
		t.Fatalf("late fact crossed completion seal: %v", err)
	}
}

func TestParticipationRechecksIdentityAndPreservesExistingFacts(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	id := mustParticipationMatch(t, owner, pool)
	ctx := context.Background()
	if _, err := owner.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", sampleParticipation()); err != nil {
		t.Fatal(err)
	}
	role, _ := newIngesterRoleStore(t, pool, dsn)
	if _, err := role.pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	items, err := role.PendingParticipation(ctx, "espn", now, 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("pending %v %v", items, err)
	}
	item := items[0]
	if _, err := role.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*MatchIdentity, *model.Match, *model.MatchParticipation){
		func(id *MatchIdentity, _ *model.Match, _ *model.MatchParticipation) { id.SeasonID = "2025-26" },
		func(id *MatchIdentity, _ *model.Match, _ *model.MatchParticipation) { id.CompetitionID = "la-liga" },
		func(id *MatchIdentity, _ *model.Match, _ *model.MatchParticipation) {
			id.HomeTeamID, id.AwayTeamID = id.AwayTeamID, id.HomeTeamID
		},
		func(_ *MatchIdentity, m *model.Match, _ *model.MatchParticipation) { m.ID = "wrong" },
		func(_ *MatchIdentity, m *model.Match, _ *model.MatchParticipation) {
			m.Home.ID, m.Away.ID = m.Away.ID, m.Home.ID
		},
		func(_ *MatchIdentity, m *model.Match, _ *model.MatchParticipation) { m.State = model.MatchStateLive },
		func(_ *MatchIdentity, m *model.Match, _ *model.MatchParticipation) { m.StatusName = "STATUS_FORFEIT" },
		func(_ *MatchIdentity, _ *model.Match, p *model.MatchParticipation) { p.EventsPresent = false },
	} {
		identity, match, part := item.Identity, item.Match, recoveryParticipation()
		change(&identity, &match, part)
		if _, err := role.CompleteParticipation(ctx, identity, match, part, now); err == nil {
			t.Fatal("changed or incomplete evidence accepted")
		}
	}
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 23 {
		t.Fatal("failed recovery pruned existing roster")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, id); n != 2 {
		t.Fatal("failed recovery pruned existing events")
	}
	// A corrected authoritative zero-event result may now retract the live goal.
	if _, err := role.CompleteParticipation(ctx, item.Identity, item.Match, recoveryParticipation(), now); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1`, id); n != 0 {
		t.Fatal("explicit empty final did not converge events")
	}
}

func TestParticipationPendingDoesNotOpenUnrelatedFactsOrAllowSpoofing(t *testing.T) {
	owner, pool, dsn := newIntegrationStoreDSN(t)
	id := mustParticipationMatch(t, owner, pool)
	role, _ := newIngesterRoleStore(t, pool, dsn)
	ctx := context.Background()
	if _, err := role.pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := role.pool.Exec(ctx, `INSERT INTO match_commentary(match_id,seq,clock_display,text) VALUES($1,0,'90','tamper')`, id); !IsImmutableViolation(err) {
		t.Fatalf("pending reopened commentary: %v", err)
	}
	player, err := owner.Player(ctx, "espn", PlayerRef{SourceID: "spoof", FullName: "Spoof"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := role.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := role.pool.Exec(ctx, `UPDATE match_participation_status SET completed_at=$2 WHERE match_id=$1`, id, now); err != nil {
		t.Fatal(err)
	}
	tx, err := role.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(ctx, tx)
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE match_participation_status(match_id uuid,completed_at timestamptz); CREATE TEMP TABLE match(id uuid,finalized_at timestamptz)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO pg_temp.match_participation_status VALUES($1,NULL)`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO pg_temp.match VALUES($1,NULL)`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO public.appearance(match_id,player_id,team_id,starter) VALUES($1,$2,'eng-arsenal',true)`, id, player); !IsImmutableViolation(err) {
		t.Fatalf("temporary enrollment reopened completion: %v", err)
	}
}

func TestParticipationQueueIsFairAcrossSeasonsAndExcludesExceptionalFinals(t *testing.T) {
	st, pool := newIntegrationStore(t)
	mustSeedTwoTeams(t, st)
	mustSeedSeason(t, pool)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO competition(id,name,short_name,kind) VALUES('la-liga','La Liga','LL','league');
 INSERT INTO season(competition_id,id,label) VALUES('la-liga','2025-26','2025-26'),('premier-league','2025-26','2025-26')`); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	var ordinary []uuid.UUID
	for i := 0; i < 7; i++ {
		comp, status := "premier-league", "STATUS_FULL_TIME"
		if i == 3 {
			comp = "la-liga"
		}
		if i >= 4 {
			status = []string{"STATUS_CANCELED", "STATUS_ABANDONED", "STATUS_FORFEIT"}[i-4]
		}
		id, err := st.Match(ctx, "espn", MatchRef{SourceID: fmt.Sprintf("queue-%d", i), CompetitionID: comp, SeasonID: "2025-26", HomeTeamID: "eng-arsenal", AwayTeamID: "eng-chelsea", Kickoff: time.Date(2025, 8, i+1, 12, 0, 0, 0, time.UTC)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE match SET state='finished',status_name=$2,finalized_at=now() WHERE id=$1`, id, status); err != nil {
			t.Fatal(err)
		}
		if i < 4 {
			ordinary = append(ordinary, id)
			if _, err := st.BeginParticipation(ctx, id, start, start.Add(time.Duration(i+1)*time.Minute)); err != nil {
				t.Fatal(err)
			}
		}
	}
	items, err := st.PendingParticipation(ctx, "espn", time.Now(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 || items[0].Identity.MatchID != ordinary[0] || items[1].Identity.MatchID != ordinary[1] || items[2].Identity.MatchID != ordinary[3] {
		t.Fatalf("unfair or non-deterministic queue: %+v", items)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_participation_status`); n != 4 {
		t.Fatalf("exceptional finals enrolled: %d", n)
	}
	// Retry count remains observable after a long provider outage.
	if _, err := pool.Exec(ctx, `UPDATE match_participation_status SET attempts=32 WHERE match_id=$1`, ordinary[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := st.BeginParticipation(ctx, ordinary[0], time.Now(), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT attempts FROM match_participation_status WHERE match_id=$1`, ordinary[0]); n != 33 {
		t.Fatalf("attempt counter saturated prematurely: %d", n)
	}
}

func TestParticipationConcurrentCompletionWritesOnce(t *testing.T) {
	st, pool := newIntegrationStore(t)
	id := mustParticipationMatch(t, st, pool)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	items, err := st.PendingParticipation(ctx, "espn", now, 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("pending %v %v", items, err)
	}
	if _, err := st.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		stats ParticipationStats
		err   error
	}
	done := make(chan outcome, 2)
	for range 2 {
		go func() {
			stats, err := st.CompleteParticipation(ctx, items[0].Identity, items[0].Match, recoveryParticipation(), now)
			done <- outcome{stats, err}
		}()
	}
	a, b := <-done, <-done
	if a.err != nil || b.err != nil || a.stats.Appearances+b.stats.Appearances != 22 {
		t.Fatalf("concurrent completions: %+v %+v", a, b)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 22 {
		t.Fatalf("concurrent appearance count %d", n)
	}
}

func TestParticipationOmittedPlayingParticipantPreservesFactsAndPendingState(t *testing.T) {
	for _, eventType := range []string{model.PlayerEventGoal, model.PlayerEventOwnGoal, model.PlayerEventSubOn, model.PlayerEventSubOff} {
		t.Run(eventType, func(t *testing.T) {
			st, pool := newIntegrationStore(t)
			id := mustParticipationMatch(t, st, pool)
			ctx := context.Background()
			prior := recoveryParticipation()
			sub := model.SquadPlayer{SourceID: "substitute", Name: "Known Substitute"}
			side := "359"
			if eventType == model.PlayerEventOwnGoal {
				prior.Away = append(prior.Away, sub)
				side = "363"
			} else {
				prior.Home = append(prior.Home, sub)
			}
			prior.Events = []model.PlayerEvent{{Type: model.PlayerEventYellow, TeamSourceID: side, PlayerSourceID: sub.SourceID, PlayerName: sub.Name, Minute: "50"}}
			if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", prior); err != nil {
				t.Fatal(err)
			}
			score := 0
			if eventType == model.PlayerEventGoal || eventType == model.PlayerEventOwnGoal {
				score = 1
			}
			if _, err := pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=$2,away_score=0,finalized_at=now() WHERE id=$1`, id, score); err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			items, err := st.PendingParticipation(ctx, "espn", now, 10)
			if err != nil || len(items) != 1 {
				t.Fatalf("pending=%v err=%v", items, err)
			}
			if _, err := st.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			incomplete := recoveryParticipation()
			incomplete.Events = []model.PlayerEvent{{Type: eventType, TeamSourceID: "359", PlayerSourceID: sub.SourceID, PlayerName: sub.Name, Minute: "60"}}
			if _, err := st.CompleteParticipation(ctx, items[0].Identity, items[0].Match, incomplete, now); err == nil {
				t.Fatal("omitted playing participant completed capture")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM appearance a JOIN player_external_ref r ON r.player_id=a.player_id WHERE a.match_id=$1 AND r.source='espn' AND r.source_id='substitute'`, id); n != 1 {
				t.Fatal("omitted substitute's known appearance was pruned")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1 AND type='yellow'`, id); n != 1 {
				t.Fatal("incomplete final replaced prior event")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_participation_status WHERE match_id=$1 AND completed_at IS NULL`, id); n != 1 {
				t.Fatal("incomplete final sealed participation")
			}
		})
	}
}

func TestParticipationOwnGoalKeepsOppositionPlayerAndBeneficiarySide(t *testing.T) {
	st, pool := newIntegrationStore(t)
	id := mustParticipationMatch(t, st, pool)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=1,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	items, err := st.PendingParticipation(ctx, "espn", now, 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("pending=%v err=%v", items, err)
	}
	if _, err := st.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	part := recoveryParticipation()
	part.Events = []model.PlayerEvent{{Type: model.PlayerEventOwnGoal, TeamSourceID: "359", PlayerSourceID: "a0", PlayerName: "Away 0", Minute: "60"}}
	if _, err := st.CompleteParticipation(ctx, items[0].Identity, items[0].Match, part, now); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM match_event e JOIN appearance a ON a.match_id=e.match_id AND a.player_id=e.player_id WHERE e.match_id=$1 AND e.type='own_goal' AND e.team_id='eng-arsenal' AND a.team_id='eng-chelsea'`, id); n != 1 {
		t.Fatal("own goal lost opposition identity or beneficiary attribution")
	}
}

func TestParticipationCardSideConflictPreservesFactsButStaffCardsComplete(t *testing.T) {
	for _, eventType := range []string{model.PlayerEventYellow, model.PlayerEventRed} {
		t.Run(eventType, func(t *testing.T) {
			st, pool := newIntegrationStore(t)
			id := mustParticipationMatch(t, st, pool)
			ctx := context.Background()
			prior := recoveryParticipation()
			prior.Events = []model.PlayerEvent{{Type: model.PlayerEventYellow, TeamSourceID: "359", PlayerSourceID: "h0", PlayerName: "Home 0", Minute: "50"}}
			if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", prior); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			items, err := st.PendingParticipation(ctx, "espn", now, 10)
			if err != nil || len(items) != 1 {
				t.Fatalf("pending=%v err=%v", items, err)
			}
			if _, err := st.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			wrong := recoveryParticipation()
			wrong.Events = []model.PlayerEvent{{Type: eventType, TeamSourceID: "359", PlayerSourceID: "a0", PlayerName: "Away 0", Minute: "70"}}
			if _, err := st.CompleteParticipation(ctx, items[0].Identity, items[0].Match, wrong, now); err == nil {
				t.Fatal("opposition roster card completed capture")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 22 {
				t.Fatal("conflicting card changed appearances")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1 AND minute='50'`, id); n != 1 {
				t.Fatal("conflicting card replaced established event")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_participation_status WHERE match_id=$1 AND completed_at IS NULL`, id); n != 1 {
				t.Fatal("conflicting card sealed participation")
			}
			staff := recoveryParticipation()
			staff.Events = []model.PlayerEvent{{Type: eventType, TeamSourceID: "359", PlayerSourceID: "coach", PlayerName: "Identified Coach", Minute: "70"}}
			if _, err := st.CompleteParticipation(ctx, items[0].Identity, items[0].Match, staff, now); err != nil {
				t.Fatalf("identified staff card rejected: %v", err)
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_event e JOIN player_external_ref r ON r.player_id=e.player_id WHERE e.match_id=$1 AND e.type=$2 AND r.source='espn' AND r.source_id='coach'`, id, eventType); n != 1 {
				t.Fatal("staff card identity missing")
			}
		})
	}
}

func TestParticipationCanonicalStaffAliasCannotReattributeRosterPlayer(t *testing.T) {
	for _, eventType := range []string{model.PlayerEventYellow, model.PlayerEventRed} {
		t.Run(eventType, func(t *testing.T) {
			st, pool := newIntegrationStore(t)
			id := mustParticipationMatch(t, st, pool)
			ctx := context.Background()
			prior := recoveryParticipation()
			prior.Events = []model.PlayerEvent{{Type: model.PlayerEventYellow, TeamSourceID: "359", PlayerSourceID: "h0", PlayerName: "Home 0", Minute: "50"}}
			if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", prior); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO player_external_ref(source,source_id,player_id) SELECT source,'coach-alias',player_id FROM player_external_ref WHERE source='espn' AND source_id='a0'`); err != nil {
				t.Fatal(err)
			}
			wrong := recoveryParticipation()
			wrong.Events = []model.PlayerEvent{{Type: eventType, TeamSourceID: "359", PlayerSourceID: "coach-alias", PlayerName: "Apparently Staff", Minute: "70"}}
			// Provider-level identity alone cannot reveal that the apparent staff member
			// already occurs on the opposing roster under another provider reference.
			if _, err := st.WriteParticipation(ctx, "espn", id, "eng-arsenal", "eng-chelsea", wrong); err != nil {
				t.Fatal(err)
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1 AND minute='50'`, id); n != 1 {
				t.Error("canonical alias replaced live event history")
			}
			if _, err := pool.Exec(ctx, `UPDATE match SET state='finished',status_name='STATUS_FULL_TIME',home_score=0,away_score=0,finalized_at=now() WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			items, err := st.PendingParticipation(ctx, "espn", now, 10)
			if err != nil || len(items) != 1 {
				t.Fatalf("pending=%v err=%v", items, err)
			}
			if _, err := st.BeginParticipation(ctx, id, now, now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			if _, err := st.CompleteParticipation(ctx, items[0].Identity, items[0].Match, wrong, now); err == nil {
				t.Error("canonical alias completed contradictory final capture")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM appearance WHERE match_id=$1`, id); n != 22 {
				t.Error("canonical alias changed appearances")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_event WHERE match_id=$1 AND minute='50'`, id); n != 1 {
				t.Error("canonical alias replaced prior final event")
			}
			if n := countRows(t, pool, `SELECT count(*) FROM match_participation_status WHERE match_id=$1 AND completed_at IS NULL`, id); n != 1 {
				t.Error("canonical alias sealed participation")
			}
		})
	}
}
