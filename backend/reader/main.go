package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("reader stopped", "err", err)
		os.Exit(1)
	}
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

	pool, err := pgxpool.New(context.Background(), runtimeConfig.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelStartup()
	if err := pool.Ping(startupCtx); err != nil {
		return err
	}
	if err := checkFreshnessSchema(startupCtx, pool, logger); err != nil {
		return err
	}
	processCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store := NewStore(pool)
	app := &App{
		store:    store,
		registry: registry,
		logger:   logger,
		news:     newNewsServiceWithContext(processCtx, espn.New(), defaultNewsTTL),
		limiter:  newIPRateLimiter(10, 30),
		health:   newHealthChecker(processCtx, store.Ping),
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

// A zero-row projection validates only the new freshness dependencies and their
// reader grants. It is not a general schema audit or an ingester health check.
func checkFreshnessSchema(ctx context.Context, db queryer, logger *slog.Logger) error {
	rows, err := db.Query(ctx, `
SELECT sync.match_id, sync.source, sync.observed_at,
       poll.competition_id, poll.season_id, poll.source, poll.succeeded_at, poll.outcome
FROM match_sync_status sync CROSS JOIN match_poll_status poll
WHERE false`)
	if err == nil {
		rows.Close()
		err = rows.Err()
	}
	if err != nil {
		var pgErr *pgconn.PgError
		sqlstate := ""
		if errors.As(err, &pgErr) {
			sqlstate = pgErr.Code
		}
		logger.Error("freshness schema readiness failed",
			"error_type", fmt.Sprintf("%T", err), "sqlstate", sqlstate)
		// main logs this error too. Never return dependency messages/details or
		// a wrapped connection error that might contain a DSN.
		return errors.New("freshness schema readiness failed")
	}
	return nil
}
