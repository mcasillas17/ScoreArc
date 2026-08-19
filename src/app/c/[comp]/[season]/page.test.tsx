import { describe, expect, it, vi, afterEach } from 'vitest';
import { redirect } from 'next/navigation';
import { dataStore } from '@/server/data/store';
import Workspace from './page';

// The real redirect() aborts rendering by throwing. A no-op mock would let
// execution fall through into the bracket path and quietly invert the
// "redirects before fetching anything" assertion below.
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT'); }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));

afterEach(() => vi.clearAllMocks());

describe('competition season root', () => {
  // A league's headline view is its table, and the table lives at /standings
  // for every competition. Rendering a second copy here is what left the old
  // /standings page an orphan that quietly lacked the Liguilla dial.
  it('redirects a league to its standings page', async () => {
    await expect(
      Workspace({ params: { comp: 'liga-mx', season: '2026-apertura' } }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/c/liga-mx/2026-apertura/standings');
  });

  it('redirects before fetching anything', async () => {
    const getMatches = vi.spyOn(dataStore, 'getMatches');
    const getStandings = vi.spyOn(dataStore, 'getStandings');
    await expect(
      Workspace({ params: { comp: 'premier-league', season: '2026-27' } }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(getMatches).not.toHaveBeenCalled();
    expect(getStandings).not.toHaveBeenCalled();
  });

  // A cup's root is its bracket, so it must not redirect.
  it('leaves a knockout competition on its bracket', async () => {
    vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getBracket').mockResolvedValue([]);
    await Workspace({ params: { comp: 'world-cup', season: '2026' } });
    expect(redirect).not.toHaveBeenCalled();
  });
});
