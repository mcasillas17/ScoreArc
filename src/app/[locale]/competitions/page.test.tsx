// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import * as registry from '@/server/data/competitions';
import Directory from './page';

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/competitions',
  useRouter: () => ({ push: vi.fn() }),
}));
const read = vi.hoisted(() => vi.fn());
vi.mock('@/server/data/store', () => ({ dataStore: new Proxy({}, { get: () => read }) }));

it('groups each published landing edition once using only the registry, including archive, youth and college', async () => {
  const base = registry.COMPETITIONS['world-cup'];
  const archive = {
    ...base, id: 'womens-world-cup', name: "Women's World Cup", category: 'women', currentSeasonId: '2023',
    seasons: { '2023': { ...base.seasons['2022'], id: '2023', publication: 'archive' } },
  } satisfies registry.Competition;
  const sample = [
    registry.COMPETITIONS['liga-mx'], registry.COMPETITIONS['liga-mx-femenil'], archive,
    ...(['club-cup', 'youth', 'college'] as const).map(directoryGroup => ({
      ...archive, id: directoryGroup, name: directoryGroup, directoryGroup,
    })),
  ];
  vi.spyOn(registry, 'listCompetitions').mockReturnValue(sample);
  try {
    const page = await Directory({ params: { locale: 'en' }, searchParams: { view: 'women' } });
    const main = document.createElement('div');
    main.innerHTML = renderToStaticMarkup(<I18nProvider locale="en">{page}</I18nProvider>);
    const sections = [...main.querySelectorAll('section')];
    const links = (element: Element) => [...element.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(sections.map(section => [section.querySelector('h2')?.textContent, links(section)])).toEqual([
      ['Domestic leagues', ['/en/c/liga-mx-femenil/2026-apertura']],
      ['Club cups', ['/en/c/club-cup/2023']],
      ['National teams', ['/en/c/womens-world-cup/2023']],
      ['Youth and college', ['/en/c/college/2023', '/en/c/youth/2023']],
    ]);
    expect(read).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
