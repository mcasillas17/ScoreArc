package model_test

import (
	"encoding/json"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func TestMatchJSONContract(t *testing.T) {
	raw, err := json.Marshal(model.Match{ID: "m1", State: model.MatchStateLive})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) == "" {
		t.Fatal("expected JSON")
	}
	if model.MatchStateFinished != "finished" {
		t.Fatalf("unexpected finished state %q", model.MatchStateFinished)
	}
}
