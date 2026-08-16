package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

var errMirrorUnavailable = errors.New("asset mirror temporarily unavailable")

// sourceESPN names the provider every id in this process arrives from. It is
// the crosswalk key, so it must match the seed's ref key exactly.
const sourceESPN = "espn"

type matchResult struct {
	live      bool
	active    bool
	finalized bool
}

// resolveMatch turns a provider-shaped match into its canonical identity,
// resolving both teams — creating provisional rows on a miss, so ingestion
// never blocks on curation — and then the match itself, which adopts an
// existing row on the natural key rather than duplicating it.
func (r *runner) resolveMatch(
	ctx context.Context,
	comp config.Competition,
	seasonID string,
	match model.Match,
) (store.MatchIdentity, error) {
	kind := config.TeamKind(comp)
	homeID, err := r.repo.Team(ctx, sourceESPN, store.TeamRef{
		SourceID: match.Home.ID, Name: match.Home.Name, Abbr: match.Home.Abbr, Kind: kind,
	})
	if err != nil {
		return store.MatchIdentity{}, fmt.Errorf("resolve home team: %w", err)
	}
	awayID, err := r.repo.Team(ctx, sourceESPN, store.TeamRef{
		SourceID: match.Away.ID, Name: match.Away.Name, Abbr: match.Away.Abbr, Kind: kind,
	})
	if err != nil {
		return store.MatchIdentity{}, fmt.Errorf("resolve away team: %w", err)
	}
	kickoff, err := time.Parse(time.RFC3339, match.Kickoff)
	if err != nil {
		return store.MatchIdentity{}, fmt.Errorf(
			"match %s has unparseable kickoff %q", match.ID, match.Kickoff)
	}
	matchID, err := r.repo.Match(ctx, sourceESPN, store.MatchRef{
		SourceID: match.ID, CompetitionID: comp.ID, SeasonID: seasonID,
		HomeTeamID: homeID, AwayTeamID: awayID, Kickoff: kickoff,
	})
	if err != nil {
		return store.MatchIdentity{}, fmt.Errorf("resolve match: %w", err)
	}

	return store.MatchIdentity{
		MatchID: matchID, CompetitionID: comp.ID, SeasonID: seasonID,
		HomeTeamID: homeID, AwayTeamID: awayID,
		WinnerTeamID: canonicalWinner(match, homeID, awayID),
		Source:       sourceESPN,
	}, nil
}

// canonicalWinner translates the provider team id in winnerId. Nothing else in
// the payload has to be translated by value like this, and getting it wrong
// mislabels who won without ever raising an error, so it is done by matching
// against the two teams the match actually has. A winner that is neither is not
// a winner: it would fail the foreign key, or worse, point at some other club.
func canonicalWinner(match model.Match, homeID, awayID string) *string {
	if match.WinnerID == nil {
		return nil
	}
	switch *match.WinnerID {
	case match.Home.ID:
		return &homeID
	case match.Away.ID:
		return &awayID
	default:
		return nil
	}
}

func (r *runner) processMatches(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	matches []model.Match,
	identities map[string]store.MatchIdentity,
	existing map[uuid.UUID]store.MatchRow,
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
		identity, resolved := identities[match.ID]
		if !resolved {
			// Its resolution failure was already reported by the caller.
			continue
		}
		providerHome, providerAway := match.Home, match.Away
		// Past this point the match is in CANONICAL space — the same space the
		// stored row is in — so the two can be compared and merged. The summary
		// fetch below is the one thing that still needs provider ids, which is
		// what providerHome/providerAway are held back for.
		match.Home.ID = identity.HomeTeamID
		match.Away.ID = identity.AwayTeamID
		match.WinnerID = identity.WinnerTeamID

		current, found := existing[identity.MatchID]
		skipMatchUpsert := false
		var currentPtr *store.MatchRow
		if found {
			currentPtr = &current
			if match.Note == nil {
				match.Note = current.Note
			}
			if season.HasBracket &&
				current.BracketRequired != nil && *current.BracketRequired &&
				!match.BracketConfirmed {
				match.Round = current.Round
				match.BracketRequired = current.BracketRequired
				match.WinnerID = current.WinnerID
				match.Home = current.Home
				match.Away = current.Away
				match.HomePlaceholder = current.HomePlaceholder
				match.AwayPlaceholder = current.AwayPlaceholder
			} else {
				if !match.BracketConfirmed &&
					current.Round != "" && match.Round == "" {
					match.Round = current.Round
				}
				if !match.BracketConfirmed && current.BracketRequired != nil &&
					(match.BracketRequired == nil || *current.BracketRequired) {
					match.BracketRequired = current.BracketRequired
				}
				if !match.BracketConfirmed && match.WinnerID == nil {
					match.WinnerID = current.WinnerID
				}
			}
			r.markExistingCrest(match.Home.ID, current.Home.ID, current.Home.CrestURL)
			r.markExistingCrest(match.Away.ID, current.Away.ID, current.Away.CrestURL)
			if current.FinalizedAt.Valid {
				r.mirrorCrest(ctx, match.Home)
				r.mirrorCrest(ctx, match.Away)
				continue
			}
			if matchStateRank(current.State) > matchStateRank(match.State) &&
				!isPostponedTransition(current.State, match) {
				match.State = current.State
				skipMatchUpsert = true
			}
		}

		// The preservation rules above can hand the match back its STORED teams
		// and winner, which are canonical too. What gets written follows the
		// match, not the provider payload that started the loop.
		identity.HomeTeamID = match.Home.ID
		identity.AwayTeamID = match.Away.ID
		identity.WinnerTeamID = match.WinnerID

		matchActive := false
		switch match.State {
		case model.MatchStateLive:
			result.live = true
			matchActive = true
		case model.MatchStateScheduled:
			matchActive = candidateIsActive(match, backfill, time.Now())
		case model.MatchStateFinished:
			matchActive = currentPtr == nil || !currentPtr.FinalizedAt.Valid
		}

		if !skipMatchUpsert {
			if err := r.repo.UpsertMatch(ctx, identity, match); err != nil {
				operationErrors = append(operationErrors, fmt.Errorf("match %s row: %w", match.ID, err))
				result.active = result.active || matchActive
				continue
			}
		}
		if skipMatchUpsert {
			r.mirrorCrest(ctx, match.Home)
			r.mirrorCrest(ctx, match.Away)
			result.active = result.active || matchActive
			if current.State == model.MatchStateFinished {
				continue
			}
		}
		canFinalize := !requiresBracketConfirmation(match, season) || match.BracketConfirmed

		if match.State == model.MatchStateFinished && isTerminalWithoutSummary(match) && canFinalize {
			didFinalize, err := r.repo.FinalizeMatch(ctx, identity, match, model.MatchDetail{})
			if err != nil {
				operationErrors = append(operationErrors, fmt.Errorf("match %s finalize terminal status: %w", match.ID, err))
			} else if didFinalize {
				result.finalized = true
				matchActive = false
			}
			r.mirrorCrest(ctx, match.Home)
			r.mirrorCrest(ctx, match.Away)
			result.active = result.active || matchActive
			continue
		}

		if !(backfill && match.State == model.MatchStateScheduled) &&
			(match.State != model.MatchStateFinished || canFinalize) &&
			needsSummary(match, currentPtr, slowTick) {
			summaryMatch := match
			summaryMatch.Home, summaryMatch.Away = providerHome, providerAway
			summary, err := r.source.Summary(ctx, comp, summaryMatch)
			if err != nil {
				operationErrors = append(operationErrors, fmt.Errorf("match %s summary: %w", match.ID, err))
				r.mirrorCrest(ctx, match.Home)
				r.mirrorCrest(ctx, match.Away)
				result.active = result.active || matchActive
				continue
			}

			detail := summary.Detail
			if match.State == model.MatchStateFinished {
				match.HomeScore = summary.HomeScore
				match.AwayScore = summary.AwayScore
			} else if err := r.repo.UpsertMatchDetail(ctx, identity.MatchID, detail); err != nil &&
				!errors.Is(err, store.ErrMatchFinalized) {
				operationErrors = append(operationErrors, fmt.Errorf("match %s detail: %w", match.ID, err))
			} else {
				current.State = match.State
				current.HasDetail = true
				existing[identity.MatchID] = current
			}

			// Player capture is additive: a match's scoreline and detail are
			// already written above. Record the failure, but never let it stop
			// a match from ingesting — the site does not read these tables yet,
			// and a scoreline is worth more than an appearance row.
			if _, err := r.repo.WriteParticipation(ctx, r.source.Name(), identity.MatchID,
				match.Home.ID, match.Away.ID, summary.Participation); err != nil {
				operationErrors = append(operationErrors,
					fmt.Errorf("match %s participation: %w", match.ID, err))
			}

			// Structured commentary is additive to the scoreline row already
			// written above. Empty coverage is a successful repository no-op.
			// A real write failure leaves a finished match unfinalized so the
			// next cycle retries instead of freezing a permanent data gap.
			commentaryWriteSucceeded := true
			if _, err := r.repo.WriteCommentary(ctx, identity.MatchID, summary.Commentary); err != nil {
				commentaryWriteSucceeded = false
				operationErrors = append(operationErrors,
					fmt.Errorf("match %s commentary: %w", match.ID, err))
			}

			if match.State == model.MatchStateFinished && commentaryWriteSucceeded {
				didFinalize, err := r.repo.FinalizeMatch(ctx, identity, match, detail)
				if err != nil {
					operationErrors = append(operationErrors, fmt.Errorf("match %s finalize: %w", match.ID, err))
				} else if didFinalize {
					result.finalized = true
					matchActive = false
					existing[identity.MatchID] = store.MatchRow{
						State: match.State,
						FinalizedAt: pgtype.Timestamptz{
							Time: time.Now(), Valid: true,
						},
						HasDetail: true,
					}
				}
			}
		}
		r.mirrorCrest(ctx, match.Home)
		r.mirrorCrest(ctx, match.Away)
		result.active = result.active || matchActive
	}
	return result, errorsJoin(operationErrors)
}

func isTerminalWithoutSummary(match model.Match) bool {
	switch match.StatusName {
	case "STATUS_CANCELED", "STATUS_ABANDONED", "STATUS_FORFEIT":
		return true
	default:
		return false
	}
}

func isPostponedTransition(current model.MatchState, incoming model.Match) bool {
	return current == model.MatchStateLive &&
		incoming.State == model.MatchStateScheduled &&
		(incoming.StatusName == "STATUS_POSTPONED" ||
			incoming.StatusName == "STATUS_SUSPENDED")
}

func requiresBracketConfirmation(match model.Match, season config.Season) bool {
	if !season.HasBracket {
		return false
	}
	if match.Round != "" {
		return match.BracketRequired == nil || *match.BracketRequired
	}
	if match.BracketRequired != nil {
		return *match.BracketRequired
	}
	if season.BracketDatesRange == nil {
		return true
	}
	parts := strings.SplitN(*season.BracketDatesRange, "-", 2)
	if len(parts) != 2 {
		return true
	}
	start, startErr := time.Parse("20060102", parts[0])
	end, endErr := time.Parse("20060102", parts[1])
	kickoff, kickoffErr := time.Parse(time.RFC3339, match.Kickoff)
	if startErr != nil || endErr != nil || kickoffErr != nil {
		return true
	}
	kickoff = kickoff.UTC()
	return !kickoff.Before(start) && !kickoff.After(end.Add(24*time.Hour-time.Nanosecond))
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

	cdnURL, err := r.mirrorAsset(ctx, "teams", team.ID, *team.CrestURL)
	if errors.Is(err, errMirrorUnavailable) {
		return
	}
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

func (r *runner) mirrorAsset(
	ctx context.Context,
	kind, id, sourceURL string,
) (string, error) {
	cacheKey := assetCacheKey(kind, id, sourceURL)
	r.mu.Lock()
	if _, rejected := r.rejectedAssets[cacheKey]; rejected {
		r.mu.Unlock()
		return "", assets.ErrAssetRejected
	}
	if time.Now().Before(r.mirrorUnavailable) {
		r.mu.Unlock()
		return "", errMirrorUnavailable
	}
	r.mu.Unlock()

	timeout := r.mirrorTimeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	mirrorCtx, cancel := context.WithTimeout(ctx, timeout)
	cdnURL, err := r.mirror.Mirror(mirrorCtx, kind, id, sourceURL)
	cancel()
	if err != nil {
		if errors.Is(err, assets.ErrAssetRejected) {
			r.mu.Lock()
			if r.rejectedAssets == nil {
				r.rejectedAssets = make(map[string]struct{})
			}
			r.rejectedAssets[cacheKey] = struct{}{}
			r.mu.Unlock()
			return "", err
		}
		if ctx.Err() == nil {
			r.mu.Lock()
			r.mirrorUnavailable = time.Now().Add(time.Minute)
			r.mu.Unlock()
		}
		return "", err
	}
	r.mu.Lock()
	r.mirrorUnavailable = time.Time{}
	r.mu.Unlock()
	return cdnURL, nil
}

func (r *runner) markExistingCrest(incomingTeamID, storedTeamID string, crestURL *string) {
	if incomingTeamID != storedTeamID || r.mirror == nil || crestURL == nil ||
		!isMirroredURL(*crestURL, r.mirror.BaseURL()) {
		return
	}

	r.mu.Lock()
	r.mirrored[incomingTeamID] = *crestURL
	r.mu.Unlock()
}

func isMirroredURL(candidate, base string) bool {
	base = strings.TrimRight(base, "/")
	return candidate == base || strings.HasPrefix(candidate, base+"/")
}

func bracketMatch(match model.BracketMatch) model.Match {
	bracketRequired := true
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
		HomePlaceholder:  match.Home.Placeholder,
		AwayPlaceholder:  match.Away.Placeholder,
		BracketRequired:  &bracketRequired,
		BracketConfirmed: true,
	}
}

func errorsJoin(errs []error) error {
	return errors.Join(errs...)
}
