import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { redirect } from 'next/navigation';
import { dataStore } from '@/server/data/store';
import { I18nProvider } from '@/i18n/I18nProvider';
import Workspace, { generateMetadata } from './page';

// The real redirect() aborts rendering by throwing. A no-op mock would let
// execution fall through into the bracket path and quietly invert the
// "redirects before fetching anything" assertion below.
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT'); }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  usePathname: () => '/es/c/world-cup/2026',
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => vi.clearAllMocks());

describe('competition season root', () => {
  // A league's headline view is its table, and the table lives at /standings
  // for every competition. Rendering a second copy here is what left the old
  // /standings page an orphan that quietly lacked the Liguilla dial.
  it('redirects a league to its standings page', async () => {
    await expect(
      Workspace({ params: { locale: 'en', comp: 'premier-league', season: '2026-27' } }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/en/c/premier-league/2026-27/standings');
  });

  // Liga MX's root is the projected Liguilla, not a redirect: quarters pair
  // 1v8, 2v7, 3v6, 4v5 (emitted in ring order 1v8/4v5/2v7/3v6) from the live
  // table, semis and final as placeholders.
  it('renders the projected Liguilla for Liga MX instead of redirecting', async () => {
    vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getStandings').mockResolvedValue([
      {
        id: 'general', name: 'General',
        standings: Array.from({ length: 18 }, (_, i) => ({
          team: { id: String(100 + i + 1), name: `Club ${i + 1}`, abbr: `T${i + 1}`, crestUrl: null },
          rank: i + 1, played: 7, wins: 0, draws: 0, losses: 0,
          goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
        })),
      } as never,
    ]);
    const node = await Workspace({ params: { locale: 'es', comp: 'liga-mx', season: '2026-apertura' } });
    const html = renderToStaticMarkup(<I18nProvider locale="es">{node}</I18nProvider>);
    expect(redirect).not.toHaveBeenCalled();
    expect(html).toContain('Liguilla hoy');
    expect(html).toContain('Si la Liguilla empezara hoy');
    expect(html).toContain('T1');
    // The interactive shell ships with it: predict mode is open on a
    // projection (quarters fully seeded), so the tabs render server-side.
    expect(html).toContain('Arma tu cuadro');
    expect(html).toContain('Proyección');
    expect(html).not.toContain('Resultados en vivo');
  });

  // Standings down => the honest empty state, never a fabricated bracket.
  it('shows the unavailable state when the projection cannot build', async () => {
    vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getStandings').mockRejectedValue(new Error('502'));
    const node = await Workspace({ params: { locale: 'es', comp: 'liga-mx', season: '2026-apertura' } });
    const html = renderToStaticMarkup(<I18nProvider locale="es">{node}</I18nProvider>);
    expect(html).toContain('El cuadro no está disponible en este momento.');
    expect(html).not.toContain('Bracket data is unavailable right now.');
  });

  it('redirects before fetching anything', async () => {
    const getMatches = vi.spyOn(dataStore, 'getMatches');
    const getStandings = vi.spyOn(dataStore, 'getStandings');
    await expect(
      Workspace({ params: { locale: 'en', comp: 'premier-league', season: '2026-27' } }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(getMatches).not.toHaveBeenCalled();
    expect(getStandings).not.toHaveBeenCalled();
  });

  // A cup's root is its bracket, so it must not redirect.
  it('leaves a knockout competition on its bracket', async () => {
    vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getBracket').mockResolvedValue([]);
    await Workspace({ params: { locale: 'en', comp: 'world-cup', season: '2026' } });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('renders the Spanish bracket heading and unavailable state without English fallback', async () => {
    vi.spyOn(dataStore, 'getMatches').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getUpcoming').mockResolvedValue([]);
    vi.spyOn(dataStore, 'getBracket').mockResolvedValue([]);
    const node = await Workspace({ params: { locale: 'es', comp: 'world-cup', season: '2026' } });
    const html = renderToStaticMarkup(<I18nProvider locale="es">{node}</I18nProvider>);

    expect(html).toContain('Cuadro de eliminatorias');
    expect(html).toContain('El cuadro no está disponible en este momento.');
    expect(html).not.toContain('Knockout Bracket');
    expect(html).not.toContain('Bracket data is unavailable right now.');
  });
});

describe('competition bracket metadata', () => {
  it.each([
    {
      locale: 'en' as const,
      title: 'My World Cup champion: México 🏆',
      description: 'México is my pick to win World Cup. Build your bracket on ScoreArc.',
    },
    {
      locale: 'es' as const,
      title: 'Mi campeón de World Cup: México 🏆',
      description: 'México es mi elección para ganar World Cup. Arma tu cuadro en ScoreArc.',
    },
  ])('localizes predicted-champion metadata in $locale without changing share URLs', async ({ locale, title, description }) => {
    const metadata = await generateMetadata({
      params: { locale, comp: 'world-cup', season: '2026' },
      searchParams: { c: 'MEX', name: 'México' },
    });

    expect(metadata).toMatchObject({
      title,
      description,
      alternates: {
        canonical: `/${locale}/c/world-cup/2026?c=MEX&name=M%C3%A9xico`,
        languages: {
          en: '/en/c/world-cup/2026?c=MEX&name=M%C3%A9xico',
          es: '/es/c/world-cup/2026?c=MEX&name=M%C3%A9xico',
        },
      },
      openGraph: {
        title,
        description,
        images: [{
          url: `/api/og?champ=MEX&name=M%C3%A9xico&compId=world-cup&comp=World+Cup+2026&locale=${locale}&v=3`,
          width: 1200,
          height: 630,
        }],
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [`/api/og?champ=MEX&name=M%C3%A9xico&compId=world-cup&comp=World+Cup+2026&locale=${locale}&v=3`],
      },
    });
  });
});
