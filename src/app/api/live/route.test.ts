import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataStore } from '@/server/data/store';
import { listCompetitions } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import type { Match } from '@/server/data/types';
import { ENTRIES_PER_BUCKET } from '@/server/data/liveFeed';

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

vi.mock('@/lib/telemetry/server', () => ({ trackAPIRequestFailure: vi.fn() }));

function match(id: string, kickoff: string): Match {
  return {
    id, kickoff, state: 'scheduled', minute: null, statusDetail: '', statusName: '',
    home: { id: 'h', name: 'Home', abbr: 'HOM', crestUrl: null },
    away: { id: 'a', name: 'Away', abbr: 'AWY', crestUrl: null },
    homeScore: null, awayScore: null, winnerId: null, note: null,
    scorers: [], cards: [], shootout: null, shootoutDetail: null,
    stats: null, winProbability: null,
  } as Match;
}

describe('GET /api/live', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('labels every match with its competition', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('m1', '2026-08-20T00:00:00Z')]);
    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(listCompetitions().length);
    expect(body[0].competition.id).toBeTruthy();
    expect(body[0].competition.emblem).toBeTruthy();
    expect(body[0].match.id).toBe('m1');
  });

  it('returns entries sorted by kickoff across competitions', async () => {
    let n = 0;
    vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(async () => {
      n += 1;
      // Later competitions return earlier kickoffs, so an unsorted merge
      // would come back in competition order rather than time order.
      return [match(`m${n}`, new Date(Date.UTC(2026, 7, 30 - n)).toISOString())];
    });
    const { GET } = await import('./route');
    const body = await (await GET()).json();
    const times = body.map((e: { match: Match }) => new Date(e.match.kickoff).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  // One dead feed means one competition missing from the band, not a dead band.
  it('returns 200 with the surviving competitions when one feed fails', async () => {
    let first = true;
    vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(async () => {
      if (first) { first = false; throw new Error('upstream unavailable'); }
      return [match('ok', '2026-08-20T00:00:00Z')];
    });
    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(listCompetitions().length - 1);
    // 200, not 502: the response succeeded for the other eight competitions.
    // Recording 502 here would put an outage in the dashboard that no reader
    // experienced.
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('live', 200, expect.any(String), expect.any(String));
  });

  it('502s only when every competition fails', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockRejectedValue(new Error('upstream unavailable'));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(502);
  });

  // The merge is capped so a six-row band does not ship a three-week window.
  it('caps how many entries cross the wire', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      match(`m${i}`, new Date(Date.UTC(2026, 7, 20, i % 24)).toISOString()),
    );
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue(many);
    const { GET } = await import('./route');
    const body = await (await GET()).json();
    expect(body.length).toBeLessThanOrEqual(ENTRIES_PER_BUCKET * 3);
  });

  // The band renders "Live now · N" from what it receives, so capping live
  // entries would make that count wrong -- "Live now · 12" on a Saturday when
  // fifteen are in play. Only the other two buckets are trimmed.
  it('never caps live matches, whatever the window holds', async () => {
    const live = Array.from({ length: 20 }, (_, i) => ({
      ...match(`live${i}`, new Date(Date.UTC(2026, 7, 19, 12)).toISOString()),
      state: 'live' as const,
    }));
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue(live);
    const { GET } = await import('./route');
    const body = await (await GET()).json();
    expect(body.filter((e: { match: Match }) => e.match.state === 'live').length)
      .toBeGreaterThan(ENTRIES_PER_BUCKET);
  });

  it('never fetches a match summary', async () => {
    const spy = vi.spyOn(dataStore, 'getMatchSummary');
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    const { GET } = await import('./route');
    await GET();
    expect(spy).not.toHaveBeenCalled();
  });
});
