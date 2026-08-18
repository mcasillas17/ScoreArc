package main

import (
	"encoding/binary"
	"hash"
	"hash/fnv"
	"strconv"

	"github.com/mcasillas17/scorearc-backend/shared/model"
)

// The content memo -- the C3 write guard from §4.1 of
// docs/superpowers/specs/2026-08-18-ingestion-write-classification-design.md.
//
// WHAT IT SOLVES. `standing` and `top_scorer` are replaced WHOLESALE -- DELETE
// the scope, INSERT every row, one tx.Exec at a time -- on every slow tick, for
// every competition, whether or not a single result moved. Measured on
// production over a 298-second window with the backlog drained and no live
// match: standing +228/-228 for a 228-row table, top_scorer +600/-600 for a
// 300-row table. ~477,000 tuple writes and ~830,000 pooler round trips a day to
// keep 528 rows exactly as they were, and both tables are already the most
// autovacuumed in the database despite being the smallest.
//
// WHY SKIPPING IS SAFE. A standings table is a pure function of the finished
// matches in its competition, and a leader board is a pure function of the
// goals and assists scored in it; both can only move when a match finalizes.
// That was measured, not assumed: content hashes over the stored rows,
// aggregated per competition and per category, were captured across three
// windows that pg_stat_user_tables confirms spanned full delete-and-reinsert
// ticks. Nine standings tables, ten leader boards, ZERO changed, every time.
//
// WHY IT HASHES MAPPED ROWS AND NOT THE ESPN BODY.
// docs/research/2026-08-18-espn-payload-volatility.md §3 lists fields that
// change independently of any real change: roster `.timestamp` moves on EVERY
// SINGLE FETCH (confirmed at a 25-second gap), the per-event statistics
// `.timestamp` moves on a ~9-10 minute CDN regeneration cycle, and
// `summary.meta.lastUpdatedAt`, the whole `news.*` subtree, `videos[]` and the
// ticket counters all churn on their own schedule. A hash of the response body
// would report "changed" on most polls and this guard would never fire. The
// mappers strip all of it: nothing but the columns below reaches a
// model.Standing or a model.StatLeader.
//
// WHAT IT IS NOT. A cost gate, exactly like the runner's `snapshotted` day
// marker -- it carries no correctness weight. The primary keys on `standing`
// and `top_scorer` remain the guarantee, a restart empties the map and rewrites
// each scope once (27 writes, once, per deploy), and nothing is EVER memoised
// that the store did not commit.

const fingerprintRowMarker = byte(0xff)

// contentDigest accumulates FNV-1a/64 over a canonical encoding of the exact
// column values a replacement is about to write.
//
// FNV rather than SHA-256 because the input is a few hundred short strings that
// our own mappers produced from a non-adversarial provider, and because the
// only consequence of a collision is ONE skipped write that persists until the
// content next changes for real -- self-healing, not corrupting. At 64 bits
// against ~10^5 distinct row sets per scope per season that is a ~3e-10 chance
// per scope per year.
type contentDigest struct{ hash hash.Hash64 }

func newContentDigest() *contentDigest {
	return &contentDigest{hash: fnv.New64a()}
}

// text writes one length-prefixed field. Provider strings are not sanitized,
// so delimiter framing would let an embedded control character make two
// different stored rows produce the same byte stream.
//
// hash.Hash's contract is that Write never returns an error, which is why the
// returns are discarded here and nowhere else.
func (d *contentDigest) text(value string) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = d.hash.Write(size[:])
	_, _ = d.hash.Write([]byte(value))
}

func (d *contentDigest) number(value int) { d.text(strconv.Itoa(value)) }

func (d *contentDigest) flag(value bool) { d.text(strconv.FormatBool(value)) }

// optionalText keeps a nil pointer distinct from a pointer to "". They are
// different values in the database -- standing.group_id is nullable and a
// single-table league stores NULL, not ” -- so they must be different bytes
// here. The presence byte stops a nil colliding with any real string.
func (d *contentDigest) optionalText(value *string) {
	if value == nil {
		_, _ = d.hash.Write([]byte{0})
		return
	}
	_, _ = d.hash.Write([]byte{1})
	d.text(*value)
}

func (d *contentDigest) optionalNumber(value *int) {
	if value == nil {
		_, _ = d.hash.Write([]byte{0})
		return
	}
	_, _ = d.hash.Write([]byte{1})
	d.number(*value)
}

func (d *contentDigest) endRow() { _, _ = d.hash.Write([]byte{fingerprintRowMarker}) }

func (d *contentDigest) sum() uint64 { return d.hash.Sum64() }

func standingsScope(competitionID, seasonID string) string {
	return "standing\x00" + competitionID + "\x00" + seasonID
}

func leadersScope(competitionID, seasonID, category string) string {
	return "top_scorer\x00" + competitionID + "\x00" + seasonID + "\x00" + category
}

// standingsFingerprint covers EXACTLY the columns ReplaceStandings INSERTs, in
// its own order.
//
// The team id hashed is the CANONICAL one -- teamIDs[row.Team.ID] -- because
// that is what the INSERT carries, and two provider ids can resolve to one
// canonical team. The resolution loop in refreshStandings runs first and aborts
// the refresh on a miss, so a partially resolved set never reaches here.
//
// Team.Name, Team.Abbr and Team.CrestURL are DELIBERATELY absent: they arrive
// on model.Standing but ReplaceStandings never writes them. They belong to
// `team`, which the seed, the resolver and SetTeamCrest own, each with its own
// guard. Hashing them would make one crest mirror rewrite 228 standings rows
// that did not change.
//
// updated_at is absent for the obvious reason -- it is now(), so hashing it
// would make every fingerprint unique and the guard would never fire.
func standingsFingerprint(
	source string,
	rows []model.Standing,
	teamIDs map[string]string,
) uint64 {
	digest := newContentDigest()
	digest.text(source)
	for _, row := range rows {
		digest.text(teamIDs[row.Team.ID])
		digest.optionalText(row.GroupID)
		digest.optionalText(row.GroupName)
		digest.number(row.Rank)
		digest.number(row.Played)
		digest.number(row.Wins)
		digest.number(row.Draws)
		digest.number(row.Losses)
		digest.number(row.GoalsFor)
		digest.number(row.GoalsAgainst)
		digest.number(row.GoalDifference)
		digest.number(row.Points)
		digest.flag(row.Advanced)
		digest.endRow()
	}
	return digest.sum()
}

// leadersFingerprint covers EXACTLY the columns ReplaceLeaders INSERTs.
// top_scorer has no updated_at column at all, so every stored value is here.
//
// It must be taken over the MIRRORED board -- after mirrorLeaders has run --
// because team_crest_url is a stored column and the mirror is what decides its
// final value. Fingerprinting the freshly-mapped board instead would memoise
// a.espncdn.com URLs against a table holding cdn.scorearc.futbol ones and
// rewrite it on every tick -- exactly the unconditional double-write bug
// found in leaderCrestsChanged.
func leadersFingerprint(
	source, category string,
	rows []model.StatLeader,
) uint64 {
	digest := newContentDigest()
	digest.text(source)
	digest.text(category)
	for _, row := range rows {
		digest.number(row.Rank)
		digest.text(row.Player)
		digest.text(row.TeamAbbr)
		digest.text(row.TeamName)
		digest.optionalText(row.TeamCrestURL)
		digest.number(row.Value)
		digest.optionalNumber(row.Matches)
		digest.endRow()
	}
	return digest.sum()
}

// contentUnchanged reports whether `digest` is the fingerprint this PROCESS
// last committed for scope.
//
// A ZERO-ROW SET IS NEVER UNCHANGED, and that is the load-bearing half of this
// function. ReplaceStandings and ReplaceLeaders reject an empty replacement
// (ErrEmptyReplacement) and the runner turns that into a "..._preserved" audit
// row while keeping the rows already stored -- normal, because not every
// competition publishes every board. Nothing is committed on that path, so
// letting an empty set take the skip would (a) stop the absent-board audit
// firing after the first tick and (b) have the memo assert that the table holds
// nothing when it in fact holds last week's board. The store, not the memo,
// decides what an absent board means.
func (r *runner) contentUnchanged(scope string, rowCount int, digest uint64) bool {
	if rowCount == 0 {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, seen := r.written[scope]
	return seen && previous == digest
}

// markContentWritten records a fingerprint that a replacement transaction
// COMMITTED. Call it on the success branch and nowhere else: memoising before
// the write, or on an error path, would let a failed write be skipped on the
// next tick and hide the failure until the content changed again.
func (r *runner) markContentWritten(scope string, digest uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.written == nil {
		// Defensive, in the same shape as mirrorAsset's rejectedAssets guard: a
		// runner literal that forgets this map must not panic mid-cycle.
		r.written = make(map[string]uint64, 32)
	}
	r.written[scope] = digest
}
