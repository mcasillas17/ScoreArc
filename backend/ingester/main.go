// Command ingester polls configured football sources into ScoreArc Postgres.
package main

import (
	"context"
	"flag"
	"fmt"
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
	leaseDSN := os.Getenv("INGESTER_LEASE_DSN")
	if dsn == "" || leaseDSN == "" {
		log.Error("POOLED_DSN and INGESTER_LEASE_DSN are required")
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	registry, err := config.Load()
	if err != nil {
		log.Error("load config", "err", err)
		return 1
	}
	startupCtx, cancelStartup := context.WithTimeout(ctx, 15*time.Second)
	repo, err := store.New(startupCtx, dsn)
	if err != nil {
		cancelStartup()
		if leaseErrorExitCode(ctx, err) == 0 {
			log.Info("shutdown complete")
			return 0
		}
		log.Error("connect store", "err", err)
		return 1
	}
	defer repo.Close()
	lease, acquired, err := store.AcquireIngesterLease(startupCtx, leaseDSN)
	cancelStartup()
	if err != nil {
		if leaseErrorExitCode(ctx, err) == 0 {
			log.Info("shutdown complete")
			return 0
		}
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
		if err := lease.Release(releaseCtx); err != nil {
			log.Error("release ingester lease", "err", err)
		}
	}()

	// Seeding happens INSIDE the lease. It is not read-only setup: it repoints
	// crosswalk rows and promotes provisional teams, moving identities the lease
	// holder is mid-cycle on. A second process — a rolling deploy, a `-once`
	// job, a restart overlapping the old instance — that seeded before taking
	// the lease would do all of that concurrently with the holder's writes,
	// including repointing a ref for a team created after the holder read which
	// teams needed promoting. The lease is what makes ingest single-writer, and
	// seeding is an ingest write.
	if err := applySeeds(ctx, repo, registry); err != nil {
		if leaseErrorExitCode(ctx, err) == 0 {
			log.Info("shutdown complete")
			return 0
		}
		log.Error("seed registries", "err", err)
		return 1
	}

	var mirror crestMirror
	if configured, ok, err := assets.FromEnv(); err != nil {
		log.Error("configure R2 mirror", "err", err)
		return 1
	} else if ok {
		mirror = configured
	} else {
		log.Warn("R2 mirror disabled; incomplete R2 configuration")
	}
	worker := &runner{
		competitions:      registry.List(),
		source:            source.NewESPN(espn.New()),
		repo:              repo,
		mirror:            mirror,
		log:               log,
		maxConcurrent:     3,
		active:            make(map[string]activity),
		mirrored:          make(map[string]string),
		rejectedAssets:    make(map[string]struct{}),
		backfilled:        make(map[string]time.Time),
		backfillAttempted: make(map[string]time.Time),
		squadsRefreshed:   make(map[string]time.Time),
	}

	if *once {
		cycleStarted := time.Now()
		result, err := runLeasedCycleWithTimeout(ctx, lease, worker, true, 0)
		if err != nil {
			if leaseErrorExitCode(ctx, err) == 0 {
				log.Info("shutdown complete")
				return 0
			}
			log.Error("check ingester lease", "err", err)
			return 1
		}
		if code := onceExitCodeForContext(ctx, result); code != 0 {
			log.Error("single cycle failed",
				"live", result.anyLive,
				"failures", result.failures,
				"duration_ms", time.Since(cycleStarted).Milliseconds(),
			)
			return code
		}
		log.Info("single cycle complete",
			"live", result.anyLive,
			"failures", result.failures,
			"duration_ms", time.Since(cycleStarted).Milliseconds(),
		)

		return 0
	}

	lastSlow := time.Time{}
	for {
		if ctx.Err() != nil {
			log.Info("shutdown complete")
			return 0
		}
		if err := checkLease(ctx, lease); err != nil {
			if leaseErrorExitCode(ctx, err) == 0 {
				log.Info("shutdown complete")
				return 0
			}
			log.Error("check ingester lease", "err", err)
			return 1
		}
		slowTick := time.Since(lastSlow) >= slowInterval
		if slowTick {
			lastSlow = time.Now()
		}

		cycleStarted := time.Now()
		result, err := runLeasedCycle(ctx, lease, worker, slowTick)
		if err != nil {
			if leaseErrorExitCode(ctx, err) == 0 {
				log.Info("shutdown complete")
				return 0
			}
			log.Error("ingester lease lost", "err", err)
			return 1
		}
		delay := nextInterval(result.anyLive)
		if elapsed := time.Since(cycleStarted); elapsed < delay {
			delay -= elapsed
		} else {
			delay = 0
		}
		log.Info("cycle complete",
			"live", result.anyLive,
			"failures", result.failures,
			"slow_tick", slowTick,
			"duration_ms", time.Since(cycleStarted).Milliseconds(),
			"sleep_ms", delay.Milliseconds(),
		)

		if !waitForNextCycle(ctx, delay) {
			log.Info("shutdown complete")
			return 0
		}
	}

}

// applySeeds writes the curated registries before any ingest, and returns a
// non-zero exit code if it could not.
//
// Competition seeding is fatal because `match` has a foreign key to `season`:
// with no competitions there is nothing to ingest into. Team seeding is fatal
// for the same class of reason — a seed that could not be applied AT ALL means
// no team registry — but NOT for a single club it could not curate. That one
// keeps resolving through its provisional row, ApplyTeamSeed logs it and
// returns nil, and the site stays up with one club degraded rather than down.
func applySeeds(ctx context.Context, repo *store.Store, registry *config.Registry) error {
	seedCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := repo.ApplyCompetitionSeed(seedCtx, registry.List()); err != nil {
		return fmt.Errorf("apply competition seed: %w", err)
	}
	teams, err := config.LoadTeams()
	if err != nil {
		return fmt.Errorf("load team seed: %w", err)
	}
	if err := repo.ApplyTeamSeed(seedCtx, teams); err != nil {
		return fmt.Errorf("apply team seed: %w", err)
	}
	return nil
}

func onceExitCodeForContext(ctx context.Context, result cycleResult) int {
	if ctx.Err() != nil {
		return 0
	}
	return onceExitCode(result)
}

func leaseErrorExitCode(ctx context.Context, err error) int {
	if err == nil || ctx.Err() != nil {
		return 0
	}
	return 1
}

func waitForNextCycle(ctx context.Context, delay time.Duration) bool {
	if ctx.Err() != nil {
		return false
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func checkLease(ctx context.Context, lease *store.IngesterLease) error {
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return lease.Check(checkCtx)
}

func runLeasedCycle(
	ctx context.Context,
	lease *store.IngesterLease,
	worker *runner,
	slowTick bool,
) (cycleResult, error) {
	return runLeasedCycleWithTimeout(ctx, lease, worker, slowTick, cycleTimeout(slowTick))
}

func runLeasedCycleWithTimeout(
	ctx context.Context,
	lease *store.IngesterLease,
	worker *runner,
	slowTick bool,
	timeout time.Duration,
) (cycleResult, error) {
	if err := checkLease(ctx, lease); err != nil {
		return cycleResult{}, err
	}
	var cycleCtx context.Context
	var cancel context.CancelFunc
	if timeout > 0 {
		cycleCtx, cancel = context.WithTimeout(ctx, timeout)
	} else {
		cycleCtx, cancel = context.WithCancel(ctx)
	}
	defer cancel()
	leaseErr := make(chan error, 1)
	monitorDone := make(chan struct{})
	monitorStop := make(chan struct{})
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-monitorStop:
				return
			case <-ticker.C:
				checkCtx, cancelCheck := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				err := lease.Check(checkCtx)
				cancelCheck()
				if err != nil {
					if cycleCtx.Err() == nil {
						leaseErr <- err
						cancel()
					}
					return
				}
			}
		}
	}()
	result := worker.runCycle(cycleCtx, slowTick)
	close(monitorStop)
	<-monitorDone
	cancel()
	select {
	case err := <-leaseErr:
		return result, err
	default:
		return result, nil
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
