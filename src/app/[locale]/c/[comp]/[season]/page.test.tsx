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
      Workspace({ params: { locale: 'en', comp: 'liga-mx', season: '2026-apertura' } }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/en/c/liga-mx/2026-apertura/standings');
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
  it('localizes a predicted champion title and preserves locale in canonical alternatives', async () => {
    const metadata = await generateMetadata({
      params: { locale: 'es', comp: 'world-cup', season: '2026' },
      searchParams: { c: 'MEX', name: 'México' },
    });

    expect(metadata).toMatchObject({
      title: 'Mi campeón de World Cup: México 🏆',
      alternates: {
        canonical: '/es/c/world-cup/2026?c=MEX&name=M%C3%A9xico',
        languages: {
          en: '/en/c/world-cup/2026?c=MEX&name=M%C3%A9xico',
          es: '/es/c/world-cup/2026?c=MEX&name=M%C3%A9xico',
        },
      },
      openGraph: { title: 'Mi campeón de World Cup: México 🏆' },
      twitter: { title: 'Mi campeón de World Cup: México 🏆' },
    });
  });
});
