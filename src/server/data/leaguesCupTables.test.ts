import { describe, it, expect } from 'vitest';
import { mapScoreboard } from './providers/espn-matches';
import { parseShootout } from './store';
import { computePhaseTables, computeQuarterfinals } from './leaguesCupTables';
import raw from './__fixtures__/leagues-cup-phase-2026.json';
import ligaMxIds from './__fixtures__/liga-mx-team-ids-2026.json';

// The fixture is the real, complete 2026 Leagues Cup phase one — all 54
// matches as ESPN served them. These assertions are checked against the
// officially published qualifiers, so if the computation drifts the test
// fails against reality rather than against itself.
const CUT = 4;

const matches = mapScoreboard(raw).map((m) => ({
  ...m,
  // The store does this enrichment before standings ever see a match; a
  // shootout is only discoverable from the match note.
  shootout: parseShootout(m.note, m.home.name, m.away.name),
}));
const ligaMx = new Set<string>(ligaMxIds as string[]);
const groups = computePhaseTables(matches, ligaMx, CUT);
const table = (id: string) => groups.find((g) => g.id === id)!.standings;
const names = (id: string, n: number) => table(id).slice(0, n).map((s) => s.team.name);

describe('computePhaseTables — 2026 Leagues Cup phase one', () => {
  it('reads all 54 matches', () => {
    expect(matches).toHaveLength(54);
  });

  it('splits into two tables of 18', () => {
    expect(groups.map((g) => g.id)).toEqual(['mls', 'liga-mx']);
    expect(table('mls')).toHaveLength(18);
    expect(table('liga-mx')).toHaveLength(18);
  });

  it('gives every club exactly three matches', () => {
    for (const g of groups) for (const s of g.standings) expect(s.played).toBe(3);
  });

  // Splitting on country would put Vancouver in neither table — it is a
  // Canadian club playing in MLS.
  it('places Vancouver Whitecaps in MLS, not Liga MX', () => {
    expect(table('mls').some((s) => s.team.name.includes('Vancouver'))).toBe(true);
    expect(table('liga-mx').some((s) => s.team.name.includes('Vancouver'))).toBe(false);
  });

  // The published qualifiers. This is the assertion that matters.
  it('reproduces the official MLS qualifiers', () => {
    expect(names('mls', CUT).sort()).toEqual(
      ['Austin FC', 'Chicago Fire FC', 'Columbus Crew', 'Real Salt Lake'].sort(),
    );
  });

  it('reproduces the official Liga MX qualifiers', () => {
    expect(names('liga-mx', CUT).sort()).toEqual(
      ['América', 'León', 'Monterrey', 'Toluca'].sort(),
    );
  });

  // Both cuts were settled on goal difference — a naive points-only sort
  // would qualify the wrong club on each side.
  it('breaks the MLS cut on goal difference (Real Salt Lake over LAFC)', () => {
    const rsl = table('mls').find((s) => s.team.name === 'Real Salt Lake')!;
    const lafc = table('mls').find((s) => s.team.name === 'LAFC')!;
    expect(rsl.points).toBe(lafc.points);
    expect(rsl.goalDifference).toBeGreaterThan(lafc.goalDifference);
    expect(rsl.advanced).toBe(true);
    expect(lafc.advanced).toBe(false);
  });

  it('breaks the Liga MX cut on goal difference (Monterrey over Cruz Azul)', () => {
    const mty = table('liga-mx').find((s) => s.team.name === 'Monterrey')!;
    const cruz = table('liga-mx').find((s) => s.team.name === 'Cruz Azul')!;
    expect(mty.points).toBe(cruz.points);
    expect(mty.advanced).toBe(true);
    expect(cruz.advanced).toBe(false);
  });

  // The competition's defining quirk: a regulation draw goes straight to
  // penalties and pays 2 points, so a club can reach 6 without winning a match.
  it('pays shootout wins two points — Tigres reach 6 with no regulation win', () => {
    const tigres = table('liga-mx').find((s) => s.team.name.includes('Tigres'))!;
    expect(tigres.wins).toBe(0);
    expect(tigres.draws).toBe(3);
    expect(tigres.points).toBe(6);
  });

  it('marks exactly four advancing clubs per table', () => {
    for (const g of groups) {
      expect(g.standings.filter((s) => s.advanced)).toHaveLength(CUT);
    }
  });
});

describe('computeQuarterfinals', () => {
  const ties = computeQuarterfinals(groups, CUT);

  it('produces four ties', () => {
    expect(ties).toHaveLength(CUT);
  });

  // Fixed seeding: MLS 1 v LMX 4, MLS 2 v LMX 3, MLS 3 v LMX 2, MLS 4 v LMX 1.
  it('matches the officially published pairings', () => {
    expect(ties.map((t) => `${t.home.team.name} v ${t.away.team.name}`)).toEqual([
      'Chicago Fire FC v Monterrey',
      'Austin FC v Toluca',
      'Columbus Crew v América',
      'Real Salt Lake v León',
    ]);
  });

  // This pairing is what guarantees no two clubs from one league can meet
  // before the semifinal.
  it('pairs every tie across leagues', () => {
    for (const t of ties) {
      expect(ligaMx.has(t.home.team.id)).toBe(false);
      expect(ligaMx.has(t.away.team.id)).toBe(true);
    }
  });

  it('returns nothing when a table is short of the cut', () => {
    expect(computeQuarterfinals([{ id: 'mls', name: 'MLS', standings: [] }], CUT)).toEqual([]);
  });
});
