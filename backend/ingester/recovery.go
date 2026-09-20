package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const (
	matchRecoveryBudget  = 30 * time.Second
	matchRecoveryTimeout = 6 * time.Second
)

func matchRecoveryDelay(previousAttempts int) time.Duration {
	return min(store.MatchRecoveryInterval*time.Duration(1<<min(max(previousAttempts, 0), 7)), 6*time.Hour)
}

func (r *runner) recoverOverdueMatches(ctx context.Context, comp config.Competition, season config.Season) (matchResult, map[uuid.UUID]bool, error) {
	ctx, cancel := context.WithTimeout(ctx, matchRecoveryBudget)
	defer cancel()
	processed := make(map[uuid.UUID]bool)
	result := matchResult{failedRecoveryIDs: make(map[uuid.UUID]bool)}
	pending, err := r.repo.PendingMatchRecovery(ctx, comp.ID, season.ID, sourceESPN, r.clock(), store.MatchRecoveryBatchLimit)
	if err != nil {
		result.observationFailed = true
		return result, processed, err
	}
	var failures []error
	for _, item := range pending[:min(len(pending), store.MatchRecoveryBatchLimit)] {
		if err := ctx.Err(); err != nil {
			result.observationFailed = true
			failures = append(failures, err)
			break
		}
		attemptedAt := r.clock()
		if err := r.repo.BeginMatchRecovery(ctx, item.Identity.MatchID, sourceESPN, attemptedAt, attemptedAt.Add(matchRecoveryDelay(item.Attempts))); err != nil {
			result.failedRecoveryIDs[item.Identity.MatchID] = true
			failures = append(failures, fmt.Errorf("claim recovery %s: %w", item.Identity.MatchID, err))
			continue
		}
		matchResult, accepted, recoveryErr := r.recoverOneMatch(ctx, comp, season, item, attemptedAt)
		if accepted {
			processed[item.Identity.MatchID] = true
		}
		result.live = result.live || matchResult.live
		result.active = result.active || matchResult.active
		result.finalized = result.finalized || matchResult.finalized
		if recoveryErr != nil {
			if !accepted {
				result.failedRecoveryIDs[item.Identity.MatchID] = true
			}
			result.live = result.live || item.Match.State == model.MatchStateLive
			result.active = true
		}
		// Even a deadline must leave its attempt outcome durable. This bounded
		// bookkeeping cannot make provider calls or mutate match facts.
		recordCtx, cancelRecord := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		recordErr := r.repo.CompleteMatchRecovery(recordCtx, item.Identity.MatchID, sourceESPN, attemptedAt, accepted)
		cancelRecord()
		if recoveryErr != nil || recordErr != nil {
			failures = append(failures, fmt.Errorf("recover match %s: %w", item.Identity.MatchID, errors.Join(recoveryErr, recordErr)))
		}
	}
	return result, processed, errors.Join(failures...)
}

func (r *runner) recoverOneMatch(ctx context.Context, comp config.Competition, season config.Season, item store.RecoveryMatch, attemptedAt time.Time) (matchResult, bool, error) {
	if item.Match.ID == "" || item.Match.Home.ID == "" || item.Match.Away.ID == "" {
		return matchResult{}, false, fmt.Errorf("missing provider identity crosswalk")
	}
	lookupCtx, cancel := context.WithTimeout(ctx, matchRecoveryTimeout)
	match, summary, err := r.source.RecoverMatch(lookupCtx, comp, season, item.Match)
	cancel()
	if err != nil {
		return matchResult{}, false, err
	}
	if match.ID != item.Match.ID || match.Home.ID != item.Match.Home.ID || match.Away.ID != item.Match.Away.ID {
		return matchResult{}, false, fmt.Errorf("recovery returned mismatched identity")
	}
	existing, err := r.repo.ExistingMatches(ctx, comp.ID, season.ID, []uuid.UUID{item.Identity.MatchID})
	if err != nil {
		return matchResult{}, false, err
	}
	current, ok := existing[item.Identity.MatchID]
	if !ok {
		return matchResult{}, false, store.ErrMatchMissing
	}
	if current.FinalizedAt.Valid {
		return matchResult{}, true, nil
	}
	identity := item.Identity
	identity.WinnerTeamID = canonicalWinner(match, identity.HomeTeamID, identity.AwayTeamID)
	result, err := r.processMatches(ctx, comp, season, []model.Match{match},
		map[string]store.MatchIdentity{match.ID: identity}, existing, true, false,
		map[string]time.Time{match.ID: attemptedAt},
		map[string]source.SummaryResult{match.ID: summary}, true)
	return result, !result.observationFailed, err
}
