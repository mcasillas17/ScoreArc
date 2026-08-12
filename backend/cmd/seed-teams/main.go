// Command seed-teams proposes backend/config/teams.seed.json from live ESPN.
// It is a ONE-TIME bootstrap plus an occasional top-up: it prints JSON to
// stdout for a human to review and commit. It never writes the file itself,
// because the seed is the curated identity spine and must not change without
// review.
//
// It MERGES rather than replaces: any ESPN id the seed already carries is
// emitted with its curated identity intact, and only genuinely new teams get a
// machine-derived slug. Without that, a regenerate would silently revert every
// hand-made correction, because the competition a team is first seen in decides
// its proposed namespace and the multi-country Leagues Cup is iterated before
// the domestic leagues.
//
// The merge base is the embedded seed, so redirecting stdout straight onto it
// destroys that base before this command is compiled. Regenerate with:
//
//	go run ./cmd/seed-teams > /tmp/teams.seed.json && mv /tmp/teams.seed.json config/teams.seed.json
//
// A run that finds no usable merge base fails rather than proposing everything;
// -bootstrap opts into propose-everything for the genuine first run.
package main

import (
	"context"
	"encoding/json"
	"flag"
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

const sourceName = "espn"

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Letters that carry no combining mark to strip, so NFD leaves them intact and
// they would otherwise be flattened into a separator ("Bodø" -> "bod-"). These
// are the stroke/bar/ligature class, which Unicode encodes atomically.
var undecomposable = strings.NewReplacer(
	"ø", "o", "Ø", "O",
	"đ", "d", "Đ", "D",
	"ð", "d", "Ð", "D",
	"ł", "l", "Ł", "L",
	"ı", "i", "İ", "I",
	"ħ", "h", "Ħ", "H",
	"ŋ", "n", "Ŋ", "N",
	"ŧ", "t", "Ŧ", "T",
	"ə", "e", "Ə", "E",
	"þ", "th", "Þ", "Th",
	"ß", "ss",
	"æ", "ae", "Æ", "Ae",
	"œ", "oe", "Œ", "Oe",
)

// deaccent folds Latin diacritics to ASCII so "América" slugs as "america"
// rather than "am-rica": decompose, drop the combining marks, recompose.
var deaccent = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)

// slugify renders a display name as a url-safe slug: "Manchester United" ->
// "manchester-united", "Querétaro" -> "queretaro". A name with no Latin
// content at all ("Зенит") slugs to "", which callers must handle.
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

// provisionalSlug is the reserved id shape for a team that cannot be named
// canonically, matching the provisional rows the resolver mints at runtime.
func provisionalSlug(sourceID string) string { return "prov-" + sourceName + "-" + sourceID }

// isProvisional reports whether a slug is the fallback shape rather than a
// real canonical id, so the caller can flag it for review.
func isProvisional(slug string) bool { return strings.HasPrefix(slug, "prov-"+sourceName+"-") }

// deriveSlug proposes an id for a team the seed does not yet carry. A name (or
// abbreviation) with no Latin content slugs to nothing, which would otherwise
// yield a meaningless bare-prefix id like "ger-"; those fall back to the
// provisional shape so a human is forced to name them.
func deriveSlug(prefix, kind string, team model.Team) string {
	if kind == "national" {
		if abbr := slugify(team.Abbr); abbr != "" {
			return "nat-" + abbr
		}
		return provisionalSlug(team.ID)
	}
	if body := slugify(team.Name); body != "" {
		return prefix + "-" + body
	}
	return provisionalSlug(team.ID)
}

// proposeTeam returns the seed row for one ESPN team. When the curated seed
// already carries this source id, that row wins: its id, country and kind are
// human decisions and are never re-derived. Only the provider-owned display
// fields are refreshed from ESPN.
func proposeTeam(curated map[string]config.SeedTeam, prefix, kind string, team model.Team) config.SeedTeam {
	if row, found := curated[team.ID]; found {
		row.Name = team.Name
		row.Abbr = team.Abbr
		if team.CrestURL != nil {
			row.CrestURL = team.CrestURL
		}
		return row
	}
	return config.SeedTeam{
		ID:        deriveSlug(prefix, kind, team),
		Kind:      kind,
		Name:      team.Name,
		ShortName: team.Name,
		Abbr:      team.Abbr,
		Country:   prefix,
		CrestURL:  team.CrestURL,
		Refs:      map[string]string{sourceName: team.ID},
	}
}

// safeRegenerate is the invocation that does not destroy its own merge base.
const safeRegenerate = "go run ./cmd/seed-teams > /tmp/teams.seed.json && " +
	"mv /tmp/teams.seed.json config/teams.seed.json"

// mergeBase indexes the committed seed by its ESPN id so curated rows can be
// preserved. An unusable seed is refused rather than quietly ignored: the seed
// is embedded, so `> config/teams.seed.json` truncates it before this command
// is even compiled, and proposing everything at that point would revert every
// curated slug and country in the file being written. Genuine bootstrap — the
// first ever run, when there is nothing to preserve — says so explicitly.
func mergeBase(seed []config.SeedTeam, loadErr error, bootstrap bool) (map[string]config.SeedTeam, error) {
	byID := make(map[string]config.SeedTeam, len(seed))
	for _, team := range seed {
		if sourceID := team.Refs[sourceName]; sourceID != "" {
			byID[sourceID] = team
		}
	}
	if loadErr == nil && len(byID) > 0 {
		return byID, nil
	}
	if bootstrap {
		fmt.Fprintln(os.Stderr, "warn: -bootstrap set, proposing every team from scratch")
		return map[string]config.SeedTeam{}, nil
	}
	reason := "it carries no espn refs"
	if loadErr != nil {
		reason = loadErr.Error()
	}
	return nil, fmt.Errorf(
		"cannot use teams.seed.json as the merge base (%s), so a run now would "+
			"re-derive every slug and country and revert curation.\n"+
			"  If you redirected stdout onto the seed, the shell truncated it before this\n"+
			"  command compiled. Regenerate via a temp file instead:\n    %s\n"+
			"  Pass -bootstrap only if you really mean to propose every team from scratch",
		reason, safeRegenerate)
}

func main() {
	bootstrap := flag.Bool("bootstrap", false,
		"propose every team from scratch instead of merging with the committed seed")
	flag.Parse()
	if err := run(*bootstrap); err != nil {
		fmt.Fprintln(os.Stderr, "seed-teams:", err)
		os.Exit(1)
	}
}

func run(bootstrap bool) error {
	registry, err := config.Load()
	if err != nil {
		return err
	}
	seed, loadErr := config.LoadTeams()
	curated, err := mergeBase(seed, loadErr, bootstrap)
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
			// The loader requires an abbreviation, so emitting a team without
			// one would produce a seed the command's own validation rejects.
			if strings.TrimSpace(team.Abbr) == "" {
				fmt.Fprintf(os.Stderr,
					"warn: skipping espn:%s (%q) — no abbreviation\n", team.ID, team.Name)
				continue
			}
			if _, exists := seen[team.ID]; exists {
				continue
			}
			row := proposeTeam(curated, prefix, kind, team)
			if isProvisional(row.ID) {
				fmt.Fprintf(os.Stderr,
					"warn: espn:%s (%q) has no slug-able name — emitted as %q, name it by hand\n",
					team.ID, team.Name, row.ID)
			}
			seen[team.ID] = row
		}
	}

	out := make([]config.SeedTeam, 0, len(seen))
	for _, team := range seen {
		out = append(out, team)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })

	// Slug collisions must be resolved by a human, not silently renamed — and
	// not written over the seed either, so this fails instead of printing.
	slugs := make(map[string]string, len(out))
	collisions := 0
	for _, team := range out {
		if existing, dup := slugs[team.ID]; dup {
			collisions++
			fmt.Fprintf(os.Stderr,
				"COLLISION: slug %q proposed for espn:%s and espn:%s — disambiguate by hand\n",
				team.ID, existing, team.Refs[sourceName])
		}
		slugs[team.ID] = team.Refs[sourceName]
	}
	if collisions > 0 {
		return fmt.Errorf("%d slug collision(s); refusing to emit a seed", collisions)
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	// The seed is read by humans; "Brighton & Hove Albion" should not be
	// escaped into & just because the default encoder assumes HTML.
	encoder.SetEscapeHTML(false)
	return encoder.Encode(out)
}
