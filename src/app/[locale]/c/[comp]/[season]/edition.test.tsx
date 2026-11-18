// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as registry from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import { I18nProvider } from '@/i18n/I18nProvider';
import Page from './page';

vi.mock('next/navigation', () => ({ usePathname: () => '/en/c/leagues-cup/2026', useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps archived computed standings readable without live polling or unsupported detail links', async () => {
  const rc = registry.resolveSeason('leagues-cup', '2026')!;
  vi.spyOn(registry, 'resolveSeason').mockReturnValue({ ...rc, season: { ...rc.season, publication: 'archive', resources: ['standings', 'bracket'] } });
  vi.spyOn(dataStore, 'getBracket').mockResolvedValue([]);
  vi.spyOn(dataStore, 'getStandings').mockResolvedValue([{
    id: 'table', name: 'Group', standings: [{
      team: { id: '227', name: 'América', abbr: 'AME', crestUrl: null }, rank: 1,
      played: 3, wins: 3, draws: 0, losses: 0, goalsFor: 7, goalsAgainst: 1,
      goalDifference: 6, points: 9, advanced: true,
    }],
  }]);
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
  vi.stubGlobal('fetch', fetcher);
  vi.useFakeTimers();
  const node = await Page({ params: { locale: 'en', comp: 'leagues-cup', season: '2026' } });
  const { container } = render(<I18nProvider locale="en">{node}</I18nProvider>);
  expect(container.textContent).toContain('América');
  expect(container.querySelector('a[href*="/team/"]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
  expect(fetcher).not.toHaveBeenCalled();
});
