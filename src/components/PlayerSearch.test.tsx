// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import PlayerSearch from './PlayerSearch';
vi.mock('next/navigation', () => ({ usePathname: () => '/en/c/liga-mx/2026-apertura/players', useRouter: () => ({ push: vi.fn() }) }));
// Observe Next's prefetch prop; browser validation checks the actual network.
vi.mock('next/link', () => ({ default: ({ prefetch, children, ...props }: React.ComponentProps<'a'> & { prefetch?: boolean }) =>
  <a {...props} data-prefetch={String(prefetch)}>{children}</a> }));
afterEach(cleanup);
const players = [
  { name: 'Alí Ávila', slug: 'ali-avila', teamName: 'Querétaro', teamAbbr: 'QRO', teamId: 'qro', crestUrl: null },
  { name: 'Martin Ødegaard', slug: 'martin-odegaard', teamName: 'Arsenal', teamAbbr: 'ARS', teamId: 'ars', crestUrl: null },
  { name: 'Same Name', slug: null, teamName: 'América', teamAbbr: 'AME', teamId: 'ame', crestUrl: null },
];
it.each(['en', 'es'] as const)('searches accents and teams locally with singular %s profile links', locale => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  render(<I18nProvider locale={locale}><PlayerSearch players={players} playerBase={`/${locale}/c/liga-mx/2026-apertura/player`} /></I18nProvider>);
  const input = screen.getByRole('searchbox', { name: locale === 'en' ? 'Search players or teams' : 'Buscar jugadores o equipos' });
  fireEvent.change(input, { target: { value: 'ali avila' } });
  expect(screen.getByRole('link', { name: 'Alí Ávila' }).getAttribute('href')).toBe(`/${locale}/c/liga-mx/2026-apertura/player/ali-avila`);
  expect(screen.getByRole('link').getAttribute('data-prefetch')).toBe('false');
  expect(screen.queryByText('Martin Ødegaard')).toBeNull();
  fireEvent.change(input, { target: { value: 'ODEGAARD' } });
  expect(screen.getByRole('link', { name: 'Martin Ødegaard' })).toBeTruthy();
  fireEvent.change(input, { target: { value: '  queretaro  ' } });
  expect(screen.getByRole('link', { name: 'Alí Ávila' })).toBeTruthy();
  fireEvent.change(input, { target: { value: 'no matching player' } });
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('0');
  fireEvent.change(input, { target: { value: '' } });
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.queryByRole('link', { name: 'Same Name' })).toBeNull();
  expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent?.replace(/^[A-Z]{3}/, ''))).toEqual(['América', 'Arsenal', 'Querétaro']);
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
});
