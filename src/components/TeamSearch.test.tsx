// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TeamsPage from '@/app/[locale]/teams/page';
import CompetitionTeamsPage from '@/app/[locale]/c/[comp]/[season]/teams/page';
import { I18nProvider } from '@/i18n/I18nProvider';
import { TEAM_FOLLOWS_KEY } from '@/lib/teamFollows';
import { dataStore } from '@/server/data/store';
import type { SearchParams } from './ViewLinks';

vi.mock('@/server/data/store', () => ({ dataStore: { getEditionTeams: vi.fn() } }));
vi.mock('@/components/SiteFooter', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

beforeEach(() => {
  const dom = (globalThis as unknown as { jsdom: { window: Window } }).jsdom;
  vi.stubGlobal('localStorage', dom.window.localStorage);
  window.localStorage.clear();
  window.history.replaceState(null, '', '/en/teams');
  const america = { id: '227', name: 'América', abbr: 'AME', crestUrl: null };
  vi.mocked(dataStore.getEditionTeams).mockImplementation(async ({ competition }) => {
    if (competition.id === 'liga-mx') return [america];
    if (competition.id === 'liga-mx-femenil') return [{ ...america, id: '22415' }];
    if (competition.id === 'nwsl') return [{ ...america, id: '15364', name: 'Gotham FC', abbr: 'GFC' }];
    return [];
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function page(searchParams: SearchParams, locale: 'en' | 'es' = 'en') {
  return <I18nProvider locale={locale}>{await TeamsPage({ params: { locale }, searchParams })}</I18nProvider>;
}
const letters = () => [...document.querySelectorAll<HTMLElement>('[data-team-letter]')]
  .map(el => [el.dataset.teamLetter, el.id]);

it('filters a cold-open query and keeps edited text and unrelated parameters in category links and history', async () => {
  window.history.replaceState(null, '', '/en/teams?q=Gotham&tag=one&tag=two#results');
  render(await page({ q: 'Gotham', tag: ['one', 'two'] }));
  const input = screen.getByRole<HTMLInputElement>('searchbox');
  expect(input.value).toBe('Gotham');
  expect(letters()).toEqual([['G', 'ts-G']]);
  const reads = vi.mocked(dataStore.getEditionTeams).mock.calls.length;
  fireEvent.change(input, { target: { value: 'América' } });
  expect(letters()).toEqual([['A', 'ts-A']]);
  expect(new URLSearchParams(window.location.search).get('q')).toBe('América');
  expect(window.location.hash).toBe('#results');
  const women = new URL(screen.getByRole<HTMLAnchorElement>('link', { name: 'Women' }).href);
  expect(women.searchParams.get('q')).toBe('América');
  expect(women.searchParams.getAll('tag')).toEqual(['one', 'two']);
  expect(women.searchParams.getAll('view')).toEqual(['women']);
  fireEvent.change(input, { target: { value: 'missing' } });
  expect(screen.getByText('No team by that name.')).toBeTruthy();
  expect(letters()).toEqual([]);
  window.history.replaceState(null, '', '/en/teams?q=gotham&tag=one&tag=two');
  fireEvent.popState(window);
  expect(input.value).toBe('gotham');
  expect(letters()).toEqual([['G', 'ts-G']]);
  fireEvent.change(input, { target: { value: '' } });
  expect(new URLSearchParams(window.location.search).has('q')).toBe(false);
  expect(dataStore.getEditionTeams).toHaveBeenCalledTimes(reads);
});

it('keeps focus on the category link and permanently clears a chip excluded by that category', async () => {
  const { rerender } = render(await page({}));
  fireEvent.click(screen.getByRole('button', { name: 'Liga MX' }));
  expect(screen.queryByRole('link', { name: /Gotham/ })).toBeNull();
  const women = screen.getByRole('link', { name: 'Women' });
  women.focus();
  rerender(await page({ view: 'women' }));
  expect(document.activeElement).toBe(women);
  expect(screen.getByRole('link', { name: 'Women' })).toBe(women);
  expect(screen.queryByRole('button', { name: 'Liga MX' })).toBeNull();
  expect(screen.getByRole('link', { name: /Gotham/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'All competitions' }).getAttribute('aria-pressed')).toBe('true');
  rerender(await page({}));
  expect(screen.getByRole('button', { name: 'Liga MX' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'NWSL' }));
  rerender(await page({ view: 'women' }));
  expect(screen.getByRole('button', { name: 'NWSL' }).getAttribute('aria-pressed')).toBe('true');
});

it('gives each América its own canonical search result and follow action in Spanish', async () => {
  window.history.replaceState(null, '', '/es/teams?q=america');
  render(await page({ q: 'america' }, 'es'));
  for (const [comp, team, label] of [
    ['liga-mx', 'mex-america', /América.*Liga MX$/],
    ['liga-mx-femenil', 'mex-w-america', /América.*Liga MX Femenil$/],
  ] as const) {
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(`/es/c/${comp}/2026-apertura/team/${team}`);
    const follow = screen.getByRole('button', { name: label });
    fireEvent.click(follow);
    expect(follow.getAttribute('aria-pressed')).toBe('true');
  }
  const saved = JSON.parse(window.localStorage.getItem(TEAM_FOLLOWS_KEY)!);
  expect(saved.teams).toEqual([
    { teamId: 'mex-america', competitionId: 'liga-mx', name: 'América' },
    { teamId: 'mex-w-america', competitionId: 'liga-mx-femenil', name: 'América' },
  ]);
});

it.each([['liga-mx-femenil', 'women'], ['liga-mx', 'men']])('opens team discovery from %s in its own category', async (comp, category) => {
  render(<I18nProvider locale="es">{await CompetitionTeamsPage({ params: { locale: 'es', comp, season: '2026-apertura' } })}</I18nProvider>);
  expect(screen.getByRole('link', { name: /Buscar/ }).getAttribute('href')).toBe('/es/teams?view=' + category);
});
