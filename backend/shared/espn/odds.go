package espn

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

type rawOddsPage struct {
	Items []rawProviderOdds `json:"items"`
}

type rawProviderOdds struct {
	Provider     rawOddsProvider `json:"provider"`
	HomeTeamOdds rawCoreTeamOdds `json:"homeTeamOdds"`
	AwayTeamOdds rawCoreTeamOdds `json:"awayTeamOdds"`
	DrawOdds     rawCoreFlatOdds `json:"drawOdds"`

	// ESPN's flattened values are the current market. Spread has no home/away
	// sign, so the mapper gets its spread line from pointSpread instead.
	OverUnder *float64 `json:"overUnder"`
	Spread    *float64 `json:"spread"`
	OverOdds  *float64 `json:"overOdds"`
	UnderOdds *float64 `json:"underOdds"`

	Open    rawOddsPhase `json:"open"`
	Close   rawOddsPhase `json:"close"`
	Current rawOddsPhase `json:"current"`

	// Prop bets are a separate endpoint and intentionally are not followed.
	PropBets rawRef `json:"propBets"`
}

type rawOddsProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type rawCoreTeamOdds struct {
	MoneyLine *float64         `json:"moneyLine"`
	Open      rawTeamOddsPhase `json:"open"`
	Close     rawTeamOddsPhase `json:"close"`
	Current   rawTeamOddsPhase `json:"current"`
}

type rawTeamOddsPhase struct {
	MoneyLine   rawOddsValue `json:"moneyLine"`
	PointSpread rawOddsValue `json:"pointSpread"`
	Spread      rawOddsValue `json:"spread"`
}

type rawOddsPhase struct {
	Over  rawOddsValue `json:"over"`
	Under rawOddsValue `json:"under"`
	Total rawOddsValue `json:"total"`
	Draw  rawOddsValue `json:"draw"`
}

type rawCoreFlatOdds struct {
	MoneyLine *float64 `json:"moneyLine"`
}

type rawOddsValue struct {
	American string `json:"american"`
}

// MapOdds maps every provider in the core odds envelope. It keeps opening and
// closing lines as supplied, and prefers flattened current values while falling
// back to their equivalent nested current phase. Prop-bet refs are not fetched.
func MapOdds(raw []byte) ([]model.ProviderOdds, error) {
	var page rawOddsPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, fmt.Errorf("decode odds: %w", err)
	}

	providers := make([]model.ProviderOdds, 0, len(page.Items))
	for _, item := range page.Items {
		if item.Provider.ID == "" {
			continue
		}
		providers = append(providers, model.ProviderOdds{
			ProviderID:   item.Provider.ID,
			ProviderName: item.Provider.Name,
			Open:         mapOddsPhase(item.Open, item.HomeTeamOdds.Open, item.AwayTeamOdds.Open),
			Close:        mapOddsPhase(item.Close, item.HomeTeamOdds.Close, item.AwayTeamOdds.Close),
			Current:      mapCurrentOdds(item),
		})
	}
	return providers, nil
}

func mapOddsPhase(phase rawOddsPhase, home, away rawTeamOddsPhase) *model.OddsLine {
	line := model.OddsLine{
		HomeMoneyline: parseAmericanInt(home.MoneyLine.American),
		DrawMoneyline: parseAmericanInt(phase.Draw.American),
		AwayMoneyline: parseAmericanInt(away.MoneyLine.American),
		Spread:        parseOddsDecimal(home.PointSpread.American),
		OverUnder:     parseOddsDecimal(phase.Total.American),
		OverOdds:      parseAmericanInt(phase.Over.American),
		UnderOdds:     parseAmericanInt(phase.Under.American),
	}
	if oddsLineEmpty(line) {
		return nil
	}
	return &line
}

func mapCurrentOdds(item rawProviderOdds) *model.OddsLine {
	phase := mapOddsPhase(item.Current, item.HomeTeamOdds.Current, item.AwayTeamOdds.Current)
	if phase == nil {
		phase = &model.OddsLine{}
	}

	line := model.OddsLine{
		HomeMoneyline: firstInt(floatToInt(item.HomeTeamOdds.MoneyLine), phase.HomeMoneyline),
		DrawMoneyline: firstInt(floatToInt(item.DrawOdds.MoneyLine), phase.DrawMoneyline),
		AwayMoneyline: firstInt(floatToInt(item.AwayTeamOdds.MoneyLine), phase.AwayMoneyline),
		Spread:        phase.Spread,
		OverUnder:     firstFloat(item.OverUnder, phase.OverUnder),
		OverOdds:      firstInt(floatToInt(item.OverOdds), phase.OverOdds),
		UnderOdds:     firstInt(floatToInt(item.UnderOdds), phase.UnderOdds),
	}
	if oddsLineEmpty(line) {
		return nil
	}
	return &line
}

func parseAmericanInt(raw string) *int {
	return floatToInt(parseOddsDecimal(raw))
}

func parseOddsDecimal(raw string) *float64 {
	raw = strings.TrimPrefix(strings.TrimSpace(raw), "+")
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}

func floatToInt(value *float64) *int {
	if value == nil || math.Trunc(*value) != *value {
		return nil
	}
	maxInt := float64(^uint(0) >> 1)
	if *value < -maxInt-1 || *value > maxInt {
		return nil
	}
	integer := int(*value)
	return &integer
}

func firstInt(values ...*int) *int {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstFloat(values ...*float64) *float64 {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func oddsLineEmpty(line model.OddsLine) bool {
	return line.HomeMoneyline == nil && line.DrawMoneyline == nil &&
		line.AwayMoneyline == nil && line.Spread == nil &&
		line.OverUnder == nil && line.OverOdds == nil && line.UnderOdds == nil
}
