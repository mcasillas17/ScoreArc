import { describe, expect, it } from 'vitest';
import { compareSemantic, NORMALIZATION_VERSION } from './normalize';

const match = (id = '760487') => ({
  id, kickoff: '2026-06-29T17:00Z', state: 'finished',
  home: { id: '205', name: 'Brazil' }, away: { id: '627', name: 'Japan' },
  homeScore: 2, awayScore: 1, winnerId: '205', scorers: [],
});
const compare = (reader: unknown, espn: unknown, kind = 'getFixtures') => compareSemantic(kind, reader, espn);

describe('reader evaluation semantic policy', () => {
  it('names its version and normalizes only equivalent kickoff instants and unordered match order', () => {
    const original = [match(), match('760489')];
    const reader = original.toReversed().map(row => ({ ...row, kickoff: '2026-06-29T17:00:00.000Z' }));
    const result = compare(reader, original);
    expect(result.differences).toEqual([]);
    expect(result.normalizers).toEqual(expect.arrayContaining(['instant-v1', 'match-set-order-v1']));
    expect(NORMALIZATION_VERSION).toBe('reader-evaluation-v1');
    expect(original[0].kickoff).toBe('2026-06-29T17:00Z');
  });

  it('does not round distinct instants or reorder upcoming matches', () => {
    expect(compare([{ ...match(), kickoff: '2026-06-29T17:00:00.001Z' }], [match()]).differences).toContainEqual({ path: '$[0].kickoff', category: 'value' });
    expect(compare([{ ...match(), kickoff: '2026-06-29T17:00:00.0001Z' }], [{ ...match(), kickoff: '2026-06-29T17:00:00.0002Z' }]).differences).toContainEqual({ path: '$[0].kickoff', category: 'value' });
    expect(compare([match('2'), match('1')], [match('1'), match('2')], 'getUpcoming').differences).toContainEqual({ path: '$[0].id', category: 'entity' });
  });

  it('retains wrong entity, home/away, score, winner and missing-match differences', () => {
    expect(compare([{ ...match(), id: '999' }], [match()]).differences).toContainEqual({ path: '$[0].id', category: 'entity' });
    expect(compare([{ ...match(), home: match().away }], [match()]).differences).toContainEqual({ path: '$[0].home.id', category: 'side' });
    expect(compare([{ ...match(), homeScore: 0 }], [match()]).differences).toContainEqual({ path: '$[0].homeScore', category: 'score' });
    expect(compare([{ ...match(), winnerId: '627' }], [match()]).differences).toContainEqual({ path: '$[0].winnerId', category: 'score' });
    expect(compare([], [match()]).differences).toContainEqual({ path: '$.length', category: 'coverage' });
  });

  it.each([
    [{}, { value: undefined }], [{ value: undefined }, { value: null }],
    [{ value: null }, { value: 0 }], [{ value: 0 }, { value: false }],
    [{ value: false }, { value: '' }], [{ value: '' }, { value: [] }],
  ])('preserves absent, undefined, null, zero, false and empty distinctions (%j vs %j)', (reader, espn) => {
    expect(compare(reader, espn, 'getMatchSummary').differences.length).toBeGreaterThan(0);
  });

  it('does not erase unknown starter, scorer own goal, side or attribution', () => {
    const summary = { scorers: [{ teamId: '205', athleteId: '777', ownGoal: false }], lineups: { home: { players: [{ starter: false }] } } };
    const reader = { scorers: [{ teamId: null, athleteId: null, ownGoal: null }], lineups: { home: { players: [{ starter: null }] } } };
    expect(compare(reader, summary, 'getMatchSummary').differences).toEqual(expect.arrayContaining([
      { path: '$.scorers[0].teamId', category: 'side' },
      { path: '$.scorers[0].athleteId', category: 'entity' },
      { path: '$.scorers[0].ownGoal', category: 'score' },
      { path: '$.lineups.home.players[0].starter', category: 'value' },
    ]));
  });

  it('separates resource evidence without dropping semantic scope or availability', () => {
    const espn = [match()];
    const reader = [{ ...match(), readerResources: { version: 1, resources: {} } }];
    const result = compare(reader, espn);
    expect(result.differences).toEqual([]);
    expect(result.excluded).toContain('$[].readerResources');
    expect(compare([{ ...match(), scope: { competitionId: 'wrong', seasonId: '2026' } }], espn).differences.length).toBeGreaterThan(0);
    expect(compare({ lineups: { availability: 'partial' } }, { lineups: { availability: 'complete' } }, 'getMatchSummary').differences).toContainEqual({ path: '$.lineups.availability', category: 'coverage' });
  });

  it('ignores qualified canonical refs only on leader and lineup rows, never public links', () => {
    const leader = { athleteId: '777', teamId: '205', playerSlug: 'held-player', rank: 1, value: 2 };
    expect(compare({ scorers: [{ ...leader, playerId: 'canonical' }], assists: [] }, { scorers: [leader], assists: [] }, 'getLeaders').differences).toEqual([]);
    expect(compare({ scorers: [{ ...leader, playerSlug: null }] }, { scorers: [leader] }, 'getLeaders').differences).toContainEqual({ path: '$.scorers[0].playerSlug', category: 'link' });
    expect(compare({ playerId: 'canonical' }, {}, 'unknown').differences.length).toBeGreaterThan(0);
    const lineup = { lineups: { home: { players: [{ athleteId: '777', starter: null }] } } };
    const canonical = { lineups: { home: { players: [{ athleteId: '777', starter: null, playerId: 'canonical' }] } } };
    expect(compare(canonical, lineup, 'getMatchSummary').differences).toEqual([]);
  });

  it('normalizes only the documented nationality empty-to-null writer representation', () => {
    expect(compare([{ id: '777', nationality: null }], [{ id: '777', nationality: '' }], 'getSquad').differences).toEqual([]);
    expect(compare([{ id: '777', nationality: null }], [{ id: '777' }], 'getSquad').differences.length).toBeGreaterThan(0);
    expect(compare({ nationality: null }, { nationality: '' }, 'unknown').differences.length).toBeGreaterThan(0);
  });

  it('retains table ranks, leader order, roster order and game-log chronology', () => {
    const rows = [{ id: '1', rank: 1 }, { id: '2', rank: 2 }];
    expect(compare([{ id: 'group', standings: rows }], [{ id: 'group', standings: rows.toReversed() }], 'getStandings').differences.length).toBeGreaterThan(0);
    expect(compare({ scorers: rows }, { scorers: rows.toReversed() }, 'getLeaders').differences.length).toBeGreaterThan(0);
    expect(compare(rows, rows.toReversed(), 'getSquad').differences.length).toBeGreaterThan(0);
    expect(compare({ gameLog: rows }, { gameLog: rows.toReversed() }, 'getPlayer').differences.length).toBeGreaterThan(0);
  });

  it('normalizes group set order and bracket display labels without dropping table or match semantics', () => {
    const groups = [{ id: 'east', name: 'East', standings: [{ team: { id: '1' }, rank: 1 }] }, { id: 'west', name: 'West', standings: [{ team: { id: '2' }, rank: 1 }] }];
    expect(compare(groups.toReversed(), groups, 'getStandings').differences).toEqual([]);
    const bracket = [{ slug: 'final', matches: [match()] }];
    const result = compare([{ ...bracket[0], name: 'Final' }], bracket, 'getBracket');
    expect(result.differences).toEqual([]);
    expect(result.excluded).toContain('$[].name');
    expect(compare([{ ...groups[0], name: 'Different group' }], [groups[0]], 'getStandings').differences.length).toBeGreaterThan(0);
  });

  it('keeps unsupported held-profile projection differences visible instead of inventing equality', () => {
    const reader = { id: '777', headshotUrl: null, flagUrl: null, seasonLabel: '2026 World Cup', totals: [{ name: 'appearances', display: '5', value: 5 }], gameLog: [] };
    const espn = { ...reader, headshotUrl: 'https://example.com/player.png', seasonLabel: '2026 Stats', totals: [{ name: 'appearances', display: '5 (0)', value: 5 }], gameLog: [{ eventId: '1' }] };
    const result = compare(reader, espn, 'getPlayer');
    expect(result.differences).toEqual(expect.arrayContaining([
      { path: '$.headshotUrl', category: 'value' }, { path: '$.seasonLabel', category: 'value' },
      { path: '$.totals[0].display', category: 'value' }, { path: '$.gameLog.length', category: 'coverage' },
    ]));
    expect(result.excluded).toEqual([]);
  });

  it('normalizes exact game-log and head-to-head dates but leaves generic date fields untouched', () => {
    expect(compare({ gameLog: [{ date: '2026-06-29T17:00:00Z' }] }, { gameLog: [{ date: '2026-06-29T10:00-07:00' }] }, 'getPlayer').differences).toEqual([]);
    expect(compare({ h2h: [{ date: '2026-06-29T17:00:00Z' }] }, { h2h: [{ date: '2026-06-29T17:00Z' }] }, 'getMatchSummary').differences).toEqual([]);
    expect(compare({ date: '2026-06-29T17:00:00Z' }, { date: '2026-06-29T17:00Z' }, 'unknown').differences.length).toBeGreaterThan(0);
  });

  it('applies joined context policy while retaining target and generated link identity', () => {
    const original = { list: [match()], target: { id: '760487', homeId: '205', awayId: '627' }, summary: { stats: null } };
    const reader = { ...original, list: [{ ...match(), kickoff: '2026-06-29T17:00:00Z' }] };
    expect(compare(reader, original, 'listPopup').differences).toEqual([]);
    expect(compare({ ...reader, target: { ...reader.target, homeId: '627' } }, original, 'listPopup').differences).toContainEqual({ path: '$.target.homeId', category: 'side' });
    expect(compare({ links: { '777': 'wrong' } }, { links: { '777': 'right' } }, 'leaderLinks').differences).toContainEqual({ path: '$.links.<key>', category: 'link' });
  });

  it('compares unknown fields but never emits arbitrary keys, values or paths', () => {
    const secret = 'token=secret;SELECT credential FROM db';
    const result = compare({ [secret]: secret }, { [secret]: 'other' }, 'unknown');
    expect(result.differences).toEqual([{ path: '$.<field>', category: 'value' }]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(compare({ links: { [secret]: 'a' } }, { links: {} }, 'leaderLinks').differences).toEqual([{ path: '$.links.<key>', category: 'coverage' }]);
  });

  it('caps differences and marks output truncation', () => {
    const rows = Array.from({ length: 100 }, (_, index) => match(String(index)));
    const result = compare(rows.map(row => ({ ...row, homeScore: 3 })), rows);
    expect(result.differences).toHaveLength(64);
    expect(result.truncated).toBe(true);
    expect(result.differences.every(item => item.path.length <= 160)).toBe(true);
  });

  it('retains a late score difference after the detail cap fills with display differences', () => {
    const original = Array.from({ length: 100 }, (_, index) => ({ ...match(String(index).padStart(3, '0')), note: 'old' }));
    const reader = original.map(row => ({ ...row, note: 'new' }));
    reader[99].homeScore = 3;
    const result = compare(reader, original);
    expect(result.differences).toHaveLength(64);
    expect(result.truncated).toBe(true);
    expect(result.differences).toContainEqual({ path: '$[99].homeScore', category: 'score' });
  });

  it('retains coverage evidence alongside late attribution differences when details are capped', () => {
    const original = Array.from({ length: 100 }, (_, index) => match(String(index).padStart(3, '0')));
    const reader = original.map(row => ({ ...row, homeScore: 3 }));
    reader.push(match('999'));
    const result = compare(reader, original);
    expect(result.truncated).toBe(true);
    expect(result.differences.some(row => row.category === 'score')).toBe(true);
    expect(result.differences).toContainEqual({ path: '$.length', category: 'coverage' });
  });

  it('reports unavailable traversal evidence when the node bound prevents a full comparison', () => {
    const result = compare(Array.from({ length: 100_001 }, () => 0), Array.from({ length: 100_001 }, () => 0), 'unknown');
    expect(result.truncated).toBe(true);
    expect(result.differences).toContainEqual({ path: '$', category: 'coverage' });
  });

  it('does not certify equal objects when traversal exceeds its depth limit', () => {
    let reader: unknown = 1, espn: unknown = 1;
    for (let i = 0; i < 40; i++) { reader = { unknown: reader }; espn = { unknown: espn }; }
    const result = compare(reader, espn, 'unknown');
    expect(result.truncated).toBe(true);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0].category).toBe('coverage');
    expect(result.differences[0].path.length).toBeLessThanOrEqual(160);
  });
});

it('uses match policy for joined targets while preserving wrong side and score', () => {
  const target = { id: '1', kickoff: '2026-08-10T12:00Z', home: { id: '202' }, away: { id: '478' }, homeScore: 1, awayScore: 0 };
  const reader = { target: { ...target, kickoff: '2026-08-10T12:00:00.000Z', readerResources: { version: 1, resources: {} } } };
  expect(compareSemantic('listPopup', reader, { target }).differences).toEqual([]);
  const wrong = compareSemantic('listPopup', { target: { ...reader.target, home: { id: '999' }, homeScore: 2 } }, { target });
  expect(wrong.differences.map(d => d.category)).toEqual(expect.arrayContaining(['side', 'score']));
});

it('classifies the addressed player popup slug as a link difference', () => {
  expect(compareSemantic('playerPopup', { link: 'wrong-player' }, { link: 'right-player' }).differences)
    .toEqual([{ path: '$.link', category: 'link' }]);
});
