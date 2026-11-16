// Command seed-teams proposes backend/config/teams.seed.json from live ESPN.
// It is a ONE-TIME bootstrap plus an occasional top-up: it prints JSON to
// stdout for a human to review and commit. It never writes the file itself,
// because the seed is the curated identity spine and must not change without
// review.
//
// It MERGES rather than replaces, in both directions. Any ESPN id the seed
// already carries is emitted with its curated identity intact, and only
// genuinely new teams get a machine-derived slug — without that, a regenerate
// would silently revert every hand-made correction, because the competition a
// team is first seen in decides its proposed namespace and the multi-country
// Leagues Cup is iterated before the domestic leagues. And the output starts
// from the whole committed seed rather than from what this run happened to
// fetch, so a team is never DELETED just because ESPN did not mention it: one
// transient 500 on a competition would otherwise drop every club that only
// appears there.
//
// A competition whose scoreboard AND standings both failed makes the run
// non-authoritative, so it refuses to emit a seed at all rather than emit one
// that is merely stale in a place nobody can see.
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
	"io"
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

// A cup can cross borders. For a new cup entrant the domestic observation or
// a reviewed provider ref supplies the country; the federation slug cannot.
func proposalCountry(comp config.Competition, team model.Team) string {
	if comp.Kind == "national" {
		return slugify(team.Abbr)
	}
	// These domestic leagues admit teams from more than one country.
	switch comp.ESPNSlug {
	case "usa.1", "aus.w.1", "eng.1", "fra.1":
		return ""
	}
	if comp.DirectoryGroup == "domestic" || comp.DirectoryGroup == "college" {
		country, _, _ := strings.Cut(comp.ESPNSlug, ".")
		return country
	}
	return ""
}

// provisionalSlug is the reserved id shape for a team that cannot be named
// canonically, matching the provisional rows the resolver mints at runtime.
func provisionalSlug(sourceID string) string { return "prov-" + sourceName + "-" + sourceID }

// isProvisional reports whether a slug is the fallback shape rather than a
// real canonical id, so the caller can flag it for review.
func isProvisional(slug string) bool { return strings.HasPrefix(slug, "prov-"+sourceName+"-") }

// deriveSlug keeps senior URLs stable and separates same-name youth and college sides.
func deriveSlug(comp config.Competition, country string, team model.Team) string {
	prefix, body := country, slugify(team.Name)
	if comp.Kind == "national" {
		prefix, body = "nat", country
	}
	if country == "" || body == "" {
		return provisionalSlug(team.ID)
	}
	if comp.Category == "women" {
		prefix += "-w"
	}
	if comp.Level != "senior" {
		prefix += "-" + comp.Level
	}
	return prefix + "-" + body
}

// proposeTeam returns the seed row for one ESPN team. When the curated seed
// already carries this source id, that row wins: its id, country and kind are
// human decisions and are never re-derived. Only the provider-owned display
// fields are refreshed from ESPN.
//
// Neither shortName nor crestUrl is proposed. A short name that merely repeats
// the name says nothing, and the crest is mirrored to our own CDN at runtime —
// emitting the provider hotlink here only put 194 URLs in front of every human
// reading a diff of the seed. A hand-set value of either is preserved, because
// the curated row is returned whole.
func proposeTeam(curated map[string]config.SeedTeam, comp config.Competition, team model.Team) config.SeedTeam {
	if row, found := curated[team.ID]; found {
		row.Name = team.Name
		row.Abbr = team.Abbr
		return row
	}
	country := proposalCountry(comp, team)
	return config.SeedTeam{
		ID:      deriveSlug(comp, country, team),
		Kind:    comp.Kind,
		Name:    team.Name,
		Abbr:    team.Abbr,
		Country: country,
		Refs:    map[string]string{sourceName: team.ID},
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

// competitionFetch is one competition's contribution to a regenerate: the teams
// ESPN named, and whether each of the two fetches that could name them worked.
type competitionFetch struct {
	comp                 config.Competition
	teams                []model.Team
	scoreboardErr        error
	standingsErr         error
	standingsUnsupported bool
}

// blind reports that this competition told us nothing at all. One failed fetch
// is survivable — a club in a league's standings is normally in its scoreboard
// too — but both failing means the run has no idea what is in the competition.
func (f competitionFetch) blind() bool {
	return f.scoreboardErr != nil && (f.standingsErr != nil || f.standingsUnsupported)
}

// buildSeed produces the proposed seed by OVERLAYING what was fetched onto the
// committed seed, never by rebuilding from the fetch alone. That ordering is
// the safety property the command's doc comment promises: a competition ESPN
// failed to serve leaves its clubs exactly as they were rather than deleting
// them. A single transient 500 on esp.1 used to emit a perfectly valid seed
// with ~20 curated clubs missing, at exit 0, and the `len(seed) >= 150` guard
// waved it through.
func buildSeed(
	curated map[string]config.SeedTeam,
	fetches []competitionFetch,
	warn io.Writer,
) ([]config.SeedTeam, error) {
	// Keyed by ESPN team id, starting from every curated row so nothing this
	// run did not happen to see can fall out.
	rows := make(map[string]config.SeedTeam, len(curated))
	for sourceID, team := range curated {
		rows[sourceID] = team
	}
	// A club appearing in two competitions (a Liga MX side also in Leagues Cup)
	// is proposed once. A domestic proposal can supply the country a cup lacks.
	proposed := make(map[string]struct{}, len(curated))
	uncuratedScopes := make(map[string]config.Competition)

	var blind []string
	for _, fetch := range fetches {
		if fetch.blind() {
			blind = append(blind, fetch.comp.ID+"/"+fetch.comp.CurrentSeasonId)
		}
		for _, team := range fetch.teams {
			if team.ID == "" || espn.IsBracketPlaceholder(team.Name, team.CrestURL) {
				continue
			}
			if _, known := curated[team.ID]; !known {
				c := fetch.comp
				if prior, seen := uncuratedScopes[team.ID]; seen && (prior.Kind != c.Kind || prior.Category != c.Category || prior.Level != c.Level) {
					return nil, fmt.Errorf("espn:%s appears in incompatible competitions %s and %s; review its identity", team.ID, prior.ID, c.ID)
				}
				uncuratedScopes[team.ID] = c
			}
			if team.Name == "" {
				continue
			}
			// The loader requires an abbreviation, so emitting a team without
			// one would produce a seed the command's own validation rejects.
			if strings.TrimSpace(team.Abbr) == "" {
				fmt.Fprintf(warn,
					"warn: skipping espn:%s (%q) — no abbreviation\n", team.ID, team.Name)
				continue
			}
			row := proposeTeam(curated, fetch.comp, team)
			if _, exists := proposed[team.ID]; exists && !isProvisional(rows[team.ID].ID) {
				previous := rows[team.ID]
				if !isProvisional(row.ID) && previous.ID != row.ID {
					return nil, fmt.Errorf("espn:%s has conflicting proposals %q and %q; review its identity", team.ID, previous.ID, row.ID)
				}
				continue
			}
			proposed[team.ID] = struct{}{}
			rows[team.ID] = row
		}
	}

	out := make([]config.SeedTeam, 0, len(rows))
	for _, team := range rows {
		out = append(out, team)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })

	// Slug collisions must be resolved by a human, not silently renamed — and
	// not written over the seed either, so this fails instead of printing.
	slugs := make(map[string]string, len(out))
	collisions := 0
	for _, team := range out {
		if isProvisional(team.ID) {
			return nil, fmt.Errorf("espn:%s (%q) needs a reviewed country and canonical slug; refusing to seed provisional ID %q",
				team.Refs[sourceName], team.Name, team.ID)
		}
		if existing, dup := slugs[team.ID]; dup {
			collisions++
			fmt.Fprintf(warn,
				"COLLISION: slug %q proposed for espn:%s and espn:%s — disambiguate by hand\n",
				team.ID, existing, team.Refs[sourceName])
		}
		slugs[team.ID] = team.Refs[sourceName]
	}
	if collisions > 0 {
		return nil, fmt.Errorf("%d slug collision(s); refusing to emit a seed", collisions)
	}
	// A blind competition can no longer delete anything, but it does mean this
	// run cannot see new or renamed clubs there. Emitting anyway would present a
	// partial regenerate as a complete one, so it exits non-zero instead.
	if len(blind) > 0 {
		return nil, fmt.Errorf(
			"neither scoreboard nor standings could be fetched for %s; refusing to "+
				"emit a seed that cannot see those competitions — rerun when the "+
				"provider is healthy", strings.Join(blind, ", "))
	}
	return out, nil
}

func seedEditions(registry *config.Registry, edition string) ([]config.Competition, error) {
	eligible := registry.Active("scores")
	if edition == "" {
		return eligible, nil
	}
	for _, comp := range eligible {
		if comp.ID+"/"+comp.CurrentSeasonId == edition {
			return []config.Competition{comp}, nil
		}
	}
	return nil, fmt.Errorf("edition %q is not eligible for score collection", edition)
}

func main() {
	bootstrap := flag.Bool("bootstrap", false,
		"propose every team from scratch instead of merging with the committed seed")
	edition := flag.String("edition", "", "limit proposals to one eligible competition/season (staging requires SCOREARC_STAGING_EDITIONS)")
	flag.Parse()
	if err := run(*bootstrap, *edition); err != nil {
		fmt.Fprintln(os.Stderr, "seed-teams:", err)
		os.Exit(1)
	}
}

func run(bootstrap bool, edition string) error {
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

	editions, err := seedEditions(registry, edition)
	if err != nil {
		return err
	}
	fetches := make([]competitionFetch, 0, len(editions))
	for _, comp := range editions {
		season, ok := comp.Seasons[comp.CurrentSeasonId]
		if !ok {
			continue
		}
		fetch := competitionFetch{
			comp:                 comp,
			standingsUnsupported: !season.Supports("standings"),
		}
		matches, err := src.Scoreboard(ctx, comp, season, true)
		if err != nil {
			fetch.scoreboardErr = err
			fmt.Fprintf(os.Stderr, "warn: scoreboard %s: %v\n", comp.ID, err)
		}
		for _, match := range matches {
			fetch.teams = append(fetch.teams, match.Home, match.Away)
		}
		if season.Supports("standings") {
			standings, err := src.Standings(ctx, comp, season)
			if err != nil {
				fetch.standingsErr = err
				fmt.Fprintf(os.Stderr, "warn: standings %s: %v\n", comp.ID, err)
			}
			for _, standing := range standings.Rows {
				fetch.teams = append(fetch.teams, standing.Team)
			}
		}
		fetches = append(fetches, fetch)
	}

	out, err := buildSeed(curated, fetches, os.Stderr)
	if err != nil {
		return err
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	// The seed is read by humans; "Brighton & Hove Albion" should not be
	// escaped into &amp; just because the default encoder assumes HTML.
	encoder.SetEscapeHTML(false)
	return encoder.Encode(out)
}
