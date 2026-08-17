package model

// OddsLine preserves the provider's market values. Nil means the provider did
// not supply that value; no missing value is converted to zero.
type OddsLine struct {
	HomeMoneyline *int
	DrawMoneyline *int
	AwayMoneyline *int
	Spread        *float64
	OverUnder     *float64
	OverOdds      *int
	UnderOdds     *int
}

// ProviderOdds is one sportsbook's fixed opening and closing lines plus a
// sampled current line. It retains American odds rather than performing a lossy
// implied-probability conversion.
type ProviderOdds struct {
	ProviderID   string
	ProviderName string
	Open         *OddsLine
	Close        *OddsLine
	Current      *OddsLine
}
