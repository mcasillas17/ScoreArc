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
	}

	if *once {
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
			log.Error("single cycle failed", "failures", result.failures)
			return code
		}

		log.Info("single cycle complete")
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
		log.Info("cycle complete", "live", result.anyLive, "failures", result.failures, "slowTick", slowTick, "sleep", delay)

		if !waitForNextCycle(ctx, delay) {
			log.Info("shutdown complete")
			return 0
		}
	}

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
