package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

type matchResult struct {
	live      bool
	active    bool
	finalized bool
}

func (r *runner) processMatches(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	matches []model.Match,
	existing map[string]store.MatchRow,
	slowTick bool,
	backfill bool,
) (matchResult, error) {
	var result matchResult
	var operationErrors []error
	for _, match := range matches {
		if err := ctx.Err(); err != nil {
			operationErrors = append(operationErrors, err)
			break
		}
		current, found := existing[match.ID]
		var currentPtr *store.MatchRow
		if found {
			currentPtr = &current
			r.markExistingCrest(match.Home.ID, current.HomeCrestURL)
			r.markExistingCrest(match.Away.ID, current.AwayCrestURL)
			if current.FinalizedAt.Valid {
				r.mirrorCrest(ctx, match.Home)
				r.mirrorCrest(ctx, match.Away)
				continue
			}
		}

		matchActive := false
		switch match.State {
		case model.MatchStateLive:
			result.live = true
			matchActive = true
		case model.MatchStateScheduled:
			matchActive = true
		case model.MatchStateFinished:
			matchActive = currentPtr == nil || !currentPtr.FinalizedAt.Valid
		}

		if err := r.repo.UpsertTeams(ctx, []model.Team{match.Home, match.Away}); err != nil {
			operationErrors = append(operationErrors, fmt.Errorf("match %s teams: %w", match.ID, err))
			result.active = result.active || matchActive
			continue
		}
		if err := r.repo.UpsertMatch(ctx, comp.ID, season.ID, match); err != nil {
			operationErrors = append(operationErrors, fmt.Errorf("match %s row: %w", match.ID, err))
			result.active = result.active || matchActive
			continue
		}

		if !(backfill && match.State == model.MatchStateScheduled) &&
			needsSummary(match, currentPtr, slowTick) {
			detail, err := r.source.Summary(ctx, comp, match)
			if err != nil {
				operationErrors = append(operationErrors, fmt.Errorf("match %s summary: %w", match.ID, err))
				r.mirrorCrest(ctx, match.Home)
				r.mirrorCrest(ctx, match.Away)
				result.active = result.active || matchActive
				continue
			}
			if match.State == model.MatchStateFinished {
				didFinalize, err := r.repo.FinalizeMatch(ctx, comp.ID, season.ID, match, detail)
				if err != nil {
					operationErrors = append(operationErrors, fmt.Errorf("match %s finalize: %w", match.ID, err))
				} else if didFinalize {
					result.finalized = true
					matchActive = false
					existing[match.ID] = store.MatchRow{
						State: match.State,
						FinalizedAt: pgtype.Timestamptz{
							Time: time.Now(), Valid: true,
						},
						HasDetail: true,
					}
				}
			} else if err := r.repo.UpsertMatchDetail(ctx, match.ID, detail); err != nil &&
				!errors.Is(err, store.ErrMatchFinalized) {
				operationErrors = append(operationErrors, fmt.Errorf("match %s detail: %w", match.ID, err))
			} else {
				current.State = match.State
				current.HasDetail = true
				existing[match.ID] = current
			}
		}
		r.mirrorCrest(ctx, match.Home)
		r.mirrorCrest(ctx, match.Away)
		result.active = result.active || matchActive
	}
	return result, errorsJoin(operationErrors)
}

func (r *runner) mirrorCrest(ctx context.Context, team model.Team) {
	if r.mirror == nil || team.CrestURL == nil || *team.CrestURL == "" {
		return
	}
	if isMirroredURL(*team.CrestURL, r.mirror.BaseURL()) {
		return
	}

	r.mu.Lock()
	if r.mirrored[team.ID] != "" {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()

	cdnURL, err := r.mirror.Mirror(ctx, "teams", team.ID, *team.CrestURL)
	if err != nil {
		r.log.Warn("mirror crest", "team", team.ID, "err", err)
		return
	}
	if err := r.repo.SetTeamCrest(ctx, team.ID, cdnURL); err != nil {
		r.log.Warn("set team crest", "team", team.ID, "err", err)
		return
	}
	r.mu.Lock()
	r.mirrored[team.ID] = cdnURL
	r.mu.Unlock()
}

func (r *runner) markExistingCrest(teamID string, crestURL *string) {
	if r.mirror == nil || crestURL == nil ||
		!isMirroredURL(*crestURL, r.mirror.BaseURL()) {
		return
	}

	r.mu.Lock()
	r.mirrored[teamID] = *crestURL
	r.mu.Unlock()
}

func isMirroredURL(candidate, base string) bool {
	base = strings.TrimRight(base, "/")
	return candidate == base || strings.HasPrefix(candidate, base+"/")
}

func bracketMatch(match model.BracketMatch) model.Match {
	return model.Match{
		ID: match.ID, Kickoff: match.Kickoff, State: match.State,
		Round: match.Round, Minute: match.Minute,
		StatusDetail: match.StatusDetail, StatusName: match.StatusName,
		Home: model.Team{
			ID: match.Home.ID, Name: match.Home.Name,
			Abbr: match.Home.Abbr, CrestURL: match.Home.CrestURL,
		},
		Away: model.Team{
			ID: match.Away.ID, Name: match.Away.Name,
			Abbr: match.Away.Abbr, CrestURL: match.Away.CrestURL,
		},
		HomeScore: match.HomeScore, AwayScore: match.AwayScore,
		WinnerID: match.WinnerID, Note: match.Note,
		HomePlaceholder: match.Home.Placeholder,
		AwayPlaceholder: match.Away.Placeholder,
	}
}

func errorsJoin(errs []error) error {
	return errors.Join(errs...)
}
