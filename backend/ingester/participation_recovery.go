package main

import (
	"context"
	"errors"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const participationBatch = 10
const participationPerCompetition = 2

// retryParticipation runs once per slow cycle, outside the live/current-season
// discovery path. Only durably enrolled captures are candidates, never history.
func (r *runner) retryParticipation(ctx context.Context) error {
	started := r.clock()
	sweepCtx, cancel := context.WithTimeout(ctx, matchRecoveryBudget)
	defer cancel()
	pending, err := r.repo.PendingParticipation(sweepCtx, r.source.Name(), started, participationBatch)
	if err != nil {
		r.recordGlobalRun(ctx, "participation_retry", started, errors.New("bookkeeping_failure"))
		return errors.New("bookkeeping_failure")
	}
	competitions := make(map[string]config.Competition, len(r.competitions))
	for _, comp := range r.competitions {
		competitions[comp.ID] = comp
	}
	perCompetition := make(map[string]int)
	attempts, completed := 0, 0
	var failures []error
	for _, item := range pending[:min(len(pending), participationBatch)] {
		if sweepCtx.Err() != nil {
			failures = append(failures, errors.New("canceled"))
			break
		}
		if perCompetition[item.Identity.CompetitionID] >= participationPerCompetition {
			continue
		}
		perCompetition[item.Identity.CompetitionID]++
		attemptedAt := r.clock()
		claimed, err := r.repo.BeginParticipation(sweepCtx, item.Identity.MatchID, attemptedAt, attemptedAt.Add(matchRecoveryDelay(item.Attempts)))
		if err != nil {
			failures = append(failures, errors.New("bookkeeping_failure"))
			continue
		}
		if !claimed {
			continue
		}
		attempts++
		category := ""
		comp, ok := competitions[item.Identity.CompetitionID]
		season, knownSeason := comp.Seasons[item.Identity.SeasonID]
		if !ok || !knownSeason {
			category = "scope_unavailable"
		} else {
			category = r.recoverParticipation(sweepCtx, comp, season, item, attemptedAt)
		}
		if category == "" {
			completed++
			continue
		}
		// Claim persisted the backoff already. A failed outcome write must not
		// hot-loop on restart; the two-second detached write is diagnostic only.
		recordCtx, cancelRecord := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		recordErr := r.repo.FailParticipation(recordCtx, item.Identity.MatchID, attemptedAt, category)
		cancelRecord()
		failures = append(failures, errors.New(category))
		if recordErr != nil {
			failures = append(failures, errors.New("bookkeeping_failure"))
		}
		r.log.Warn("participation retry", "match", item.Identity.MatchID, "category", category, "attempt", item.Attempts+1)
	}
	r.log.Info("participation retry sweep", "selected", len(pending), "attempted", attempts, "completed", completed, "pending_selected", len(pending)-completed)
	err = errors.Join(failures...)
	r.recordGlobalRun(ctx, "participation_retry", started, err)
	return err
}

func (r *runner) recoverParticipation(ctx context.Context, comp config.Competition, season config.Season, item store.ParticipationRecovery, at time.Time) string {
	lookupCtx, cancel := context.WithTimeout(ctx, matchRecoveryTimeout)
	observed, summary, err := r.source.RecoverMatch(lookupCtx, comp, season, item.Match)
	cancel()
	if err != nil {
		if ctx.Err() != nil {
			return "canceled"
		}
		return "provider_failure"
	}
	if ctx.Err() != nil {
		return "canceled"
	}
	if observed.ID != item.Match.ID || observed.Home.ID != item.Match.Home.ID || observed.Away.ID != item.Match.Away.ID {
		return "identity_conflict"
	}
	if observed.State != model.MatchStateFinished || isTerminalWithoutSummary(observed) {
		return "not_final"
	}
	part := summary.Participation
	if part != nil && (part.HomeTeamSourceID != observed.Home.ID || part.AwayTeamSourceID != observed.Away.ID) {
		return "identity_conflict"
	}
	if err := model.ValidateParticipation(part, observed.HomeScore, observed.AwayScore); err != nil {
		return err.Error()
	}
	if _, err := r.repo.CompleteParticipation(ctx, item.Identity, observed, part, at); err != nil {
		return "write_failure"
	}
	return ""
}
