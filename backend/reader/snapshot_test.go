package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type trackingSnapshotStore struct {
	*fakeReaderStore
	read           matchReader
	beginErr       error
	begins, closes int
	deadline       bool
}

func (s *trackingSnapshotStore) Snapshot(ctx context.Context) (matchReader, func() error, error) {
	s.begins++
	_, s.deadline = ctx.Deadline()
	if s.beginErr != nil {
		return nil, nil, s.beginErr
	}
	reader := s.read
	if reader == nil {
		reader = s.fakeReaderStore
	}
	return reader, func() error { s.closes++; return nil }, nil
}

type panickingMatchReader struct{ matchReader }

func (*panickingMatchReader) Matches(context.Context, string, string) ([]Match, error) {
	panic("test panic")
}

type snapshotCheckingWriter struct {
	*httptest.ResponseRecorder
	beforeWrite func()
}

func (w *snapshotCheckingWriter) WriteHeader(status int) {
	w.beforeWrite()
	w.ResponseRecorder.WriteHeader(status)
}

func (w *snapshotCheckingWriter) Write(body []byte) (int, error) {
	w.beforeWrite()
	return w.ResponseRecorder.Write(body)
}

func responseAfterSnapshotClosed(t *testing.T, handler http.Handler, path string, store *trackingSnapshotStore) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	writer := &snapshotCheckingWriter{ResponseRecorder: recorder, beforeWrite: func() {
		if store.beginErr == nil && store.begins != store.closes {
			t.Errorf("response writing began with snapshot still open: begins=%d closes=%d", store.begins, store.closes)
		}
	}}
	handler.ServeHTTP(writer, httptest.NewRequest("GET", path, nil))
	return recorder
}

func TestMatchSnapshotsCleanupAndBeginErrors(t *testing.T) {
	paths := []string{
		"/v1/competitions/world-cup/2026/matches",
		"/v1/competitions/world-cup/2026/bracket",
		"/v1/competitions/world-cup/2026/teams/arg",
		"/v1/matches/" + finalMatchID,
	}
	for _, path := range paths {
		for _, beginFailed := range []bool{false, true} {
			t.Run(path+map[bool]string{false: "/success", true: "/begin failure"}[beginFailed], func(t *testing.T) {
				fake := &fakeReaderStore{summary: &MatchSummary{}, teams: map[string]*TeamProfile{"arg": {}}}
				store := &trackingSnapshotStore{fakeReaderStore: fake}
				if beginFailed {
					store.beginErr = errors.New("synthetic connection details")
				}
				app := newTestApp(t, fake, &fakeNewsReader{})
				app.store = store
				response := responseAfterSnapshotClosed(t, app.router(), path, store)
				if store.begins != 1 || !store.deadline {
					t.Fatalf("begin count/deadline: %+v", store)
				}
				if beginFailed {
					if response.Code != 500 || response.Body.String() != "{\"error\":\"internal error\"}\n" ||
						response.Header().Get("Cache-Control") != "no-store" || store.closes != 0 || fake.calls != 0 {
						t.Fatalf("begin failure leaked or read without snapshot: %d %s closes=%d reads=%d", response.Code, response.Body.String(), store.closes, fake.calls)
					}
				} else if response.Code != 200 || store.closes != 1 {
					t.Fatalf("successful snapshot not released once: status=%d closes=%d", response.Code, store.closes)
				}
			})
		}
	}
	for _, tc := range []struct {
		name, path     string
		fake           *fakeReaderStore
		panic          bool
		status, begins int
	}{
		{"query failure", paths[0], &fakeReaderStore{matchesErr: errors.New("read failed")}, false, 500, 1},
		{"bracket query failure", paths[1], &fakeReaderStore{bracketErr: errors.New("read failed")}, false, 500, 1},
		{"team query failure", paths[2], &fakeReaderStore{teamErr: errors.New("read failed")}, false, 500, 1},
		{"summary query failure", paths[3], &fakeReaderStore{summaryErr: errors.New("read failed")}, false, 500, 1},
		{"metadata failure", paths[0], &fakeReaderStore{freshnessErr: errors.New("read failed")}, false, 500, 1},
		{"bracket metadata failure", paths[1], &fakeReaderStore{freshnessErr: errors.New("read failed")}, false, 500, 1},
		{"team metadata failure", paths[2], &fakeReaderStore{teams: map[string]*TeamProfile{"arg": {}}, freshnessErr: errors.New("read failed")}, false, 500, 1},
		{"summary metadata failure", paths[3], &fakeReaderStore{summary: &MatchSummary{}, freshnessErr: errors.New("read failed")}, false, 500, 1},
		{"missing team", paths[2], &fakeReaderStore{}, false, 404, 1},
		{"missing summary", paths[3], &fakeReaderStore{summaryErr: ErrNotFound}, false, 404, 1},
		{"panic", paths[0], &fakeReaderStore{}, true, 500, 1},
		{"invalid UUID", "/v1/matches/not-uuid", &fakeReaderStore{}, false, 404, 0},
		{"unknown scope", "/v1/competitions/unknown/2026/matches", &fakeReaderStore{}, false, 400, 0},
		{"unknown bracket scope", "/v1/competitions/world-cup/unknown/bracket", &fakeReaderStore{}, false, 400, 0},
		{"unknown team scope", "/v1/competitions/unknown/2026/teams/arg", &fakeReaderStore{}, false, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &trackingSnapshotStore{fakeReaderStore: tc.fake}
			if tc.begins == 0 {
				store.beginErr = errors.New("database unavailable")
			}
			if tc.panic {
				store.read = &panickingMatchReader{matchReader: tc.fake}
			}
			app := newTestApp(t, tc.fake, &fakeNewsReader{})
			app.store = store
			response := responseAfterSnapshotClosed(t, app.router(), tc.path, store)
			if response.Code != tc.status || store.begins != tc.begins || store.closes != tc.begins {
				t.Fatalf("error path leaked snapshot: status=%d begins=%d closes=%d", response.Code, store.begins, store.closes)
			}
			if strings.Contains(response.Body.String(), "synthetic") {
				t.Fatal("dependency details leaked")
			}
		})
	}
}

type failingScopeReader struct {
	matchReader
	scope freshnessScope
	err   error
}

func (r *failingScopeReader) MatchScope(context.Context, string) (freshnessScope, error) {
	return r.scope, r.err
}

func TestMatchSnapshotScopeFailuresReleaseBeforeWriting(t *testing.T) {
	for _, tc := range []struct {
		name   string
		scope  freshnessScope
		err    error
		status int
	}{
		{"missing scope", freshnessScope{}, ErrNotFound, 404},
		{"scope query failure", freshnessScope{}, errors.New("query failed"), 500},
		{"unregistered stored scope", freshnessScope{Competition: "unknown", Season: "2026"}, nil, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeReaderStore{summary: &MatchSummary{}}
			store := &trackingSnapshotStore{
				fakeReaderStore: fake,
				read:            &failingScopeReader{matchReader: fake, scope: tc.scope, err: tc.err},
			}
			app := newTestApp(t, fake, &fakeNewsReader{})
			app.store = store
			response := responseAfterSnapshotClosed(t, app.router(), "/v1/matches/"+finalMatchID, store)
			if response.Code != tc.status || store.closes != 1 || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("scope failure status=%d closes=%d headers=%v", response.Code, store.closes, response.Header())
			}
		})
	}
}

type snapshotTx struct {
	pgx.Tx
	rollbackContextErr error
	cleanupDeadline    time.Time
	rollbacks          int
}

func (tx *snapshotTx) Rollback(ctx context.Context) error {
	tx.rollbacks++
	tx.rollbackContextErr = ctx.Err()
	tx.cleanupDeadline, _ = ctx.Deadline()
	return nil
}

type snapshotDB struct {
	database
	tx      *snapshotTx
	options pgx.TxOptions
	err     error
}

func (db *snapshotDB) BeginTx(_ context.Context, options pgx.TxOptions) (pgx.Tx, error) {
	db.options = options
	return db.tx, db.err
}

func TestStoreSnapshotOptionsAndCancelledCleanup(t *testing.T) {
	tx := &snapshotTx{}
	db := &snapshotDB{tx: tx}
	ctx, cancel := context.WithCancel(context.Background())
	reader, close, err := NewStore(db).Snapshot(ctx)
	if err != nil || reader == nil || close == nil {
		t.Fatalf("snapshot=%v close nil=%v error=%v", reader, close == nil, err)
	}
	if db.options.IsoLevel != pgx.RepeatableRead || db.options.AccessMode != pgx.ReadOnly {
		t.Fatalf("unsafe transaction options: %+v", db.options)
	}
	cancel()
	if err := close(); err != nil {
		t.Fatal(err)
	}
	if tx.rollbacks != 1 || tx.rollbackContextErr != nil || time.Until(tx.cleanupDeadline) <= 0 || time.Until(tx.cleanupDeadline) > time.Second {
		t.Fatalf("cleanup must survive request cancellation with bounded context: %+v", tx)
	}
	db.err = errors.New("begin failed")
	reader, close, err = NewStore(db).Snapshot(context.Background())
	if !errors.Is(err, db.err) || reader != nil || close != nil || tx.rollbacks != 1 {
		t.Fatal("begin failure fabricated a snapshot")
	}
}

type interleavingReaderStore struct {
	readerStore
	beforeFreshness func()
}

func (s *interleavingReaderStore) Freshness(ctx context.Context, scope freshnessScope) (freshnessSnapshot, error) {
	s.beforeFreshness()
	return s.readerStore.Freshness(ctx, scope)
}

func (s *interleavingReaderStore) Snapshot(ctx context.Context) (matchReader, func() error, error) {
	reader, close, err := s.readerStore.Snapshot(ctx)
	return &interleavingSnapshot{matchReader: reader, beforeFreshness: s.beforeFreshness}, close, err
}

type interleavingSnapshot struct {
	matchReader
	beforeFreshness func()
}

func (s *interleavingSnapshot) Freshness(ctx context.Context, scope freshnessScope) (freshnessSnapshot, error) {
	s.beforeFreshness()
	return s.matchReader.Freshness(ctx, scope)
}

func TestMatchRoutesKeepBodyAndFreshnessInOneSnapshot(t *testing.T) {
	ctx := context.Background()
	for _, route := range []struct {
		name, path string
		body       func(*Store) (any, error)
	}{
		{"matches", "/v1/competitions/world-cup/2026/matches", func(s *Store) (any, error) { return s.Matches(ctx, "world-cup", "2026") }},
		{"bracket", "/v1/competitions/world-cup/2026/bracket", func(s *Store) (any, error) { return s.Bracket(ctx, "world-cup", "2026") }},
		{"summary", "/v1/matches/" + finalMatchID, func(s *Store) (any, error) { return s.MatchSummary(ctx, finalMatchID) }},
		{"team", "/v1/competitions/world-cup/2026/teams/nat-arg", func(s *Store) (any, error) { return s.Team(ctx, "nat-arg", "world-cup", "2026") }},
	} {
		t.Run(route.name, func(t *testing.T) {
			store, admin := newIntegrationStore(t)
			now := time.Date(2026, 7, 19, 23, 0, 0, 0, time.UTC)
			for _, sql := range []string{
				`UPDATE match SET kickoff=$1::timestamptz+interval '1 hour' WHERE id='` + semiMatchID + `'`,
				`INSERT INTO match_sync_status(match_id,source,observed_at)
				 SELECT id,'espn',$1 FROM match WHERE competition_id='world-cup' AND season_id='2026'`,
				`INSERT INTO match_poll_status(competition_id,season_id,source,attempted_at,succeeded_at,outcome,event_count)
				 VALUES('world-cup','2026','espn',$1,$1,'ok',2)`,
			} {
				if _, err := admin.Exec(ctx, sql, now); err != nil {
					t.Fatal(err)
				}
			}
			body, err := route.body(store)
			if err != nil {
				t.Fatal(err)
			}
			expected, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			interleaved := false
			wrapped := &interleavingReaderStore{readerStore: store, beforeFreshness: func() {
				if interleaved {
					t.Fatal("freshness read more than once")
				}
				interleaved = true
				tx, err := admin.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				// A separate recovery transaction commits after the response
				// body was read and before its freshness metadata is read.
				if _, err := tx.Exec(ctx, `UPDATE match_detail SET scorers='[]' WHERE match_id=$1`, finalMatchID); err != nil {
					t.Fatal(err)
				}
				if _, err := tx.Exec(ctx, `UPDATE match SET state='finished',home_score=3,away_score=2,
					status_name='STATUS_FINAL',finalized_at=$1 WHERE id=$2`, now, finalMatchID); err != nil {
					t.Fatal(err)
				}
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}}
			app := newTestApp(t, &fakeReaderStore{}, &fakeNewsReader{})
			app.store = wrapped
			app.now = func() time.Time { return now }
			response := performRequest(app.router(), "GET", route.path)
			if !interleaved {
				t.Fatal("recovery was not interleaved")
			}
			if response.Code != 200 || response.Body.String() != string(expected)+"\n" {
				t.Fatalf("response body changed: %d %s", response.Code, response.Body.String())
			}
			if response.Header().Get("X-ScoreArc-Freshness") != "stale" ||
				response.Header().Get("X-ScoreArc-Overdue-Matches") != "1" {
				t.Errorf("old overdue body paired with newer metadata: %v", response.Header())
			}
			current, err := store.Freshness(ctx, freshnessScope{Competition: "world-cup", Season: "2026"})
			if err != nil {
				t.Fatal(err)
			}
			if got := computeFreshness(now, now.Add(-time.Hour), now.Add(time.Hour), current); got.Status != "fresh" {
				t.Fatalf("interleaved recovery did not commit healthy metadata: %+v", got)
			}
			var idleTransactions int
			if err := admin.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
				WHERE usename='scorearc_reader_test' AND state LIKE 'idle in transaction%'`).Scan(&idleTransactions); err != nil {
				t.Fatal(err)
			}
			if idleTransactions != 0 {
				t.Fatalf("reader leaked %d transactions", idleTransactions)
			}
		})
	}
}
