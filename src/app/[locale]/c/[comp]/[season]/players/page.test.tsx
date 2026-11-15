import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { competitionPlayerIndex } from '@/server/data/playerIndex';
import Page, { generateMetadata } from './page';
vi.mock('@/server/data/playerIndex', () => ({ competitionPlayerIndex: vi.fn() }));
vi.mock('@/components/PlayerSearch', () => ({ default: () => <div>Search results</div> }));
vi.mock('@/components/SiteFooter', () => ({ default: () => null }));
afterEach(() => vi.resetAllMocks());
const params = { locale: 'en', comp: 'world-cup', season: '2026' };
function index(totalTeams: number, teamsWithRoster: number) {
  vi.mocked(competitionPlayerIndex).mockResolvedValue({ bySlug: new Map(), byProvider: new Map(),
    directory: { totalTeams, teamsWithRoster, players: teamsWithRoster ? [{ name: 'Alí Ávila', slug: 'ali-avila', teamName: 'Mexico', teamAbbr: 'MEX', teamId: 'nat-mex', crestUrl: null }] : [] } });
}
describe('player directory page', () => {
  it('does not fetch historical rosters and links to the current localized directory', async () => {
    const html = renderToStaticMarkup(await Page({ params: { ...params, locale: 'es', season: '2018' } }));
    expect(competitionPlayerIndex).not.toHaveBeenCalled();
    expect(html).toContain('No hay plantillas históricas');
    expect(html).toContain('/es/c/world-cup/2026/players');
    expect(html).not.toContain('Search results');
  });
  it('describes the supported scope in metadata without loading any players', async () => {
    const current = await generateMetadata({ params });
    const old = await generateMetadata({ params: { ...params, season: '2018' } });
    expect(current.description).toContain('Current rosters');
    expect(old.description).toContain('Historical player rosters are not available');
    expect(old.alternates?.canonical).toBe('/en/c/world-cup/2018/players');
    expect(competitionPlayerIndex).not.toHaveBeenCalled();
  });
  it('distinguishes empty membership, unavailable rosters and partial coverage', async () => {
    index(0, 0);
    expect(renderToStaticMarkup(await Page({ params }))).toContain('No teams listed for this season yet.');
    index(2, 0);
    const unavailable = renderToStaticMarkup(await Page({ params }));
    expect(unavailable).toContain('No roster data is available right now.');
    expect(unavailable).not.toContain('Search results');
    index(2, 2);
    expect(renderToStaticMarkup(await Page({ params }))).not.toContain('Roster data from');
    index(2, 1);
    const partial = renderToStaticMarkup(await Page({ params }));
    expect(partial).toContain('Roster data from 1 of 2 listed teams');
    expect(partial).toContain('Search results');
  });
  it('renders an explicit unavailable state after both-source failure', async () => {
    vi.mocked(competitionPlayerIndex).mockRejectedValue(new Error('both sources exhausted'));
    const html = renderToStaticMarkup(await Page({ params }));
    expect(html).toContain('The player directory is unavailable right now.');
    expect(html).not.toContain('No teams listed');
    expect(html).not.toContain('Search results');
  });
});


it.each(['en', 'es'])('shares truthful current and historical directory metadata in %s', async locale => {
  for (const season of ['2026', '2018']) {
    const meta = await generateMetadata({ params: { ...params, locale, season } });
    expect(meta.openGraph).toMatchObject({ title: meta.title, description: meta.description });
    expect(meta.twitter).toMatchObject({ title: meta.title, description: meta.description });
    expect(meta.openGraph?.images).toEqual([expect.objectContaining({ url: expect.stringContaining('compId=world-cup') })]);
    expect(meta.openGraph?.images).toEqual([expect.objectContaining({ url: expect.stringContaining(`locale=${locale}`) })]);
  }
});
