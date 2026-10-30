package espn

import (
	"fmt"
	"strings"
	"testing"
)

func TestLeaderCollectionRejectsUnvalidatedTailAndCounts(t *testing.T) {
	valid := `{"value":1,"athlete":{"displayName":"Player"}}`
	for name, row := range map[string]string{
		"missing value":  `{"athlete":{"displayName":"Player"}}`,
		"null value":     `{"value":null,"athlete":{"displayName":"Player"}}`,
		"malformed tail": `{"value":2,"athlete":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			raw := fmt.Sprintf(`{"stats":[{"name":"goalsLeaders","leaders":[%s,%s]}]}`, strings.TrimSuffix(strings.Repeat(valid+",", 30), ","), row)
			if _, err := MapLeaders([]byte(raw), "goalsLeaders", 30); err == nil {
				t.Fatal("accepted an invalid supplied row outside the published top thirty")
			}
		})
	}
}

func TestCollectionRejectsSuppliedIncompleteMetadata(t *testing.T) {
	for _, metadata := range []string{
		`"truncated":true`, `"hasMore":true`, `"pageCount":2`,
		`"pageIndex":2`, `"offset":1`, `"count":1`, `"total":1`,
		`"totalCount":1`, `"next":"/page/2"`, `"count":null`,
		`"pagination":{"pageCount":2}`,
	} {
		t.Run(metadata, func(t *testing.T) {
			if _, err := MapStandings([]byte(`{"children":[],` + metadata + `}`)); err == nil {
				t.Error("accepted incomplete standings")
			}
			if _, err := MapLeaders([]byte(`{"stats":[{"name":"goalsLeaders","leaders":[],`+metadata+`}]}`), "goalsLeaders", 30); err == nil {
				t.Error("accepted incomplete leaders")
			}
			if _, err := MapRoster([]byte(`{"status":"success","team":{"id":"1"},"athletes":[],` + metadata + `}`)); err == nil {
				t.Error("accepted incomplete roster")
			}
		})
	}
}

func TestLeaderObservationAllowsCompleteMetadataBeforeLimiting(t *testing.T) {
	raw := []byte(`{"stats":[{"name":"goalsLeaders","pageIndex":1,"pageCount":1,"pageSize":2,"total":2,"leaders":[{"value":0,"athlete":{"displayName":"First"}},{"value":1,"athlete":{"displayName":"Second"}}]},{"name":"assistsLeaders","leaders":[{"value":"invalid","athlete":{"displayName":"Third"}}]}]}`)
	board, err := MapLeadersObservation(raw, "goalsLeaders", 1)
	if err != nil || len(board) != 1 || board[0].Player != "First" || board[0].Value != 0 {
		t.Fatalf("complete goals board=%+v err=%v", board, err)
	}
	if _, err := MapLeadersObservation(raw, "assistsLeaders", 1); err == nil {
		t.Fatal("invalid metric accepted")
	}
}

func TestLeaderCollectionRejectsDuplicateCategory(t *testing.T) {
	raw := []byte(`{"stats":[{"name":"goalsLeaders","leaders":[]},{"name":"goalsLeaders","leaders":[]}]}`)
	if _, err := MapLeaders(raw, "goalsLeaders", 30); err == nil {
		t.Fatal("accepted duplicate goals collections")
	}
}
