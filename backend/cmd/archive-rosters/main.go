// Command archive-rosters imports the verified 2002 men's World Cup team
// directory and available historical squads. The default is a read-only
// provider dry run. --apply commits the validated edition with POOLED_DSN.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/httphealth"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
	"github.com/mcasillas17/scorearc-backend/shared/store"
)

func main() {
	signalCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(signalCtx, 5*time.Minute)
	defer cancel()
	client := espn.NewWithOptions(espn.Options{
		HTTPLog: httphealth.CommandLogger("archive-rosters"),
		HTTP:    &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	})
	if err := run(ctx, os.Args[1:], os.Stdout, source.NewESPN(client).WorldCup2002Archive, applyArchive); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type unavailableSquad struct {
	Team       string `json:"team"`
	ESPNID     string `json:"espnId"`
	HTTPStatus int    `json:"httpStatus"`
}

func run(ctx context.Context, args []string, out io.Writer,
	fetch func(context.Context) ([]model.Standing, map[string]model.Squad, error),
	apply func(context.Context, []model.Standing, map[string]model.Squad) error,
) error {
	flags := flag.NewFlagSet("archive-rosters", flag.ContinueOnError)
	write := flags.Bool("apply", false, "commit the verified world-cup/2002 archive using the least-privilege POOLED_DSN")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments for fixed edition world-cup/2002")
	}
	standings, squads, err := fetch(ctx)
	if err != nil {
		return err
	}
	mode := "dry-run"
	if *write {
		if err := apply(ctx, standings, squads); err != nil {
			return err
		}
		mode = "applied"
	}
	players := 0
	unavailable := []unavailableSquad{}
	for _, standing := range standings {
		if squad, ok := squads[standing.Team.ID]; ok {
			players += len(squad.Players)
		} else {
			unavailable = append(unavailable, unavailableSquad{Team: standing.Team.Name, ESPNID: standing.Team.ID, HTTPStatus: http.StatusNotFound})
		}
	}
	return json.NewEncoder(out).Encode(map[string]any{
		"mode": mode, "competition": "world-cup", "season": "2002",
		"entrants": len(standings), "squads": len(squads), "players": players,
		"unavailable": unavailable,
	})
}

func applyArchive(ctx context.Context, standings []model.Standing, squads map[string]model.Squad) error {
	dsn := os.Getenv("POOLED_DSN")
	if dsn == "" {
		return fmt.Errorf("--apply requires the least-privilege ingester POOLED_DSN")
	}
	repo, err := store.New(ctx, dsn)
	if err != nil {
		return errors.New("could not connect archive writer (check ingester POOLED_DSN and database availability)")
	}
	defer repo.Close()
	if err := repo.CheckSchemaReady(ctx); err != nil {
		return err
	}
	return repo.ApplyWorldCup2002Archive(ctx, standings, squads)
}
