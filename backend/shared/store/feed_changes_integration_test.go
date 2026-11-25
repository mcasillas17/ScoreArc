package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/feeddrift"
)

func TestRecordFeedChangesRetainsFirstEvidenceAndCountsObservedHours(t *testing.T) {
	ctx := context.Background()
	_, owner, dsn := newIntegrationStoreDSN(t)
	writer, _ := newIngesterRoleStore(t, owner, dsn)
	first := feeddrift.Finding{Kind: "new_field", Path: "$.unexpected", Detail: "number", Example: json.RawMessage(`1`)}
	second := first
	second.Example = json.RawMessage(`2`)
	changes := []feeddrift.Finding{first, second}
	if err := writer.RecordFeedChanges(ctx, "roster", "premier-league", changes); err != nil {
		t.Fatal(err)
	}

	// Backdate the row to exercise an hourly renewal without sleeping.
	if _, err := owner.Exec(ctx, `UPDATE espn_feed_change SET first_seen_at='2000-01-01T00:00:00Z',last_seen_at='2000-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if err := writer.RecordFeedChanges(ctx, "roster", "liga-mx", []feeddrift.Finding{second}); err != nil {
				t.Errorf("concurrent observation: %v", err)
			}
		})
	}
	wg.Wait()
	var competition, example string
	var firstAt, lastAt time.Time
	var hours int
	if err := owner.QueryRow(ctx, `SELECT first_competition, example::text, first_seen_at, last_seen_at, observed_hours FROM espn_feed_change`).Scan(&competition, &example, &firstAt, &lastAt, &hours); err != nil {
		t.Fatal(err)
	}
	if competition != "premier-league" || example != "1" || !firstAt.Equal(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || !lastAt.After(firstAt) || hours != 2 {
		t.Fatalf("retained %s %s %s %s over %d hours", competition, example, firstAt, lastAt, hours)
	}

	// A distinct detail, kind, path or endpoint is a distinct signature.
	for i, change := range []feeddrift.Finding{
		{Kind: first.Kind, Path: first.Path, Detail: "string", Example: json.RawMessage(`"x"`)},
		{Kind: "type_changed", Path: first.Path, Detail: first.Detail, Example: first.Example},
		{Kind: first.Kind, Path: "$.other", Detail: first.Detail, Example: first.Example},
		first,
	} {
		endpoint := "roster"
		if i == 3 {
			endpoint = "bio"
		}
		if err := writer.RecordFeedChanges(ctx, endpoint, "liga-mx", []feeddrift.Finding{change}); err != nil {
			t.Fatal(err)
		}
	}
	if n := countRows(t, owner, `SELECT count(*) FROM espn_feed_change`); n != 5 {
		t.Fatalf("distinct signatures = %d, want 5", n)
	}

	valid := feeddrift.Finding{Kind: "new_field", Path: "$.valid", Example: json.RawMessage(`true`)}
	invalid := valid
	invalid.Example = json.RawMessage(`"` + strings.Repeat("x", feeddrift.MaxExampleBytes) + `"`)
	if err := writer.RecordFeedChanges(ctx, "roster", "liga-mx", []feeddrift.Finding{valid, invalid}); err == nil {
		t.Fatal("oversized example accepted")
	}
	if n := countRows(t, owner, `SELECT count(*) FROM espn_feed_change WHERE path='$.valid'`); n != 0 {
		t.Fatalf("invalid batch partially committed: %d", n)
	}
}

func TestRecordFeedChangesBoundsConcurrentNewSignaturesPerKindAndEndpoint(t *testing.T) {
	ctx := context.Background()
	_, owner, dsn := newIntegrationStoreDSN(t)
	writer, _ := newIngesterRoleStore(t, owner, dsn)
	if _, err := owner.Exec(ctx, `INSERT INTO espn_feed_change (endpoint, kind, path, detail, first_competition, example)
		SELECT 'bio','new_field','$.seed'||i,'boolean','first','true'::json FROM generate_series(1, $1::int) AS i`, maxFeedSignaturesPerKind-1); err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, 4)
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Go(func() {
			change := feeddrift.Finding{Kind: "new_field", Path: fmt.Sprintf("$.random%d", i), Detail: "boolean", Example: json.RawMessage(`true`)}
			errs <- writer.RecordFeedChanges(ctx, "bio", "late", []feeddrift.Finding{change})
		})
	}
	wg.Wait()
	close(errs)
	dropped := 0
	for err := range errs {
		if errors.Is(err, ErrFeedChangeCapacity) {
			dropped++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if got := countRows(t, owner, `SELECT count(*) FROM espn_feed_change`); got != maxFeedSignaturesPerKind || dropped != 3 {
		t.Fatalf("rows=%d dropped=%d", got, dropped)
	}
	existing := feeddrift.Finding{Kind: "new_field", Path: "$.seed1", Detail: "boolean", Example: json.RawMessage(`false`)}
	if err := writer.RecordFeedChanges(ctx, "bio", "late", []feeddrift.Finding{existing}); err != nil {
		t.Fatalf("existing evidence at capacity: %v", err)
	}
	failure := feeddrift.Finding{Kind: "required_missing", Path: "$.athletes", Detail: "required", Example: json.RawMessage(`null`)}
	fullKind := existing
	fullKind.Path = "$.overflow"
	if err := writer.RecordFeedChanges(ctx, "bio", "late", []feeddrift.Finding{failure, fullKind}); !errors.Is(err, ErrFeedChangeCapacity) {
		t.Fatalf("expected overflow in mixed batch: %v", err)
	}
	if n := countRows(t, owner, `SELECT count(*) FROM espn_feed_change WHERE kind='required_missing'`); n != 1 {
		t.Fatal("overflow masked an independent contract failure")
	}
	if err := writer.RecordFeedChanges(ctx, "roster", "late", []feeddrift.Finding{existing}); err != nil {
		t.Fatalf("independent endpoint: %v", err)
	}
}
