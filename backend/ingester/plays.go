package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const (
	playStreamRunKind     = "play_stream"
	playStreamBacklogKind = "play_stream_backlog"
	playStreamRetryBatch  = 10
)

// capturePlays fetches, archives and stores a finished match's touch-level
// stream.
//
// It is called only after a match transitions to finalized. A live match's
// stream is roughly 1,500 plays over two pages; fetching it every 20 seconds
// would be eighteen requests a minute per live match against a keyless API.
func (r *runner) capturePlays(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
	identity store.MatchIdentity,
	providerEventID string,
) error {
	started := time.Now()
	stream, raw, err := r.source.Plays(ctx, comp, providerEventID)
	if err != nil {
		r.recordRun(ctx, comp.ID, playStreamRunKind, started, err)
		r.log.Warn("fetch play stream", "match", providerEventID, "err", err)
		return err
	}

	// Archive first, to the PRIVATE raw bucket. The bytes are irreplaceable;
	// rows can be rebuilt from them, and they cannot be rebuilt from rows.
	var archiveKey string
	var archiveSize int
	var archived bool
	var archiveErr error
	if r.archive != nil {
		archiveKey = assets.PlayArchiveKey(
			r.source.Name(), comp.ID, season.ID, providerEventID)
		archiveSize, err = r.archive.Put(ctx, archiveKey, raw)
		if err != nil {
			archiveErr = err
			r.log.Warn("archive play stream", "match", providerEventID, "err", err)
		} else {
			archived = true
		}
	} else {
		// Loud, because this is the perishable tier. A silent skip here is a
		// season of touch data quietly not being kept.
		r.log.Warn("no raw archive configured; play stream not kept",
			"match", providerEventID, "plays", len(stream.Plays))
	}

	recordArchive := func() error {
		if !archived {
			return archiveErr
		}
		err := r.repo.RecordPlayArchive(
			ctx,
			identity.MatchID,
			archiveKey,
			len(stream.Plays),
			archiveSize,
			stream.HasTouchTier(),
		)
		if err != nil {
			r.log.Warn("record play archive", "match", providerEventID, "err", err)
		}
		return errors.Join(archiveErr, err)
	}

	// An explicit empty response is still archived and ledgered. That
	// makes the backfill converge instead of selecting the same zero-play match
	// forever.
	if len(stream.Plays) == 0 {
		operationErr := recordArchive()
		r.recordRun(ctx, comp.ID, playStreamRunKind, started, operationErr)
		return operationErr
	}

	analysable := make([]model.Play, 0, len(stream.Plays)/8)
	athleteIDs := make([]string, 0, len(stream.Plays)/8)
	for _, play := range stream.Plays {
		if !espn.Analysable(play) {
			continue
		}
		analysable = append(analysable, play)
		if play.PlayerSourceID != "" {
			athleteIDs = append(athleteIDs, play.PlayerSourceID)
		}
	}
	teamIDs := make(map[string]string, 2)
	if identity.HomeTeamSourceID != "" && identity.HomeTeamID != "" {
		teamIDs[identity.HomeTeamSourceID] = identity.HomeTeamID
	}
	if identity.AwayTeamSourceID != "" && identity.AwayTeamID != "" {
		teamIDs[identity.AwayTeamSourceID] = identity.AwayTeamID
	}

	// One lookup for the whole match. Store.Player would make ~1,500 round
	// trips and mint a nameless person for each athlete the squad omitted.
	playerIDs, err := r.repo.ResolveKnownPlayers(
		ctx, r.source.Name(), athleteIDs)
	if err != nil {
		operationErr := errors.Join(archiveErr, err)
		r.recordRun(ctx, comp.ID, playStreamRunKind, started, operationErr)
		r.log.Warn("resolve play athletes", "match", providerEventID, "err", err)
		return operationErr
	}
	written, err := r.repo.WritePlays(
		ctx, identity.MatchID, analysable, teamIDs, playerIDs)
	if err != nil {
		operationErr := errors.Join(archiveErr, err)
		r.recordRun(ctx, comp.ID, playStreamRunKind, started, operationErr)
		r.log.Warn("write plays", "match", providerEventID, "err", err)
		return operationErr
	}
	// The ledger is the retry-completion marker, so it is written only after
	// both irreversible bytes and rebuildable rows are durable. If row writing
	// fails, the missing ledger keeps this match in the slow-tick backlog.
	operationErr := recordArchive()
	r.recordRun(ctx, comp.ID, playStreamRunKind, started, operationErr)
	r.log.Info("play stream",
		"match", providerEventID,
		"fetched", len(stream.Plays),
		"stored", written,
		"touchTier", stream.HasTouchTier(),
	)
	return operationErr
}

// retryMissingPlayStreams makes finalization and play capture independently
// durable. A match can be finalized even when the core API or R2 is briefly
// unavailable; every slow tick retries the oldest finalized matches that still
// lack the archive-ledger completion marker.
func (r *runner) retryMissingPlayStreams(
	ctx context.Context,
	comp config.Competition,
	season config.Season,
) error {
	if r.archive == nil {
		return nil
	}
	started := time.Now()
	pending, err := r.repo.MatchesMissingPlays(
		ctx,
		comp.ID,
		season.ID,
		r.source.Name(),
		playStreamRetryBatch,
	)
	if err != nil {
		r.recordRun(ctx, comp.ID, playStreamBacklogKind, started, err)
		return err
	}

	var retryErrors []error
	for _, match := range pending {
		if err := ctx.Err(); err != nil {
			retryErrors = append(retryErrors, err)
			break
		}
		identity := store.MatchIdentity{
			MatchID:          match.MatchID,
			CompetitionID:    comp.ID,
			SeasonID:         season.ID,
			HomeTeamID:       match.HomeTeamID,
			AwayTeamID:       match.AwayTeamID,
			HomeTeamSourceID: match.HomeTeamSourceID,
			AwayTeamSourceID: match.AwayTeamSourceID,
			Source:           r.source.Name(),
		}
		if err := r.capturePlays(ctx, comp, season, identity, match.SourceID); err != nil {
			retryErrors = append(retryErrors,
				fmt.Errorf("match %s: %w", match.SourceID, err))
		}
	}
	operationErr := errors.Join(retryErrors...)
	r.recordRun(ctx, comp.ID, playStreamBacklogKind, started, operationErr)
	return operationErr
}
