// Command ingester polls configured football sources into ScoreArc Postgres.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/assets"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func main() {
	once := flag.Bool("once", false, "run one complete ingest cycle")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	dsn := os.Getenv("POOLED_DSN")
	if dsn == "" {
		log.Error("POOLED_DSN not set")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	registry, err := config.Load()
	if err != nil {
		log.Error("load config", "err", err)
		os.Exit(1)
	}
	repo, err := store.New(ctx, dsn)
	if err != nil {
		log.Error("connect store", "err", err)
		os.Exit(1)
	}
	defer repo.Close()

	var mirror crestMirror
	if configured, ok := assets.FromEnv(); ok {
		mirror = configured
	} else {
		log.Warn("R2 mirror disabled; incomplete R2 configuration")
	}
	worker := &runner{
		competitions:  registry.List(),
		source:        source.NewESPN(espn.New()),
		repo:          repo,
		mirror:        mirror,
		log:           log,
		maxConcurrent: 3,
		active:        make(map[string]activity),
		mirrored:      make(map[string]bool),
	}

	if *once {
		worker.runCycle(ctx, true)
		log.Info("single cycle complete")
		return
	}

	lastSlow := time.Time{}
	for {
		slowTick := time.Since(lastSlow) >= slowInterval
		if slowTick {
			lastSlow = time.Now()
		}
		anyLive := worker.runCycle(ctx, slowTick)
		delay := nextInterval(anyLive)
		log.Info("cycle complete", "live", anyLive, "slowTick", slowTick, "sleep", delay)

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			log.Info("shutdown complete")
			return
		case <-timer.C:
		}
	}
}
