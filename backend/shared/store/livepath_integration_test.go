package store

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// statementCounter counts every statement the store issues, per table.
//
// It traces the pgx connection rather than reading pg_stat_user_tables because
// the statistics collector flushes asynchronously and an assertion on it would
// be a race. Batched queries are counted individually: pgx calls
// TraceBatchQuery once per queued statement, which is exactly the property this
// file exists to measure -- a 113-statement batch is 113 statements.
type statementCounter struct {
	mu      sync.Mutex
	byTable map[string]int
}

// countedTables are matched as substrings of the SQL. They are distinct enough
// that no statement counts twice: the commentary statement never mentions
// appearance, and the identity queries WriteParticipation runs first mention
// neither.
var countedTables = []string{"match_commentary", "appearance", "match_event"}

func newStatementCounter() *statementCounter {
	return &statementCounter{byTable: make(map[string]int)}
}

func (c *statementCounter) record(sql string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, table := range countedTables {
		if strings.Contains(sql, table) {
			c.byTable[table]++
		}
	}
}

func (c *statementCounter) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byTable = make(map[string]int)
}

func (c *statementCounter) count(table string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byTable[table]
}

func (c *statementCounter) TraceQueryStart(
	ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData,
) context.Context {
	c.record(data.SQL)
	return ctx
}

func (c *statementCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (c *statementCounter) TraceBatchStart(
	ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchStartData,
) context.Context {
	return ctx
}

func (c *statementCounter) TraceBatchQuery(
	_ context.Context, _ *pgx.Conn, data pgx.TraceBatchQueryData,
) {
	c.record(data.SQL)
}

func (c *statementCounter) TraceBatchEnd(context.Context, *pgx.Conn, pgx.TraceBatchEndData) {}

var _ pgx.QueryTracer = (*statementCounter)(nil)
var _ pgx.BatchTracer = (*statementCounter)(nil)

// newTracedStore boots the same migrated Postgres every other integration test
// uses, then opens a SECOND pool with a tracer attached and wraps it in a bare
// Store literal -- which store.go documents as safe, because the identity cache
// initialises on first use.
func newTracedStore(t *testing.T) (*Store, *pgxpool.Pool, *statementCounter) {
	t.Helper()
	_, admin, dsn := newIntegrationStoreDSN(t)

	counter := newStatementCounter()
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = counter
	// One connection, so a statement can never be attributed to a tick that had
	// already finished on another.
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &Store{pool: pool}, admin, counter
}

// liveTick is one 20-second poll of a match in progress. Everything is derived
// from the tick number: no wall clock is read anywhere in this file.
const liveTickInterval = 20 * time.Second

var liveMatchKickoff = time.Date(2026, 8, 22, 19, 0, 0, 0, time.UTC)

func liveTickAt(tick int) time.Time {
	return liveMatchKickoff.Add(time.Duration(tick) * liveTickInterval)
}

// growingTranscript is what ESPN hands back on tick N: the whole accumulated
// commentary, three lines longer than the tick before. That cumulative shape is
// the entire problem this plan exists to fix.
func growingTranscript(tick int) []model.CommentaryLine {
	lines := make([]model.CommentaryLine, 0, tick*3)
	for seq := 1; seq <= tick*3; seq++ {
		period, clock := 1, seq
		wallclock := liveTickAt(seq)
		lines = append(lines, model.CommentaryLine{
			Seq: seq, Period: &period, ClockValue: &clock, ClockDisplay: "",
			PlayType: "pass", PlayTypeText: "Pass", Wallclock: &wallclock,
			Text: fmt.Sprintf("Minute %d: a pass.", seq),
		})
	}
	return lines
}

// A live match is polled every 20 seconds for two hours. The number of
// statements that costs must be a function of the number of TICKS, never of how
// much football has already been played -- otherwise the 90th minute costs
// ninety times the first.
func TestCommentaryTickCostDoesNotGrowWithTheTranscript(t *testing.T) {
	store, pool, counter := newTracedStore(t)
	ctx := context.Background()
	matchID := mustCommentaryMatch(t, store, pool)

	const ticks = 12
	perTick := make([]int, ticks+1)
	written := make([]int, ticks+1)
	for tick := 1; tick <= ticks; tick++ {
		counter.reset()
		rows, err := store.WriteCommentary(ctx, matchID, growingTranscript(tick))
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		perTick[tick] = counter.count("match_commentary")
		written[tick] = rows
	}

	// The cost of a tick is constant.
	for tick := 2; tick <= ticks; tick++ {
		if perTick[tick] != perTick[1] {
			t.Fatalf("tick %d issued %d statements against match_commentary, tick 1 issued %d: "+
				"cost scales with the accumulated transcript, not with new lines (all ticks: %v)",
				tick, perTick[tick], perTick[1], perTick[1:])
		}
	}
	if perTick[1] != 1 {
		t.Fatalf("one tick = %d statements, want exactly 1", perTick[1])
	}

	// And what it writes is exactly the three new lines.
	for tick := 2; tick <= ticks; tick++ {
		if written[tick] != 3 {
			t.Fatalf("tick %d wrote %d rows, want the 3 new lines only (all ticks: %v)",
				tick, written[tick], written[1:])
		}
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID); got != ticks*3 {
		t.Fatalf("stored rows = %d, want %d", got, ticks*3)
	}
}
