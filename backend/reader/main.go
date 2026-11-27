package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/migrations"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/httphealth"
)

func main() {
	checkSchema := flag.Bool("check-schema", false,
		"check the database schema against this binary as the reader login (DATABASE_URL only), print one line, exit 0 only if ready; never listens")
	flag.Parse()
	if *checkSchema {
		os.Exit(checkSchemaOnly(os.Stdout))
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("reader stopped", "err", err)
		os.Exit(1)
	}
}

// checkSchemaOnly is the release_command in fly.toml: Fly runs it from the new
// image before any service machine changes, so a schema this binary would refuse at
// startup aborts the deploy instead of replacing a serving machine. It needs
// only the DSN: PORT configures a listener this mode never opens.
func checkSchemaOnly(out io.Writer) int {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(out, "database schema not checked: DATABASE_URL is required")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err == nil {
		defer pool.Close()
		err = migrations.CheckReady(ctx, pool, freshnessSchemaProbe)
	}
	return migrations.ReportReadiness(ctx, out, err)
}

func run(logger *slog.Logger) error {
	runtimeConfig, err := loadConfig()
	if err != nil {
		return err
	}
	registry, err := config.Load()
	if err != nil {
		return err
	}

	poolConfig, err := pgxpool.ParseConfig(runtimeConfig.DatabaseURL)
	if err != nil {
		return err
	}
	poolConfig.MaxConns = runtimeConfig.DBMaxConns
	poolConfig.MinConns = 1
	poolConfig.MaxConnLifetime = 30 * time.Minute
	poolConfig.MaxConnIdleTime = 5 * time.Minute
	poolConfig.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		return err
	}
	defer pool.Close()
	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelStartup()
	if err := pool.Ping(startupCtx); err != nil {
		return err
	}
	// Schema gate before the listener opens. The *migrations.ReadinessError
	// carries no driver text or DSN, so main may log it as-is.
	if err := migrations.CheckReady(startupCtx, pool, freshnessSchemaProbe); err != nil {
		return err
	}
	processCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	httpLog := httphealth.Logger(logger, "reader")
	store := NewStore(pool)
	var trustedKeyHash []byte
	var limiter, trustedLimiter *ipRateLimiter
	if runtimeConfig.TrustedCallerKey != "" {
		sum := sha256.Sum256([]byte(runtimeConfig.TrustedCallerKey))
		trustedKeyHash = sum[:]
		limiter = newIPRateLimiterWithGlobal(publicRequestsPerSecond, publicBurst, globalAnonymousRPS, globalAnonymousBurst)
		trustedLimiter = newIPRateLimiter(trustedRequestsPerSecond, trustedBurst)
	} else {
		limiter = newIPRateLimiterWithGlobal(clientRequestsPerSecond, clientBurst, globalAnonymousRPS, globalAnonymousBurst)
	}
	app := &App{
		store:                store,
		registry:             registry,
		logger:               logger,
		httpLog:              httpLog,
		news:                 newNewsService(processCtx, espn.NewWithOptions(espn.Options{HTTPLog: httpLog}), defaultNewsTTL),
		limiter:              limiter,
		trustedLimiter:       trustedLimiter,
		trustedKeyHash:       trustedKeyHash,
		requireTrustedSeason: runtimeConfig.RequireTrustedSeasonScope,
		corsOrigins:          runtimeConfig.CORSOrigins,
		inFlight:             make(chan struct{}, runtimeConfig.MaxInFlight),
		health:               newHealthChecker(processCtx, store.Ping),
	}
	server := newHTTPServer(runtimeConfig.Port, app.router())

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("reader listening", "address", server.Addr)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-processCtx.Done():
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return err
		}
		if err := <-serverErrors; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

func newHTTPServer(port string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadTimeout:       10 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

// A zero-row projection of the freshness dependencies, run as the reader role:
// the ledger version alone does not prove this role can read them.
const freshnessSchemaProbe = `
SELECT sync.match_id, sync.source, sync.observed_at,
       poll.competition_id, poll.season_id, poll.source, poll.succeeded_at, poll.outcome,
 obs.competition_id,obs.season_id,obs.source,obs.resource,obs.subject,obs.observed_at,obs.row_count,
 participation.completed_at, player.bio_observed_at, player.flag_url, history.crest_url, season_stats.observed_at, poll.missing_count
FROM match_sync_status sync CROSS JOIN match_poll_status poll
 CROSS JOIN resource_observation obs CROSS JOIN match_participation_availability participation
 CROSS JOIN player CROSS JOIN player_team_history history CROSS JOIN player_season_stat season_stats
WHERE false`
