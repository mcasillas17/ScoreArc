// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { COMPETITIONS } from '@/server/data/competitions';
import { I18nProvider } from '@/i18n/I18nProvider';
import SeasonSwitcher from './SeasonSwitcher';

vi.mock('next/navigation', () => ({ usePathname: () => '/es/c/liga-mx/2026-apertura', useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);

it('keeps phased editions in the same year separately reachable with their real labels', () => {
  const base = COMPETITIONS['liga-mx'];
  const apertura = { ...base.seasons['2026-apertura'], startsAt: '2026-07-01T00:00:00Z' };
  const clausura = { ...apertura, id: '2026-clausura', label: 'Clausura 2026', startsAt: '2026-01-01T00:00:00Z' };
  render(<I18nProvider locale="es"><SeasonSwitcher competition={{ ...base, seasons: { [apertura.id]: apertura, [clausura.id]: clausura } }} activeSeasonId={apertura.id} /></I18nProvider>);
  const newest = screen.getByRole('link', { name: 'Apertura 2026' });
  const older = screen.getByRole('link', { name: 'Clausura 2026' });
  expect(newest.getAttribute('href')).toBe('/es/c/liga-mx/2026-apertura');
  expect(older.getAttribute('href')).toBe('/es/c/liga-mx/2026-clausura');
  expect(newest.style.left).not.toBe(older.style.left);
  expect(newest.style.left).toBe('0%');
  expect(newest.getAttribute('aria-current')).toBe('page');
});
