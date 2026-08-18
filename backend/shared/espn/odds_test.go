package espn

import (
	"os"
	"strings"
	"testing"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

func oddsFloat(value float64) *float64 { return &value }

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

func TestMapOddsSkipsProvidersWithoutIDOrName(t *testing.T) {
	providers, err := MapOdds([]byte(`{"items":[
		{"provider":{"name":"No id"}},
		{"provider":{"id":"200","name":"   "}},
		{"provider":{"id":"100","name":"DraftKings"}}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 {
		t.Fatalf("providers = %#v, want only DraftKings", providers)
	}
	if providers[0].ProviderID != "100" || providers[0].ProviderName != "DraftKings" {
		t.Fatalf("providers = %#v, want only DraftKings", providers)
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

func TestMapOddsUsesFlattenedCurrentSpreadWhenNestedCurrentIsAbsent(t *testing.T) {
	raw := []byte(`{"items":[{
		"provider":{"id":"100","name":"DraftKings"},
		"spread":0.5,
		"homeTeamOdds":{"spreadOdds":130},
		"awayTeamOdds":{"spreadOdds":-180}
	}]}`)

	providers, err := MapOdds(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].Current == nil {
		t.Fatalf("providers = %#v, want one current phase", providers)
	}
	current := providers[0].Current
	if current.Spread == nil || *current.Spread != 0.5 ||
		current.HomeSpreadOdds == nil || *current.HomeSpreadOdds != 130 ||
		current.AwaySpreadOdds == nil || *current.AwaySpreadOdds != -180 {
		t.Fatalf("current = %#v, want flattened spread line and prices", current)
	}
}

func TestParseAmericanIntAcceptsPostgresInt4Bounds(t *testing.T) {
	tests := []struct {
		raw  string
		want int
	}{
		{raw: " +2147483647 ", want: 2147483647},
		{raw: "-2147483648", want: -2147483648},
	}

	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			got := parseAmericanInt(test.raw)
			if got == nil || *got != test.want {
				t.Fatalf("parseAmericanInt(%q) = %v, want %d", test.raw, got, test.want)
			}
		})
	}
}

func TestParseAmericanIntRejectsValuesOutsidePostgresInt4(t *testing.T) {
	for _, raw := range []string{"2147483648", "-2147483649"} {
		t.Run(raw, func(t *testing.T) {
			if got := parseAmericanInt(raw); got != nil {
				t.Fatalf("parseAmericanInt(%q) = %d, want nil", raw, *got)
			}
		})
	}
}

func TestMapOddsRejectsInvalidFlattenedAmericanValues(t *testing.T) {
	raw := []byte(`{"items":[{
		"provider":{"id":"100","name":"DraftKings"},
		"homeTeamOdds":{"moneyLine":2147483648,"spreadOdds":130.5},
		"awayTeamOdds":{"moneyLine":-2147483649,"spreadOdds":-180.5},
		"overOdds":2147483648,
		"underOdds":-2147483649
	}]}`)

	providers, err := MapOdds(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 {
		t.Fatalf("providers = %#v, want one provider", providers)
	}
	if providers[0].Current != nil {
		t.Fatalf("current = %#v, want nil for invalid flattened American values", providers[0].Current)
	}
}

func TestParseOddsDecimalBoundsPostgresNumeric52(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want *float64
	}{
		{name: "accepts exact positive bound", raw: " +999.99 ", want: oddsFloat(999.99)},
		{name: "accepts exact negative bound", raw: "-999.99", want: oddsFloat(-999.99)},
		{name: "accepts positive value that rounds into bound", raw: "999.994", want: oddsFloat(999.994)},
		{name: "accepts negative value that rounds into bound", raw: "-999.994", want: oddsFloat(-999.994)},
		{name: "rejects positive value that rounds above bound", raw: "999.995"},
		{name: "rejects negative value that rounds below bound", raw: "-999.995"},
		{name: "rejects value above positive bound", raw: "1000"},
		{name: "rejects value below negative bound", raw: "-1000"},
		{name: "rejects nan", raw: "NaN"},
		{name: "rejects positive infinity", raw: "+Inf"},
		{name: "rejects negative infinity", raw: "-Inf"},
		{name: "rejects empty string", raw: "   "},
		{name: "rejects malformed string", raw: "not-a-number"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := parseOddsDecimal(test.raw)
			if test.want == nil {
				if got != nil {
					t.Fatalf("parseOddsDecimal(%q) = %v, want nil", test.raw, *got)
				}
				return
			}
			if got == nil || *got != *test.want {
				t.Fatalf("parseOddsDecimal(%q) = %v, want %v", test.raw, got, *test.want)
			}
		})
	}
}

func TestMapOddsRejectsOutOfRangeFlattenedCurrentDecimals(t *testing.T) {
	raw := []byte(`{"items":[{
		"provider":{"id":"100","name":"DraftKings"},
		"spread":1000,
		"overUnder":-1000,
		"homeTeamOdds":{"moneyLine":125}
	}]}`)

	providers, err := MapOdds(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].Current == nil {
		t.Fatalf("providers = %#v, want one current phase", providers)
	}

	current := providers[0].Current
	if current.HomeMoneyline == nil || *current.HomeMoneyline != 125 {
		t.Fatalf("current = %#v, want the valid moneyline to survive", current)
	}
	if current.Spread != nil || current.OverUnder != nil {
		t.Fatalf("current = %#v, want out-of-range flattened decimals nil", current)
	}
}

func TestMapOddsAcceptsFlattenedCurrentDecimalsThatRoundIntoNumeric52(t *testing.T) {
	raw := []byte(`{"items":[{
		"provider":{"id":"100","name":"DraftKings"},
		"spread":999.994,
		"overUnder":-999.994,
		"homeTeamOdds":{"moneyLine":125}
	}]}`)

	providers, err := MapOdds(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].Current == nil {
		t.Fatalf("providers = %#v, want one current phase", providers)
	}

	current := providers[0].Current
	if current.Spread == nil || *current.Spread != 999.994 {
		t.Fatalf("current spread = %v, want 999.994", current.Spread)
	}
	if current.OverUnder == nil || *current.OverUnder != -999.994 {
		t.Fatalf("current overUnder = %v, want -999.994", current.OverUnder)
	}
}

func TestMapOddsRejectsFlattenedCurrentDecimalsThatRoundOutsideNumeric52(t *testing.T) {
	raw := []byte(`{"items":[{
		"provider":{"id":"100","name":"DraftKings"},
		"spread":999.995,
		"overUnder":-999.995,
		"homeTeamOdds":{"moneyLine":125}
	}]}`)

	providers, err := MapOdds(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].Current == nil {
		t.Fatalf("providers = %#v, want one current phase", providers)
	}

	current := providers[0].Current
	if current.Spread != nil || current.OverUnder != nil {
		t.Fatalf("current = %#v, want rounded-overflow flattened decimals nil", current)
	}
}
