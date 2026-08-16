package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mcasillas17/scorearc-backend/config"
)

// ErrPromotionBlocked means a provisional team could not be folded into the
// curated team that took over its source ids. The rest of the seed still
// applies; that one team keeps resolving through its provisional row until a
// human resolves the conflict.
//
// ApplyTeamSeed does NOT return this — a blocked promotion is one degraded club,
// not a reason to refuse to start. It is reported instead: a warning log AND a
// failed `ingest_run` row per blocked team, so the failure is visible to
// monitoring rather than only to whoever is tailing logs.
var ErrPromotionBlocked = errors.New("provisional team promotion blocked")

// promotionRunKind is the ingest_run kind a blocked promotion is recorded under.
const promotionRunKind = "team_promotion"

// seedTimeout bounds a whole seed apply. Seeding is bulk work — ~200 teams and
// their crosswalk rows — so it must NOT borrow the generic per-operation
// timeout, which is sized for single statements.
const seedTimeout = 2 * time.Minute

// seedContext bounds bulk seeding, still deferring to a shorter caller deadline.
func seedContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, seedTimeout)
}

const teamSeedUpsertSQL = `
INSERT INTO team (id, kind, name, short_name, abbr, country, crest_url, provisional, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, false, now())
ON CONFLICT (id) DO UPDATE SET
	kind = EXCLUDED.kind,
	name = EXCLUDED.name,
	short_name = EXCLUDED.short_name,
	abbr = EXCLUDED.abbr,
	country = EXCLUDED.country,
	-- The seed crest seeds ONLY. Crests are mirrored to our own CDN at runtime
	-- (SetTeamCrest), and the seed's value is a provider hotlink, so preferring
	-- EXCLUDED here would replace every mirrored URL with an ESPN one on every
	-- restart — and then re-upload to R2 to undo it. The stored value wins
	-- whenever there is one.
	crest_url = COALESCE(team.crest_url, EXCLUDED.crest_url),
	provisional = false,
	updated_at = now()`

// teamRefRepointSQL is the SEED's crosswalk write, and it deliberately WINS the
// conflict: the curated seed is the identity authority, so claiming a source id
// that currently points at a provisional row is the whole mechanism by which
// curation takes effect.
//
// It is not shared with the resolver, which must do the opposite (see
// teamRefClaimSQL): a resolver that repointed the crosswalk would silently
// revert curation to the provisional slug it had just minted.
const teamRefRepointSQL = `
INSERT INTO team_external_ref (source, source_id, team_id, first_seen_at, last_seen_at)
VALUES ($1, $2, $3, now(), now())
ON CONFLICT (source, source_id) DO UPDATE SET
	team_id = EXCLUDED.team_id,
	last_seen_at = now()`

// seedRef is one crosswalk row the seed intends to own.
type seedRef struct {
	source   string
	sourceID string
	teamID   string
}

// ApplyTeamSeed writes the curated team registry and its source crosswalk rows.
// It is idempotent and runs at ingester startup.
//
// When a seeded team claims a source id that currently maps to a PROVISIONAL
// team — the normal case for a club ESPN introduced between curation passes —
// the provisional row is not merely re-flagged. Its foreign keys are repointed
// onto the curated team and the provisional row is deleted (spec §5.4).
// Anything less leaves matches keyed to the dead team, invisible to the natural
// key, and a second source then forks a duplicate match.
//
// A promotion that cannot complete — say the curated team already holds a row
// the provisional team's history would collide with, or the role is missing the
// DELETE grant this needs — does NOT fail the seed. That team is left pointing
// at its provisional row and the rest of the seed is applied: the affected club
// keeps working, degraded rather than down, and the next seed run retries. Each
// failure is logged with both ids and the reason AND written to `ingest_run` as
// a failed run, because a degradation nobody can see is indistinguishable from
// the feature never having worked.
func (s *Store) ApplyTeamSeed(ctx context.Context, seed []config.SeedTeam) error {
	ctx, cancel := seedContext(ctx)
	defer cancel()

	// Sort both the teams and the crosswalk rows so concurrent seeders take row
	// locks in one global order and cannot deadlock against each other.
	teams := append([]config.SeedTeam(nil), seed...)
	sort.Slice(teams, func(i, j int) bool { return teams[i].ID < teams[j].ID })

	refs := make([]seedRef, 0, len(teams))
	for _, team := range teams {
		for source, sourceID := range team.Refs {
			refs = append(refs, seedRef{source: source, sourceID: sourceID, teamID: team.ID})
		}
	}
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].source != refs[j].source {
			return refs[i].source < refs[j].source
		}
		return refs[i].sourceID < refs[j].sourceID
	})

	teamBatch := &pgx.Batch{}
	for _, team := range teams {
		teamBatch.Queue(teamSeedUpsertSQL,
			team.ID, team.Kind, team.Name, nullIfEmpty(team.ShortName),
			team.Abbr, nullIfEmpty(team.Country), team.CrestURL)
	}
	if err := s.pool.SendBatch(ctx, teamBatch).Close(); err != nil {
		return fmt.Errorf("upsert seeded teams: %w", err)
	}

	// Read the provisional teams currently holding these source ids BEFORE any
	// crosswalk upsert repoints them at the curated rows.
	promotions, err := s.provisionalHolders(ctx, refs)
	if err != nil {
		return err
	}

	// Crosswalk rows that need no promotion go in one batch. The rest move
	// inside their own promotion transaction, so a promotion that fails leaves
	// its source ids pointing at the provisional row that still owns the history.
	promoting := make(map[string]struct{})
	for _, promotion := range promotions {
		for _, ref := range promotion.refs {
			promoting[cacheKey(ref.source, ref.sourceID)] = struct{}{}
		}
	}
	refBatch := &pgx.Batch{}
	for _, ref := range refs {
		if _, held := promoting[cacheKey(ref.source, ref.sourceID)]; held {
			continue
		}
		refBatch.Queue(teamRefRepointSQL, ref.source, ref.sourceID, ref.teamID)
	}
	if err := s.pool.SendBatch(ctx, refBatch).Close(); err != nil {
		return fmt.Errorf("upsert seeded team refs: %w", err)
	}

	var deferred []string
	for _, promotion := range promotions {
		started := time.Now()
		if err := s.applyPromotion(ctx, promotion); err != nil {
			deferred = append(deferred, promotion.provisionalID)
			slog.Warn("team curation deferred: the provisional row keeps its history",
				"provisional", promotion.provisionalID,
				"curated", promotion.curatedID,
				"error", err)
			s.recordBlockedPromotion(ctx, promotion, started, err)
			continue
		}
	}
	// The crosswalk moved under any warm mapping this process holds.
	s.cache().reset()
	if len(deferred) > 0 {
		slog.Warn("team seed applied with deferred promotions",
			"deferred", len(deferred), "teams", strings.Join(deferred, ", "))
	}
	return nil
}

type promotion struct {
	provisionalID string
	curatedID     string
	refs          []seedRef
}

// recordBlockedPromotion writes the failed promotion to the ingest audit log.
// It is best-effort by design: it runs on a context detached from the seed's,
// so a seed that has just run out of time still leaves the record behind, and a
// failure to record is itself only logged — the seed must still finish.
func (s *Store) recordBlockedPromotion(
	ctx context.Context,
	p promotion,
	started time.Time,
	cause error,
) {
	logCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	message := fmt.Sprintf("promote %s -> %s: %v", p.provisionalID, p.curatedID, cause)
	if err := s.LogIngestRun(
		logCtx, nil, promotionRunKind, started, time.Now(), false, message,
	); err != nil {
		slog.Warn("record blocked team promotion",
			"provisional", p.provisionalID, "curated", p.curatedID, "error", err)
	}
}

// applyPromotion moves one provisional team's source ids and history onto its
// curated row, atomically. On failure nothing moves: the source ids still
// resolve to the provisional team, which still holds the matches.
func (s *Store) applyPromotion(ctx context.Context, p promotion) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)

	for _, ref := range p.refs {
		if _, err := tx.Exec(ctx, teamRefRepointSQL, ref.source, ref.sourceID, ref.teamID); err != nil {
			return err
		}
	}
	if err := promoteProvisionalTeam(ctx, tx, p.provisionalID, p.curatedID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// provisionalHolders finds source ids the seed is claiming that currently point
// at a provisional team, grouping the crosswalk rows that move with each
// (provisional -> curated) pair.
func (s *Store) provisionalHolders(ctx context.Context, refs []seedRef) ([]promotion, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	sources := make([]string, len(refs))
	sourceIDs := make([]string, len(refs))
	curatedFor := make(map[string]string, len(refs))
	for i, ref := range refs {
		sources[i] = ref.source
		sourceIDs[i] = ref.sourceID
		curatedFor[cacheKey(ref.source, ref.sourceID)] = ref.teamID
	}

	rows, err := s.pool.Query(ctx, `
SELECT r.source, r.source_id, r.team_id
FROM team_external_ref r
JOIN team t ON t.id = r.team_id
JOIN unnest($1::text[], $2::text[]) AS k(source, source_id)
	ON k.source = r.source AND k.source_id = r.source_id
WHERE t.provisional
ORDER BY r.team_id, r.source, r.source_id`, sources, sourceIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	index := make(map[string]int)
	var promotions []promotion
	for rows.Next() {
		var source, sourceID, provisionalID string
		if err := rows.Scan(&source, &sourceID, &provisionalID); err != nil {
			return nil, err
		}
		curated := curatedFor[cacheKey(source, sourceID)]
		if curated == "" || curated == provisionalID {
			continue
		}
		key := provisionalID + "\x00" + curated
		at, exists := index[key]
		if !exists {
			at = len(promotions)
			index[key] = at
			promotions = append(promotions, promotion{provisionalID: provisionalID, curatedID: curated})
		}
		promotions[at].refs = append(promotions[at].refs,
			seedRef{source: source, sourceID: sourceID, teamID: curated})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(promotions, func(i, j int) bool {
		return promotions[i].provisionalID < promotions[j].provisionalID
	})
	return promotions, nil
}

// promoteProvisionalTeam moves every reference to a provisional team onto the
// curated team that has adopted its source ids, then deletes the provisional
// row. This is the "rename and merge inside our own system" of spec §5.4, and
// it is tractable precisely because we own the ids.
// FINALIZED matches are repointed like any other. scorearc_protect_match_history
// carves identity columns out of its immutability comparison for exactly this,
// because a provisional id is a placeholder WE minted, not a recorded result —
// see the comment on that trigger in 0001_init.up.sql.
func promoteProvisionalTeam(ctx context.Context, tx pgx.Tx, provisionalID, curatedID string) error {
	// The team_external_ref repoint must come first: rows the seed did not
	// itself claim would otherwise be destroyed by the ON DELETE CASCADE when
	// the provisional row is deleted.
	repoints := []string{
		`UPDATE team_external_ref SET team_id=$2 WHERE team_id=$1`,
		`UPDATE match SET home_team_id=$2, updated_at=now() WHERE home_team_id=$1`,
		`UPDATE match SET away_team_id=$2, updated_at=now() WHERE away_team_id=$1`,
		`UPDATE match SET winner_id=$2, updated_at=now() WHERE winner_id=$1`,
		`UPDATE standing SET team_id=$2 WHERE team_id=$1`,
		`UPDATE standing_snapshot SET team_id=$2 WHERE team_id=$1`,
		`UPDATE squad_membership SET team_id=$2, updated_at=now() WHERE team_id=$1`,
		`UPDATE player_season_stat SET team_id=$2, updated_at=now() WHERE team_id=$1`,
	}
	for _, statement := range repoints {
		if _, err := tx.Exec(ctx, statement, provisionalID, curatedID); err != nil {
			if isUniqueViolation(err) {
				return fmt.Errorf(
					"%w: %s -> %s collides with rows the curated team already has "+
						"(both ids describe the same fixture or standing); merge them manually: %w",
					ErrPromotionBlocked, provisionalID, curatedID, err)
			}
			return fmt.Errorf("promote %s -> %s: %w", provisionalID, curatedID, err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM team WHERE id=$1`, provisionalID); err != nil {
		return fmt.Errorf("delete provisional team %s: %w", provisionalID, err)
	}
	return nil
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

const competitionUpsertSQL = `
INSERT INTO competition (id, name, short_name, kind, updated_at)
VALUES ($1,$2,$3,$4,now())
ON CONFLICT (id) DO UPDATE SET
	name = EXCLUDED.name, short_name = EXCLUDED.short_name,
	kind = EXCLUDED.kind, updated_at = now()`

const seasonUpsertSQL = `
INSERT INTO season (competition_id, id, label, has_bracket)
VALUES ($1,$2,$3,$4)
ON CONFLICT (competition_id, id) DO UPDATE SET
	label = EXCLUDED.label, has_bracket = EXCLUDED.has_bracket`

const competitionRefUpsertSQL = `
INSERT INTO competition_external_ref (source, source_id, competition_id, first_seen_at, last_seen_at)
VALUES ($1,$2,$3,now(),now())
ON CONFLICT (source, source_id) DO UPDATE SET
	competition_id = EXCLUDED.competition_id, last_seen_at = now()`

// ApplyCompetitionSeed writes competitions and their seasons from the
// generated registry, plus the ESPN slug crosswalk. Match rows have a foreign
// key to season, so this must run before any ingest.
func (s *Store) ApplyCompetitionSeed(ctx context.Context, comps []config.Competition) error {
	ctx, cancel := seedContext(ctx)
	defer cancel()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)

	sorted := append([]config.Competition(nil), comps...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })

	batch := &pgx.Batch{}
	for _, comp := range sorted {
		// A competition with any bracket season is a cup; otherwise a league.
		kind := "league"
		seasonIDs := make([]string, 0, len(comp.Seasons))
		for id, season := range comp.Seasons {
			seasonIDs = append(seasonIDs, id)
			if season.HasBracket {
				kind = "cup"
			}
		}
		sort.Strings(seasonIDs)
		batch.Queue(competitionUpsertSQL, comp.ID, comp.Name, comp.ShortName, kind)
		for _, id := range seasonIDs {
			season := comp.Seasons[id]
			batch.Queue(seasonUpsertSQL, comp.ID, season.ID, season.Label, season.HasBracket)
		}
		batch.Queue(competitionRefUpsertSQL, "espn", comp.ESPNSlug, comp.ID)
	}
	if err := tx.SendBatch(ctx, batch).Close(); err != nil {
		return fmt.Errorf("upsert competition seed: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.cache().reset()
	return nil
}
