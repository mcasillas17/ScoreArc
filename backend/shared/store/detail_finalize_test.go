package store

import (
	"strings"
	"testing"
)

// The final write is the live upsert with only its two shootout fields made
// authoritative; a drifted replacement pattern would silently keep COALESCE.
func TestDetailFinalizeSQLReplacesOnlyTheShootoutFields(t *testing.T) {
	for _, want := range []string{"shootout=EXCLUDED.shootout,", "shootout_detail=EXCLUDED.shootout_detail,"} {
		if !strings.Contains(detailFinalizeSQL, want) {
			t.Fatalf("final detail write lacks %q", want)
		}
	}
	if strings.Contains(detailFinalizeSQL, "COALESCE(EXCLUDED.shootout") {
		t.Fatal("final detail write keeps a poll's shootout")
	}
	if strings.Count(detailUpsertSQL, "\n")-strings.Count(detailFinalizeSQL, "\n") != 0 ||
		strings.Count(detailUpsertSQL, "COALESCE(")-strings.Count(detailFinalizeSQL, "COALESCE(") != 2 {
		t.Fatal("final detail write differs from the live upsert beyond its shootout fields")
	}
}
