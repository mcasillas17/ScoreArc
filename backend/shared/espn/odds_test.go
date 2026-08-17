package espn

import (
	"os"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func loadOdds(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/espn-odds.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestMapOddsMapsRecordedLadder(t *testing.T) {
	providers, err := MapOdds(loadOdds(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 {
		t.Fatalf("providers = %d, want 1", len(providers))
	}

	provider := providers[0]
	if provider.ProviderID != "100" || provider.ProviderName != "DraftKings" {
		t.Fatalf("provider = %#v, want DraftKings/100", provider)
	}
	if provider.Open == nil || provider.Close == nil || provider.Current == nil {
		t.Fatalf("ladder = %#v, want open, close, and current", provider)
	}

	assertOddsLine(t, "open", provider.Open, 500, 340, -225, 1.5, -175, 115, 2.5, -175, 120)
	assertOddsLine(t, "close", provider.Close, 425, 320, -170, 0.5, 130, -180, 2.5, -150, 110)
	assertOddsLine(t, "current", provider.Current, 425, 320, -170, 0.5, 130, -180, 2.5, -150, 110)
}

func assertOddsLine(
	t *testing.T,
	phase string,
	odds *model.OddsLine,
	home, draw, away int,
	spread float64,
	homeSpreadOdds, awaySpreadOdds int,
	overUnder float64,
	over, under int,
) {
	t.Helper()
	if odds.HomeMoneyline == nil || *odds.HomeMoneyline != home ||
		odds.DrawMoneyline == nil || *odds.DrawMoneyline != draw ||
		odds.AwayMoneyline == nil || *odds.AwayMoneyline != away ||
		// pointSpread is the line; spread is the American price for that line.
		odds.Spread == nil || *odds.Spread != spread ||
		odds.HomeSpreadOdds == nil || *odds.HomeSpreadOdds != homeSpreadOdds ||
		odds.AwaySpreadOdds == nil || *odds.AwaySpreadOdds != awaySpreadOdds ||
		odds.OverUnder == nil || *odds.OverUnder != overUnder ||
		odds.OverOdds == nil || *odds.OverOdds != over ||
		odds.UnderOdds == nil || *odds.UnderOdds != under {
		t.Fatalf("%s = %#v, want all recorded market values", phase, odds)
	}
}

func TestMapOddsLeavesMissingMarketLinesNil(t *testing.T) {
	providers, err := MapOdds([]byte(`{"items":[{"provider":{"id":"100","name":"DraftKings"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 {
		t.Fatalf("providers = %d, want 1", len(providers))
	}
	if providers[0].Open != nil || providers[0].Close != nil || providers[0].Current != nil {
		t.Fatalf("provider = %#v, want nil market phases", providers[0])
	}
}

func TestMapOddsAcceptsNoProviders(t *testing.T) {
	providers, err := MapOdds([]byte(`{"count":0,"items":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 0 {
		t.Fatalf("providers = %#v, want empty", providers)
	}
}

func TestMapOddsSkipsProviderWithoutID(t *testing.T) {
	providers, err := MapOdds([]byte(`{"items":[
		{"provider":{"name":"No id"}},
		{"provider":{"id":"100","name":"DraftKings"}}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].ProviderID != "100" {
		t.Fatalf("providers = %#v, want only provider 100", providers)
	}
}

func TestMapOddsRejectsMalformedJSON(t *testing.T) {
	_, err := MapOdds([]byte(`{"items":[}`))
	if err == nil {
		t.Fatal("want malformed JSON error")
	}
	if !strings.Contains(err.Error(), "decode odds") {
		t.Fatalf("err = %v, want decode odds context", err)
	}
}

func TestMapOddsLeavesInvalidAmericanMoneylinesUnknown(t *testing.T) {
	raw := []byte(`{"items":[{
		"provider":{"id":"100","name":"DraftKings"},
		"homeTeamOdds":{"open":{"moneyLine":{"american":"+500.5"}}},
		"awayTeamOdds":{"open":{"moneyLine":{"american":"not-a-number"}}},
		"open":{"total":{"american":"2.5"},"draw":{"american":"+340.25"}}
	}]}`)

	providers, err := MapOdds(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].Open == nil {
		t.Fatalf("providers = %#v, want one open phase", providers)
	}
	open := providers[0].Open
	if open.HomeMoneyline != nil || open.DrawMoneyline != nil || open.AwayMoneyline != nil {
		t.Fatalf("open = %#v, want invalid American moneylines nil", open)
	}
}
