package main

import (
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const (
	fastInterval   = 20 * time.Second
	slowInterval   = 5 * time.Minute
	topScorerLimit = 30
)

func nextInterval(anyLive bool) time.Duration {
	if anyLive {
		return fastInterval
	}
	return slowInterval
}

func needsSummary(match model.Match, existing *store.MatchRow, slowTick bool) bool {
	if existing != nil && existing.FinalizedAt.Valid {
		return false
	}
	switch match.State {
	case model.MatchStateLive, model.MatchStateFinished:
		return true
	case model.MatchStateScheduled:
		return existing == nil || slowTick
	default:
		return false
	}
}
