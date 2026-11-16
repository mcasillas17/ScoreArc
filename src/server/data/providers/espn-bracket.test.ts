import playoffGames from '../__fixtures__/womens-playoff-games.json';
import { projectLiguilla } from '../liguillaProjection';
import { resolveSeason, supportsResource } from '../competitions';
import { toBands } from '@/components/zoneBands';
import { buildRings } from '@/components/radialBracketModel';
import { bracketShapeFor } from '@/components/bracketShape';
import type { Group } from '../types';

import { describe, it, expect, expectTypeOf } from 'vitest';
import { mapScoreboard } from './espn-matches';
import { mapBracket } from './espn-bracket';
import type { BracketMatch, KnockoutRoundSlug } from '../types';
import raw from '../__fixtures__/espn-bracket.json';

describe('mapBracket', () => {
  const rounds = mapBracket(raw);

  it('returns 6 rounds', () => {
    expect(rounds).toHaveLength(6);
  });

  it('round-of-32 has 16 matches', () => {
    const r32 = rounds.find((r) => r.slug === 'round-of-32');
    expect(r32).toBeDefined();
    expect(r32!.matches).toHaveLength(16);
  });

  it('final has 1 match', () => {
    const final = rounds.find((r) => r.slug === 'final');
    expect(final).toBeDefined();
    expect(final!.matches).toHaveLength(1);
  });

  it('classifies third-place loser slots as placeholders', () => {
    const thirdPlace = rounds.find((r) => r.slug === '3rd-place-match');
    expect(thirdPlace).toBeDefined();
    expect(thirdPlace!.matches[0].home.placeholder).toBe(true);
    expect(thirdPlace!.matches[0].away.placeholder).toBe(true);
  });

  it('rounds are in fixed bracket order', () => {
    const order = rounds.map((r) => r.slug);
    expect(order).toEqual([
      'round-of-32',
      'round-of-16',
      'quarterfinals',
      'semifinals',
      'final',
      '3rd-place-match',
    ]);
  });

  it('decided R32 match has non-placeholder teams with numeric scores', () => {
    const r32 = rounds.find((r) => r.slug === 'round-of-32')!;
    const decided = r32.matches.find((m) => m.winnerId !== null);
    expect(decided).toBeDefined();
    expect(decided!.home.placeholder).toBe(false);
    expect(decided!.away.placeholder).toBe(false);
    expect(typeof decided!.homeScore).toBe('number');
    expect(typeof decided!.awayScore).toBe('number');
  });

  it('non-placeholder R32 teams have a crestUrl containing /countries/', () => {
    const r32 = rounds.find((r) => r.slug === 'round-of-32')!;
    const realMatch = r32.matches[0]; // first R32 match is always real teams
    expect(realMatch.home.crestUrl).toContain('/countries/');
    expect(realMatch.away.crestUrl).toContain('/countries/');
  });

  it('later round contains at least one placeholder team', () => {
    const r16 = rounds.find((r) => r.slug === 'round-of-16')!;
    const hasPlaceholder = r16.matches.some(
      (m) => m.home.placeholder || m.away.placeholder,
    );
    expect(hasPlaceholder).toBe(true);
  });

  it('final teams are all placeholders', () => {
    const final = rounds.find((r) => r.slug === 'final')!;
    const m = final.matches[0];
    expect(m.home.placeholder).toBe(true);
    expect(m.away.placeholder).toBe(true);
  });

  it('returns semantic rounds without provider-authored display prose', () => {
    expect(rounds.map(({ slug }) => slug)).toEqual([
      'round-of-32',
      'round-of-16',
      'quarterfinals',
      'semifinals',
      'final',
      '3rd-place-match',
    ]);
    for (const round of rounds) {
      expect(Object.keys(round).sort()).toEqual(['matches', 'slug']);
    }
  });

  it('keeps every bracket match inside the exact knockout-round contract', () => {
    expectTypeOf<BracketMatch['round']>().toEqualTypeOf<KnockoutRoundSlug>();
    for (const round of rounds) {
      expect(round.matches.every((match) => match.round === round.slug)).toBe(true);
    }
  });
});

describe('mapBracket resilience', () => {
  it('skips malformed events without throwing', () => {
    const malformed = { events: [{ season: { slug: 'round-of-32' }, competitions: [] }] };
    const result = mapBracket(malformed);
    expect(result).toEqual([]);
  });

  it('returns [] for empty events', () => {
    expect(mapBracket({ events: [] })).toEqual([]);
  });

  it('handles null input gracefully', () => {
    expect(mapBracket(null)).toEqual([]);
  });
});

describe('mapBracket — slug normalization (older editions)', () => {
  const ev = (slug: string, id: string) => ({
    id, date: '2010-06-27T00:00Z', season: { slug },
    status: { type: { state: 'post', completed: true, shortDetail: 'FT', name: 'STATUS_FULL_TIME' } },
    competitions: [{
      notes: [], competitors: [
        { homeAway: 'home', winner: true, score: '2', team: { id: '1', abbreviation: 'AAA', displayName: 'Aaa', logo: 'x/countries/aaa.png' } },
        { homeAway: 'away', winner: false, score: '1', team: { id: '2', abbreviation: 'BBB', displayName: 'Bbb', logo: 'x/countries/bbb.png' } },
      ],
    }],
  });

  it('maps `second-round` to round-of-16 and `third-place` to 3rd-place-match', () => {
    const rounds = mapBracket({ events: [ev('second-round', 'a'), ev('third-place', 'b')] });
    const slugs = rounds.map((r) => r.slug);
    expect(slugs).toContain('round-of-16');
    expect(slugs).toContain('3rd-place-match');
    expect(slugs).not.toContain('second-round');
    expect(slugs).not.toContain('third-place');
  });

  it('reads the round out of a phase-prefixed slug and the hyphenated older spellings', () => {
    const rounds = mapBracket({ events: [
      ev('playoffs---quarterfinals', 'a'), ev('apertura---semifinals', 'b'),
      ev('quarter-finals', 'c'), ev('semi-finals', 'd'), ev('3rd-place', 'e'),
      ev('playoffs---regular-season', 'f'),
    ] });
    // Same two sides in every event, so each round's records fold into one
    // tie; what matters is which rounds they landed in.
    expect(rounds.map((r) => r.slug)).toEqual(['quarterfinals', 'semifinals', '3rd-place-match']);
  });

  it('ignores unsupported provider round records instead of exposing arbitrary keys', () => {
    expect(mapBracket({ events: [ev('conference-final', 'unsupported')] })).toEqual([]);
  });
});

describe('mapBracket — penalty-shootout winner fallback', () => {
  const pensEvent = {
    id: 'p1', date: '1998-06-30T00:00Z', season: { slug: 'quarterfinals' },
    status: { type: { state: 'post', completed: true, shortDetail: 'FT (pens)', name: 'STATUS_FINAL_PEN' } },
    competitions: [{
      notes: [], competitors: [
        // regulation draw; winner flag unset; shootoutScore decides it (home wins pens)
        { homeAway: 'home', winner: false, score: '2', shootoutScore: '4', team: { id: '10', abbreviation: 'ARG', displayName: 'Argentina', logo: 'x/countries/arg.png' } },
        { homeAway: 'away', winner: false, score: '2', shootoutScore: '3', team: { id: '11', abbreviation: 'ENG', displayName: 'England', logo: 'x/countries/eng.png' } },
      ],
    }],
  };

  it('derives the winner from shootoutScore when winner flags are unset', () => {
    const rounds = mapBracket({ events: [pensEvent] });
    const m = rounds.find((r) => r.slug === 'quarterfinals')!.matches[0];
    expect(m.winnerId).toBe('10'); // Argentina (higher shootoutScore)
  });
});

describe('mapBracket — club placeholders', () => {
  it('does not classify real club crests as placeholders', () => {
    const event = {
      id: 'club-1',
      date: '2026-08-01T00:00Z',
      season: { slug: 'quarterfinals' },
      status: { type: { state: 'pre', completed: false, shortDetail: '', name: 'STATUS_SCHEDULED' } },
      competitions: [{
        notes: [],
        competitors: [
          { homeAway: 'home', winner: false, team: { id: '1', abbreviation: 'SEA', displayName: 'Seattle', logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/9726.png' } },
          { homeAway: 'away', winner: false, team: { id: '2', abbreviation: 'MIA', displayName: 'Miami', logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/20232.png' } },
        ],
      }],
    };

    const match = mapBracket({ events: [event] })[0].matches[0];
    expect(match.home.placeholder).toBe(false);
    expect(match.away.placeholder).toBe(false);
  });
});

describe('mapBracket live minute', () => {
  it.each([["60'", "60'"], [undefined, null], ['', null]])('maps display clock %j to %j', (clock, minute) => {
    const event = structuredClone((raw as any).events[0]);
    event.status.type = { ...event.status.type, state: 'in', completed: false, name: 'STATUS_FIRST_HALF' };
    if (clock === undefined) delete event.status.displayClock;
    else event.status.displayClock = clock;
    const [match] = mapBracket({ events: [event] }).flatMap((r) => r.matches);
    expect([match.state, match.minute]).toEqual(['live', minute]);
  });
});

// BracketTeam.crestUrl is string | null: ESPN's empty logo string means "no
// crest" and must not reach a consumer as a falsy-but-present URL.
describe('mapBracket crest', () => {
  const team = (patch: Record<string, unknown>) => {
    const event = structuredClone((raw as any).events[0]);
    Object.assign(event.competitions[0].competitors[1].team, patch);
    return mapBracket({ events: [event] }).flatMap((r) => r.matches)[0].away;
  };

  it('gives a recorded placeholder slot a null crest', () => {
    const slot = mapBracket(raw).flatMap((r) => r.matches).find((m) => m.id === '760503')!.away;
    expect(slot).toMatchObject({ placeholder: true, crestUrl: null });
  });

  it('falls back from an empty logo to the first logo href, then to null', () => {
    expect(team({ logo: '', logos: [{ href: 'https://a.espncdn.com/x.png' }] }).crestUrl).toBe('https://a.espncdn.com/x.png');
    expect(team({ logo: '', logos: [] }).crestUrl).toBeNull();
  });
});

describe('mapBracket two-legged ties', () => {
  const team = (id: string, abbr: string, score: string | null, winner = false) => ({
    homeAway: '', team: { id, abbreviation: abbr, displayName: abbr, logo: `https://x/${abbr}.png` }, score, winner,
  });
  const leg = (id: string, date: string, state: 'pre' | 'post', home: ReturnType<typeof team>, away: ReturnType<typeof team>, note?: string) => ({
    id, date, season: { slug: 'quarterfinals' },
    status: { type: { state, completed: state === 'post', name: state === 'post' ? 'STATUS_FULL_TIME' : 'STATUS_SCHEDULED', detail: '' } },
    competitions: [{ competitors: [{ ...home, homeAway: 'home' }, { ...away, homeAway: 'away' }], notes: note ? [{ text: note }] : [] }],
  });

  it('merges the two legs of a tie into one match with the aggregate', () => {
    const [qf] = mapBracket({ events: [
      leg('1', '2026-11-13T00:30Z', 'post', team('10', 'CUW', '2'), team('20', 'PAN', '1', false)),
      leg('2', '2026-11-15T23:00Z', 'post', team('20', 'PAN', '2', true), team('10', 'CUW', '0'), 'Panama win 3-2 on aggregate'),
    ] });
    expect(qf.matches).toHaveLength(1);
    const tie = qf.matches[0];
    expect(tie.id).toBe('2');
    expect(tie.kickoff).toBe('2026-11-13T00:30Z');
    expect([tie.home.abbr, tie.homeScore, tie.away.abbr, tie.awayScore]).toEqual(['CUW', 2, 'PAN', 3]);
    expect(tie.state).toBe('finished');
    expect(tie.winnerId).toBe('20');
    expect(tie.note).toBe('Panama win 3-2 on aggregate');
  });

  it('shows the first leg score and no winner while the second leg is to come', () => {
    const [qf] = mapBracket({ events: [
      leg('1', '2026-11-13T00:30Z', 'post', team('10', 'CUW', '2', true), team('20', 'PAN', '1')),
      leg('2', '2026-11-15T23:00Z', 'pre', team('20', 'PAN', null), team('10', 'CUW', null)),
    ] });
    const tie = qf.matches[0];
    expect([tie.homeScore, tie.awayScore, tie.winnerId]).toEqual([2, 1, null]);
    expect(tie.state).toBe('scheduled');
  });

  it('leaves a single-match tie untouched', () => {
    const [qf] = mapBracket({ events: [
      leg('1', '2026-11-13T00:30Z', 'post', team('10', 'CUW', '2', true), team('20', 'PAN', '1')),
    ] });
    expect(qf.matches[0]).toMatchObject({ id: '1', homeScore: 2, awayScore: 1, winnerId: '10' });
  });
});

describe('edition playoff rules', () => {
  const nwsl = resolveSeason('nwsl', '2026')!.season;
  const femenil = resolveSeason('liga-mx-femenil', '2026-apertura')!.season;
  const wsl = resolveSeason('wsl', '2026-27')!.season;
  const [gotham, pumasHome, tigresHome] = playoffGames.events;
  const group = (prefix: string, n = 9, played = 14): Group => ({
    id: prefix, name: prefix, standings: Array.from({ length: n }, (_, i) => ({
      team: { id: prefix + i, name: prefix + i, abbr: prefix + i, crestUrl: null },
      rank: i + 1, points: 36 - i * 3, goalDifference: prefix === 'A' ? 4 : 2, goalsFor: 10, goalsAgainst: 6,
      played, wins: 0, losses: 0, draws: 0, advanced: false,
    })),
  });
  const groups = [group('A'), group('B')];
  function tiedSeries(round: string, idA: string, idB: string) {
    return [pumasHome, tigresHome].map((original, i) => {
      const e = structuredClone(original);
      e.season.slug = 'apertura---' + round;
      for (const side of e.competitions[0].competitors) {
        side.team.id = side.homeAway === (i === 0 ? 'home' : 'away') ? idA : idB;
        side.score = side.homeAway === 'home' ? '1' : '0';
        side.winner = side.homeAway === 'home';
      }
      e.competitions[0].notes = [];
      return e;
    });
  }

  it('keeps the real NWSL quarterfinal single and the two Femenil legs one tie', () => {
    expect(mapBracket({ events: [gotham] }, nwsl.playoffFormat)[0].matches[0]).toMatchObject({
      id: '401932958', round: 'quarterfinals', winnerId: '15364',
    });
    const single = mapBracket({ events: [pumasHome] }, femenil.playoffFormat)[0].matches[0];
    const drawn = structuredClone(pumasHome);
    for (const side of drawn.competitions[0].competitors) side.score = '1';
    expect(mapBracket({ events: [drawn] }, femenil.playoffFormat)[0].matches[0].winnerId).toBeNull();
    expect(single).toMatchObject({ id: '401932079', round: 'quarterfinals', winnerId: null });
    expect(mapBracket({ events: [pumasHome, tigresHome] }, femenil.playoffFormat)[0].matches[0]).toMatchObject({
      id: '401932077', round: 'quarterfinals', homeScore: 7, awayScore: 3, detailMatch: { home: { abbr: 'TIG' }, away: { abbr: 'UNAM' }, homeScore: 0, awayScore: 5 }, winnerId: pumasHome.competitions[0].competitors[0].team.id,
    });
  });

  it('uses group rank in the quarters and overall points, GD and goals in the semis', () => {
    const winner = (round: string, a: string, b: string, tables = groups) =>
      mapBracket({ events: tiedSeries(round, a, b) }, femenil.playoffFormat, tables)[0].matches[0].winnerId;
    expect(winner('quarterfinals', 'A1', 'B2')).toBe('A1');
    expect(winner('semifinals', 'A0', 'B0')).toBe('A0');
    const tied = structuredClone(groups);
    tied[1].standings[0].goalDifference = 4;
    expect(winner('semifinals', 'A0', 'B0', tied)).toBeNull();
    tied[1].standings[0].goalsFor++;
    expect(winner('semifinals', 'A0', 'B0', tied)).toBe('B0');
    tied[0].standings[0].played--;
    expect(winner('semifinals', 'A0', 'B0', tied)).toBeNull();
    expect(winner('quarterfinals', 'A1', 'B2', [])).toBeNull();
  });

  it('waits for two complete legs and requires penalties for a tied final', () => {
    const events = tiedSeries('final', 'A0', 'B0');
    const winner = () => mapBracket({ events }, femenil.playoffFormat, groups)[0].matches[0].winnerId;
    expect(winner()).toBeNull();
    const sides = events[1].competitions[0].competitors;
    const legNote = '2nd Leg - ' + sides[0].team.displayName + ' win 5-3 on penalties';
    events[1].competitions[0].notes = [{ ...tigresHome.competitions[0].notes[0], text: legNote }];
    expect(winner()).toBe(sides[0].team.id);
    events[1].competitions[0].notes = [];
    Object.assign(sides[0], { shootoutScore: '2' });
    Object.assign(sides[1], { shootoutScore: '4' });
    expect(winner()).toBe(sides[1].team.id);
    sides[0].score = '';
    expect(winner()).toBeNull();
  });

  it('reseeds four surviving clubs 1–4 and 2–3, holding unresolved overall ties', () => {
    function semifinalists(tables: Group[]) {
      const projected = mapBracket({ events: [] }, femenil.playoffFormat, tables);
      const quarters = projected[0].matches;
      const picks = Object.fromEntries(quarters.map((m, i) => ['0:' + i, m.home.id]));
      return buildRings(projected, bracketShapeFor(femenil), picks, 'predict')[1].map(n => n.team);
    }
    expect(semifinalists(groups).map(t => t.id)).toEqual(['A0', 'B1', 'B0', 'A1']);
    const tied = structuredClone(groups);
    tied[1].standings[0].goalDifference = 4;
    expect(semifinalists(tied).map(t => t.id)).toEqual(['A0', 'B0', 'A1', 'B1']);
  });

  it('orders NWSL quarterfinals into fixed halves and crowns a playoff winner distinct from the Shield', () => {
    const table = group('N', 16, 30);
    const draw = projectLiguilla([table])!;
    const qfs = draw[0].matches;
    const picks = Object.fromEntries(qfs.map((m, i) => ['0:' + i, m.away.id]));
    Object.assign(picks, { '1:0': 'N7', '1:1': 'N6', '2:0': 'N7' });
    const rings = buildRings(mapBracket({ events: [] }, nwsl.playoffFormat, [table]), bracketShapeFor(nwsl), picks, 'predict');
    expect(rings[1].map(n => n.team.id)).toEqual(['N7', 'N4', 'N6', 'N5']);
    expect(rings[2].find(n => n.isWinner)?.team.id).toBe('N7');
    expect(toBands(table.standings, nwsl.zones!, nwsl)[0]).toMatchObject({ labelKey: 'zone.nwslShield', standings: [{ team: { id: 'N0' } }] });
  });

  it('keeps unknown NWSL seeds from forming a fictional semifinal', () => {
    const draw = projectLiguilla([group('N', 16, 30)])!;
    const quarters = draw[0].matches.map(m => ({ ...m, winnerId: m.home.id }));
    const rings = buildRings([{ ...draw[0], matches: quarters }], bracketShapeFor(nwsl));
    expect(rings[1].map(n => n.team.id)).toEqual(quarters.map(m => m.home.id));
    expect(rings[1].every(n => !n.clickable && !n.match)).toBe(true);
  });

  it('uses a published Femenil semifinal draw even when a tied quarterfinal lacks ranks', () => {
    const draw = projectLiguilla(groups, 'femenil-apertura')!;
    const quarters = draw[0].matches;
    draw[1].matches = [{ ...draw[1].matches[0], home: quarters[1].home, away: quarters[3].away }];
    const rings = buildRings(draw, bracketShapeFor(femenil));
    expect(rings[1].slice(0, 2).map(n => n.team.id)).toEqual([quarters[1].home.id, quarters[3].away.id]);
  });

  it.each([
    [nwsl, [group('N', 16, 30)], ['N0', 'N3', 'N1', 'N2']],
    [femenil, groups, ['A0', 'B1', 'B0', 'A1']],
  ] as const)('keeps the other semifinal when just one official tie arrives ($0.playoffFormat)', (season, tables, expected) => {
    const draw = mapBracket({ events: [] }, season.playoffFormat, [...tables]);
    const quarters = draw[0].matches;
    for (const m of quarters) m.winnerId = m.home.id;
    const teams = new Map(quarters.map(m => [m.home.id, m.home]));
    // The second semifinal arrives first, with the projected home and away reversed.
    const official = { ...draw[1].matches[0], id: 'official', home: teams.get(expected[3])!, away: teams.get(expected[2])! };
    draw[1].matches = [official];
    const semifinalists = () => buildRings(draw, bracketShapeFor(season))[1];
    expect(semifinalists().map(n => [n.team.id, n.match?.id])).toEqual([
      [expected[0], undefined], [expected[1], undefined], [expected[3], 'official'], [expected[2], 'official'],
    ]);
    // The other tie has just one known entrant while their opponent's quarterfinal is open.
    quarters.find(m => m.home.id === expected[1])!.winnerId = null;
    const others = semifinalists().filter(n => n.match?.id !== 'official');
    expect(others.filter(n => !n.team.placeholder).map(n => n.team.id)).toEqual([expected[0]]);
    expect(others.filter(n => n.team.placeholder)).toHaveLength(1);
  });

  it.each(['STATUS_CANCELED', 'STATUS_POSTPONED', 'STATUS_ABANDONED', 'STATUS_FORFEIT', 'STATUS_FINAL_AET', 'STATUS_FINAL_PEN'])('withholds advancement for %s even if ESPN marks the leg post', status => {
    for (const index of [0, 1]) {
      const events = structuredClone([pumasHome, tigresHome]);
      events[index].status.type.name = status;
      expect(mapBracket({ events }, femenil.playoffFormat)[0].matches[0].winnerId).toBeNull();
    }
  });

  it('requires two distinct, reciprocal, correctly numbered legs in the playoff series', () => {
    const pair = () => structuredClone([pumasHome, tigresHome]);
    const winner = (events: ReturnType<typeof pair>) => mapBracket({ events }, femenil.playoffFormat)[0].matches[0].winnerId;
    const repeated = pair();
    Object.assign(repeated[1].competitions[0], { leg: { value: 1 } });
    expect(winner(repeated)).toBeNull();
    const conflict = pair();
    conflict[0].competitions[0].notes[0].text = '2nd Leg';
    expect(winner(conflict)).toBeNull();
    const notesOnly = pair();
    for (const event of notesOnly) Reflect.deleteProperty(event.competitions[0], 'leg');
    expect(winner(notesOnly)).toBe('133981');
    notesOnly[0].competitions[0].notes = [];
    expect(winner(notesOnly)).toBeNull();
    const sameEvent = pair();
    sameEvent[1].id = sameEvent[0].id;
    expect(winner(sameEvent)).toBeNull();
  });

  it.each([
    ['explicit zero value', { value: 0, displayValue: '2nd Leg' }, ['2nd Leg'], null],
    ['out-of-range secondary ordinal', { value: 2 }, ['2nd Leg', '3rd Leg'], null],
    ['out-of-range display ordinal', { value: 2, displayValue: '3rd Leg' }, ['2nd Leg'], null],
    ['conflicting display value', { value: 2, displayValue: '1st Leg' }, ['2nd Leg'], null],
    ['conflicting secondary note', { value: 2, displayValue: '2nd Leg' }, ['2nd Leg', '1st Leg'], null],
    ['secondary note alone', undefined, ['Quarterfinal', '  2ND  Leg - return match'], '133981'],
    ['display value alone', { displayValue: '2nd Leg' }, ['Quarterfinal'], '133981'],
  ] as const)('verifies every leg ordinal source: %s', (_label, leg, texts, expected) => {
    const events = structuredClone([pumasHome, tigresHome]);
    Object.assign(events[1].competitions[0], { leg, notes: texts.map(text => ({ text })) });
    expect(mapBracket({ events }, femenil.playoffFormat)[0].matches[0].winnerId).toBe(expected);
  });

  it('renders the verified final and winner even when a tied semifinal cannot be settled from the table', () => {
    const draw = projectLiguilla(groups, 'femenil-apertura')!;
    const q = draw[0].matches;
    q.forEach(m => { m.winnerId = m.home.id; });
    draw[1].matches = [
      { ...draw[1].matches[0], home: q[0].home, away: q[1].home, winnerId: null },
      { ...draw[1].matches[1], home: q[2].home, away: q[3].home, winnerId: q[2].home.id },
    ];
    draw[2].matches[0] = { ...draw[2].matches[0], home: q[0].home, away: q[2].home, winnerId: q[0].home.id };
    const final = buildRings(draw, bracketShapeFor(femenil))[2];
    expect(final.map(n => n.team.id)).toEqual([q[0].home.id, q[2].home.id]);
    expect(final.find(n => n.isWinner)?.team.id).toBe(q[0].home.id);
  });

  it('awards the WSL title from the final 26-round table and marks places 13 and 14', () => {
    const bands = toBands(group('W', 14, 26).standings, wsl.zones!, wsl);
    expect(bands.find(b => b.kind === 'champion')?.standings[0].team.id).toBe('W0');
    expect(bands.find(b => b.kind === 'relegation-playoff')).toMatchObject({ from: 13, to: 13 });
    expect(bands.find(b => b.kind === 'relegation')).toMatchObject({ from: 14, to: 14 });
    // A completed survival match can award a match win to the 13th-placed side.
    const event = structuredClone(gotham);
    event.season.slug = 'relegation-playoffs';
    event.competitions[0].competitors[0].team.id = 'W12';
    expect(mapScoreboard({ events: [event] })[0]).toMatchObject({ state: 'finished', winnerId: 'W12' });
    expect(mapBracket({ events: [event] })).toEqual([]);
    expect(supportsResource(wsl, 'bracket')).toBe(false);
  });
});
