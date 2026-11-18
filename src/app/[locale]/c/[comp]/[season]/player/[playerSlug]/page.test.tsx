import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPlayerBySlug } from '@/server/data/playerIndex';
import { I18nProvider } from '@/i18n/I18nProvider';
import Page, { generateMetadata } from './page';

vi.mock('@/server/data/playerIndex', () => ({ loadPlayerBySlug: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/es/c/liga-mx-femenil/2026-apertura/player/sarah-luebbert', useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
afterEach(() => vi.clearAllMocks());

it.each(['en', 'es'] as const)('preserves the edition and canonical women’s team when the player has no portrait in %s', async locale => {
  vi.mocked(loadPlayerBySlug).mockResolvedValue({
    id: 'test-player', name: 'Sarah Luebbert', headshotUrl: null, age: null, position: '', jersey: null,
    nationality: null, flagUrl: null, seasonLabel: 'Apertura 2026', totals: [], gameLogLabel: '', gameLog: [], career: [],
    team: { id: '22415', name: 'América', abbr: 'AME', crestUrl: null },
  });
  const params = { locale, comp: 'liga-mx-femenil', season: '2026-apertura', playerSlug: 'sarah-luebbert' };
  const html = renderToStaticMarkup(<I18nProvider locale={locale}>{await Page({ params })}</I18nProvider>);
  expect(html).toContain('class="ph-initials">SL');
  expect(html).not.toContain('ph-headshot');
  expect(html).toContain(`/${locale}/c/liga-mx-femenil/2026-apertura/team/mex-w-america`);
  const metadata = await generateMetadata({ params });
  expect(metadata.title).toBe('Sarah Luebbert · Liga MX Femenil Apertura 2026');
  expect(metadata.alternates?.canonical).toBe(`/${locale}/c/liga-mx-femenil/2026-apertura/player/sarah-luebbert`);
  expect(metadata.openGraph?.images).toEqual([expect.objectContaining({ url: expect.stringContaining('compId=liga-mx-femenil&') })]);
});
