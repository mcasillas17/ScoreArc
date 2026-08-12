// Command seed-teams proposes backend/config/teams.seed.json from live ESPN.
// It is a ONE-TIME bootstrap plus an occasional top-up: it prints JSON to
// stdout for a human to review and commit. It never writes the file itself,
// because the seed is the curated identity spine and must not change without
// review.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"

	"github.com/mcasillas17/scorearc-backend/config"
	"github.com/mcasillas17/scorearc-backend/shared/espn"
	"github.com/mcasillas17/scorearc-backend/shared/model"
	"github.com/mcasillas17/scorearc-backend/shared/source"
)

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Letters that carry no combining mark to strip, so NFD leaves them intact and
// they would otherwise be flattened into a separator ("Bodø" -> "bod-").
var undecomposable = strings.NewReplacer(
	"ø", "o", "Ø", "O",
	"đ", "d", "Đ", "D",
	"ð", "d", "Ð", "D",
	"ł", "l", "Ł", "L",
	"ı", "i", "İ", "I",
	"þ", "th", "Þ", "Th",
	"ß", "ss",
	"æ", "ae", "Æ", "Ae",
	"œ", "oe", "Œ", "Oe",
)

// deaccent folds Latin diacritics to ASCII so "América" slugs as "america"
// rather than "am-rica": decompose, drop the combining marks, recompose.
var deaccent = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)

// slugify renders a display name as a url-safe slug: "Manchester United" ->
// "manchester-united", "Querétaro" -> "queretaro".
func slugify(name string) string {
	folded, _, err := transform.String(deaccent, undecomposable.Replace(name))
	if err != nil {
		folded = name
	}
	lowered := strings.ToLower(strings.TrimSpace(folded))
	return strings.Trim(nonSlug.ReplaceAllString(lowered, "-"), "-")
}

// countryPrefix derives a namespace from the ESPN competition slug, so two
// clubs with the same name in different countries cannot collide:
// "eng.1" -> "eng", "concacaf.leagues.cup" -> "concacaf".
func countryPrefix(espnSlug string) string {
	parts := strings.Split(espnSlug, ".")
	if len(parts) == 0 || parts[0] == "" {
		return "x"
	}
	return parts[0]
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "seed-teams:", err)
		os.Exit(1)
	}
}

func run() error {
	registry, err := config.Load()
	if err != nil {
		return err
	}
	src := source.NewESPN(espn.New())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Keyed by ESPN team id so a club appearing in two competitions (e.g. a
	// Liga MX side also in Leagues Cup) is collected exactly once.
	seen := map[string]config.SeedTeam{}

	for _, comp := range registry.List() {
		season, ok := comp.Seasons[comp.CurrentSeasonId]
		if !ok {
			continue
		}
		kind := "club"
		if comp.ESPNSlug == "fifa.world" {
			kind = "national"
		}
		prefix := countryPrefix(comp.ESPNSlug)

		var teams []model.Team
		matches, err := src.Scoreboard(ctx, comp, season, true)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warn: scoreboard %s: %v\n", comp.ID, err)
		}
		for _, match := range matches {
			teams = append(teams, match.Home, match.Away)
		}
		standings, err := src.Standings(ctx, comp, season)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warn: standings %s: %v\n", comp.ID, err)
		}
		for _, standing := range standings {
			teams = append(teams, standing.Team)
		}

		for _, team := range teams {
			if team.ID == "" || team.Name == "" {
				continue
			}
			if _, exists := seen[team.ID]; exists {
				continue
			}
			slug := prefix + "-" + slugify(team.Name)
			if kind == "national" {
				slug = "nat-" + strings.ToLower(team.Abbr)
			}
			seen[team.ID] = config.SeedTeam{
				ID:        slug,
				Kind:      kind,
				Name:      team.Name,
				ShortName: team.Name,
				Abbr:      team.Abbr,
				Country:   prefix,
				Refs:      map[string]string{"espn": team.ID},
			}
		}
	}

	out := make([]config.SeedTeam, 0, len(seen))
	for _, team := range seen {
		out = append(out, team)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })

	// Slug collisions must be resolved by a human, not silently renamed.
	slugs := map[string]string{}
	for _, team := range out {
		if existing, dup := slugs[team.ID]; dup {
			fmt.Fprintf(os.Stderr,
				"COLLISION: slug %q proposed for espn:%s and espn:%s — disambiguate by hand\n",
				team.ID, existing, team.Refs["espn"])
		}
		slugs[team.ID] = team.Refs["espn"]
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(out)
}
