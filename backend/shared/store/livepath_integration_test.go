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

// livePoll is what one 20-second poll of a match in progress hands the store.
// Everything grows the way a real match grows: the transcript gains three
// lines a tick, a substitute appears at tick 6, and a goal is scored at tick 8.
func livePoll(tick int) *model.MatchParticipation {
	part := &model.MatchParticipation{
		HomeTeamSourceID: "359",
		AwayTeamSourceID: "363",
		Home: []model.SquadPlayer{
			{SourceID: "p1", Name: "Bukayo Saka", Position: "F", Starter: true},
			{SourceID: "p2", Name: "Reserve Keeper", Position: "G", Starter: false},
		},
		Away: []model.SquadPlayer{
			{SourceID: "p3", Name: "Cole Palmer", Position: "M", Starter: true},
		},
		Events: []model.PlayerEvent{
			{TeamSourceID: "359", PlayerSourceID: "p1", PlayerName: "Bukayo Saka",
				Type: model.PlayerEventYellow, Minute: "12'", Detail: "Yellow Card"},
		},
	}
	if tick >= 6 {
		part.Away = append(part.Away, model.SquadPlayer{
			SourceID: "p4", Name: "Late Substitute", Position: "F", Starter: false,
		})
		part.Events = append(part.Events, model.PlayerEvent{
			TeamSourceID: "363", PlayerSourceID: "p4", PlayerName: "Late Substitute",
			Type: model.PlayerEventSubOn, Minute: "60'", Detail: "Substitution",
		})
	}
	if tick >= 8 {
		scored := 1
		part.Home[0].Stats = &model.PlayerMatchStats{Goals: &scored}
		part.Events = append(part.Events, model.PlayerEvent{
			TeamSourceID: "359", PlayerSourceID: "p1", PlayerName: "Bukayo Saka",
			Type: model.PlayerEventGoal, Minute: "71'", Detail: "Goal",
		})
	}
	return part
}

// The claim this whole plan makes, stated as a test: a live match's cost is a
// function of the number of polls and of what actually changed, never of how
// much has already happened.
func TestLivePathStatementsScaleWithNewRowsNotAccumulatedOnes(t *testing.T) {
	store, pool, counter := newTracedStore(t)
	ctx := context.Background()
	matchID := mustParticipationMatch(t, store, pool)

	const ticks = 12
	counter.reset()
	for tick := 1; tick <= ticks; tick++ {
		if _, err := store.WriteParticipation(ctx, "espn", matchID,
			"eng-arsenal", "eng-chelsea", livePoll(tick)); err != nil {
			t.Fatalf("tick %d participation: %v", tick, err)
		}
		if _, err := store.WriteCommentary(ctx, matchID, growingTranscript(tick)); err != nil {
			t.Fatalf("tick %d commentary: %v", tick, err)
		}
	}

	// One statement per table per tick. Not one per row.
	for _, table := range countedTables {
		if got := counter.count(table); got != ticks {
			t.Fatalf("%s took %d statements over %d ticks, want exactly %d "+
				"(one per poll, independent of accumulated rows)", table, got, ticks, ticks)
		}
	}

	// And what those statements produced is the football, not a rewrite of it.
	if got := countRows(t, pool,
		`SELECT count(*) FROM match_commentary WHERE match_id=$1`, matchID); got != ticks*3 {
		t.Fatalf("commentary rows = %d, want %d", got, ticks*3)
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM appearance WHERE match_id=$1`, matchID); got != 4 {
		t.Fatalf("appearances = %d, want 4 (three from kickoff, one substitute)", got)
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM match_event WHERE match_id=$1`, matchID); got != 3 {
		t.Fatalf("events = %d, want 3", got)
	}

	// Tuple versions are the real cost. Four appearances polled twelve times
	// must not be forty-eight tuple versions: p1 changes once (the goal at tick
	// 8), p4 is inserted once (tick 6), p2 and p3 never change at all.
	versions := tupleVersions(t, pool,
		`SELECT DISTINCT xmin::text FROM appearance WHERE match_id=$1`, matchID)
	if len(versions) > 3 {
		t.Fatalf("appearance tuple versions = %d, want at most 3 "+
			"(kickoff insert, the substitute, the goal)", len(versions))
	}
}
