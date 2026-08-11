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
	os.Exit(run())
}

func run() int {
	once := flag.Bool("once", false, "run one complete ingest cycle")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	dsn := os.Getenv("POOLED_DSN")
	if dsn == "" {
		log.Error("POOLED_DSN not set")
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
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
	releaseLease, acquired, err := repo.AcquireIngesterLease(ctx)
	if err != nil {
		log.Error("acquire ingester lease", "err", err)
		return 1
	}
	if !acquired {
		log.Error("another ingester instance holds the database lease")
		return 1
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := releaseLease(releaseCtx); err != nil {
			log.Error("release ingester lease", "err", err)
		}
	}()

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
		mirrored:      make(map[string]string),
		backfilled:    make(map[string]bool),
	}

	if *once {
		cycleCtx, cancel := context.WithTimeout(ctx, cycleTimeout(true))
		result := worker.runCycle(cycleCtx, true)
		cancel()
		if code := onceExitCode(result); code != 0 {
			log.Error("single cycle failed", "failures", result.failures)
			return code
		}

		log.Info("single cycle complete")
		return 0
	}

	lastSlow := time.Time{}
	for {
		slowTick := time.Since(lastSlow) >= slowInterval
		if slowTick {
			lastSlow = time.Now()
		}
		cycleStarted := time.Now()
		cycleCtx, cancel := context.WithTimeout(ctx, cycleTimeout(slowTick))
		result := worker.runCycle(cycleCtx, slowTick)
		cancel()
		delay := nextInterval(result.anyLive)
		if elapsed := time.Since(cycleStarted); elapsed < delay {
			delay -= elapsed
		} else {
			delay = 0
		}
		log.Info("cycle complete", "live", result.anyLive, "failures", result.failures, "slowTick", slowTick, "sleep", delay)

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			log.Info("shutdown complete")
			return 0
		case <-timer.C:
		}
	}

}

func onceExitCode(result cycleResult) int {
	if result.failures > 0 {
		return 1
	}
	return 0
}

func cycleTimeout(slowTick bool) time.Duration {
	if slowTick {
		return 4*time.Minute + 30*time.Second
	}
	return 18 * time.Second
}
