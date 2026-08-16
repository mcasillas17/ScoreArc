package main

import (
	"context"
	"errors"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

const playStreamRunKind = "play_stream"

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
) {
	started := time.Now()
	stream, raw, err := r.source.Plays(ctx, comp, providerEventID)
	if err != nil {
		r.recordRun(ctx, comp.ID, playStreamRunKind, started, err)
		r.log.Warn("fetch play stream", "match", providerEventID, "err", err)
		return
	}

	// Archive first, to the PRIVATE raw bucket. The bytes are irreplaceable;
	// rows can be rebuilt from them, and they cannot be rebuilt from rows.
	var archiveErr error
	if r.archive != nil {
		key := assets.PlayArchiveKey(
			r.source.Name(), comp.ID, season.ID, providerEventID)
		size, err := r.archive.Put(ctx, key, raw)
		if err != nil {
			archiveErr = err
			r.log.Warn("archive play stream", "match", providerEventID, "err", err)
		} else if err := r.repo.RecordPlayArchive(
			ctx,
			identity.MatchID,
			key,
			len(stream.Plays),
			size,
			stream.HasTouchTier(),
		); err != nil {
			archiveErr = err
			r.log.Warn("record play archive", "match", providerEventID, "err", err)
		}
	} else {
		// Loud, because this is the perishable tier. A silent skip here is a
		// season of touch data quietly not being kept.
		r.log.Warn("no raw archive configured; play stream not kept",
			"match", providerEventID, "plays", len(stream.Plays))
	}

	// An explicit empty response is still archived and ledgered above. That
	// makes the backfill converge instead of selecting the same zero-play match
	// forever.
	if len(stream.Plays) == 0 {
		r.recordRun(ctx, comp.ID, playStreamRunKind, started, archiveErr)
		return
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
		return
	}
	written, err := r.repo.WritePlays(
		ctx, identity.MatchID, analysable, teamIDs, playerIDs)
	operationErr := errors.Join(archiveErr, err)
	r.recordRun(ctx, comp.ID, playStreamRunKind, started, operationErr)
	if err != nil {
		r.log.Warn("write plays", "match", providerEventID, "err", err)
		return
	}
	r.log.Info("play stream",
		"match", providerEventID,
		"fetched", len(stream.Plays),
		"stored", written,
		"touchTier", stream.HasTouchTier(),
	)
}
