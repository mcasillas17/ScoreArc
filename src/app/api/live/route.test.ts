import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataStore } from '@/server/data/store';
import { listCompetitions } from '@/server/data/competitions';
import { trackAPIRequestFailure } from '@/lib/telemetry/server';
import type { Match } from '@/server/data/types';

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
    expect(trackAPIRequestFailure).toHaveBeenCalledWith('live', 502, expect.any(String), expect.any(String));
  });

  it('502s only when every competition fails', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockRejectedValue(new Error('upstream unavailable'));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it('never fetches a match summary', async () => {
    const spy = vi.spyOn(dataStore, 'getMatchSummary');
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    const { GET } = await import('./route');
    await GET();
    expect(spy).not.toHaveBeenCalled();
  });
});
