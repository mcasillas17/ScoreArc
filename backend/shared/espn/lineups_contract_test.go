package espn

import (
	"encoding/json"
	"testing"
)

func TestSummaryLineupsKeepBenchIdentityAndNullableStats(t *testing.T) {
	raw := []byte(`{"header":{"competitions":[{"competitors":[{"homeAway":"home","team":{"id":"h"}},{"homeAway":"away","team":{"id":"a"}}]}]},"rosters":[{"team":{"id":"h"},"formation":"4-3-3","roster":[{"starter":true,"athlete":{"id":"1","displayName":"Keeper"},"position":{"abbreviation":"GK"},"stats":[{"name":"appearances","value":1},{"name":"saves","value":0}]},{"starter":false,"athlete":{"id":"2","displayName":"Bench"},"stats":[{"name":"appearances","value":0},{"name":"subIns","value":0}]}]},{"team":{"id":"a"},"roster":[{"starter":true,"athlete":{"id":"3","displayName":"Forward"},"stats":[{"name":"totalShots","value":3}]}]}]}`)
	detail, err := MapSummary(raw)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(detail.Lineups)
	var wire map[string]any
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatal(err)
	}
	home := wire["home"].(map[string]any)
	players := home["players"].([]any)
	if len(players) != 2 {
		t.Fatalf("full roster lost: %s", b)
	}
	first := players[0].(map[string]any)
	if first["athleteId"] != "1" || first["starter"] != true || first["playerSlug"] != nil || first["playerId"] != nil {
		t.Fatalf("identity: %s", b)
	}
	stats := first["stats"].(map[string]any)
	if len(stats) != 15 || stats["saves"] != float64(0) || stats["offsides"] != nil || stats["appearances"] != float64(1) {
		t.Fatalf("position nullability: %s", b)
	}
	bench := players[1].(map[string]any)
	if bench["starter"] != false || bench["stats"].(map[string]any)["appearances"] != float64(0) {
		t.Fatalf("bench: %s", b)
	}
}
