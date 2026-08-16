// Command play-backfill captures the play stream for finished matches that
// never got one.
//
// ESPN prunes the touch-level tier at the season boundary. Prior seasons are
// already lost at touch level and are deliberately not attempted here. This
// command archives current-season raw bytes first; normalized rows can be
// regenerated from that archive.
//
//	go run ./cmd/play-backfill -comp premier-league -batch 50
//	go run ./cmd/play-backfill -all -batch 50
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

type backfillOptions struct {
	competitionID string
	all           bool
	batch         int
	pause         time.Duration
}

func parseBackfillOptions(args []string) (backfillOptions, error) {
	flags := flag.NewFlagSet("play-backfill", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	compID := flags.String("comp", "", "competition id; omit with -all")
	all := flags.Bool("all", false, "every configured competition")
	batch := flags.Int("batch", 50, "matches per competition per run")
	pause := flags.Duration("pause", 500*time.Millisecond, "delay between matches")
	if err := flags.Parse(args); err != nil {
		return backfillOptions{}, fmt.Errorf("parse flags: %w", err)
	}
	if flags.NArg() != 0 {
		return backfillOptions{}, fmt.Errorf("unexpected positional arguments")
	}
	if (*compID == "") == !*all {
		return backfillOptions{}, fmt.Errorf("choose exactly one of -comp or -all")
	}
	if *batch < 1 {
		return backfillOptions{}, fmt.Errorf("batch must be positive")
	}
	if *pause < 0 {
		return backfillOptions{}, fmt.Errorf("pause must not be negative")
	}
	return backfillOptions{
		competitionID: *compID,
		all:           *all,
		batch:         *batch,
		pause:         *pause,
	}, nil
}

type backfillRepository interface {
	MatchesMissingPlays(
		context.Context,
		string,
		string,
		string,
		int,
	) ([]store.MissingPlayMatch, error)
	RecordPlayArchive(context.Context, uuid.UUID, string, int, int, bool) error
}

type backfillSource interface {
	Name() string
	Plays(
		context.Context,
		config.Competition,
		string,
	) (model.PlayStream, []byte, error)
}

type backfillArchive interface {
	Put(context.Context, string, []byte) (int, error)
}

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	options, err := parseBackfillOptions(args)
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err != nil {
		log.Error("invalid options", "err", err)
		return 1
	}

	dsn := os.Getenv("POOLED_DSN")
	if dsn == "" {
		log.Error("POOLED_DSN is required")
		return 1
	}
	ctx, stop := signal.NotifyContext(
		context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	registry, err := config.Load()
	if err != nil {
		log.Error("load config", "err", err)
		return 1
	}
	repo, err := store.New(ctx, dsn)
	if err != nil {
		log.Error("connect store", "err", err)
		return 1
	}
	defer repo.Close()

	// The PRIVATE raw bucket, via R2_RAW_BUCKET. Unlike the long-running
	// ingester, this command cannot operate usefully without it: archiving is
	// the irreversible half and the whole reason the command exists.
	archive, ok, err := assets.ArchiveFromEnv()
	if err != nil {
		log.Error("configure raw archive", "err", err)
		return 1
	}
	if !ok {
		log.Error("R2_RAW_BUCKET and R2 credentials are required")
		return 1
	}
	provider := source.NewESPN(espn.New())

	competitions := registry.List()
	if !options.all {
		comp, found := registry.Get(options.competitionID)
		if !found {
			log.Error("unknown competition", "comp", options.competitionID)
			return 1
		}
		competitions = []config.Competition{comp}
	}

	failures := backfillPlayStreams(
		ctx,
		log,
		competitions,
		repo,
		provider,
		archive,
		options.batch,
		options.pause,
	)
	if failures > 0 {
		log.Error("backfill finished with failures", "failures", failures)
		return 1
	}
	log.Info("backfill complete")
	return 0
}

func backfillPlayStreams(
	ctx context.Context,
	log *slog.Logger,
	competitions []config.Competition,
	repo backfillRepository,
	provider backfillSource,
	archive backfillArchive,
	batch int,
	pause time.Duration,
) int {
	failures := 0
	for _, comp := range competitions {
		if err := ctx.Err(); err != nil {
			log.Error("backfill canceled", "err", err)
			return failures + 1
		}
		season, found := comp.Seasons[comp.CurrentSeasonId]
		if !found || season.ID == "" {
			log.Error("current season missing from competition config",
				"comp", comp.ID, "season", comp.CurrentSeasonId)
			failures++
			continue
		}
		pending, err := repo.MatchesMissingPlays(
			ctx, comp.ID, season.ID, provider.Name(), batch)
		if err != nil {
			log.Error("list pending", "comp", comp.ID, "err", err)
			failures++
			continue
		}
		log.Info("backfill start",
			"comp", comp.ID, "season", season.ID, "pending", len(pending))
		for index, match := range pending {
			stream, raw, err := provider.Plays(ctx, comp, match.SourceID)
			if err != nil {
				log.Warn("fetch", "match", match.SourceID, "err", err)
				failures++
			} else {
				key := assets.PlayArchiveKey(
					provider.Name(), comp.ID, season.ID, match.SourceID)
				size, archiveErr := archive.Put(ctx, key, raw)
				if archiveErr != nil {
					log.Warn("archive", "match", match.SourceID, "err", archiveErr)
					failures++
				} else if recordErr := repo.RecordPlayArchive(
					ctx,
					match.MatchID,
					key,
					len(stream.Plays),
					size,
					stream.HasTouchTier(),
				); recordErr != nil {
					log.Warn("record", "match", match.SourceID, "err", recordErr)
					failures++
				} else {
					log.Info("backfilled",
						"comp", comp.ID,
						"match", match.SourceID,
						"plays", len(stream.Plays),
						"touchTier", stream.HasTouchTier(),
						"bytes", size,
					)
				}
			}

			if index+1 < len(pending) && pause > 0 {
				timer := time.NewTimer(pause)
				select {
				case <-ctx.Done():
					timer.Stop()
					log.Error("backfill canceled", "err", ctx.Err())
					return failures + 1
				case <-timer.C:
				}
			}
		}
	}
	return failures
}
