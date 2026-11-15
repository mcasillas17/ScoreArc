import { describe, it, expect, expectTypeOf } from 'vitest';
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
