// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import FollowTeamButton from './FollowTeamButton';
import YourTeams from './YourTeams';
import { TEAM_FOLLOWS_KEY } from '@/lib/teamFollows';

vi.mock('next/navigation', () => ({ usePathname: () => '/en', useRouter: () => ({ push: vi.fn() }) }));
const america = { teamId: 'mex-america', competitionId: 'liga-mx', name: 'América' };
const documentValue = JSON.stringify({ version: 2, teams: [america] });
function Controls({ locale = 'en' }: { locale?: 'en' | 'es' }) {
  return <I18nProvider locale={locale}><FollowTeamButton {...america} /><YourTeams /></I18nProvider>;
}

beforeEach(() => {
  const dom = (globalThis as unknown as { jsdom: { window: Window } }).jsdom;
  vi.stubGlobal('localStorage', dom.window.localStorage);
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('hydrates saved follows without writing or hydration errors, and removal updates both controls', async () => {
  window.localStorage.setItem(TEAM_FOLLOWS_KEY, documentValue);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  const errors: unknown[] = [];
  const container = document.createElement('div');
  container.innerHTML = renderToString(<Controls />);
  expect(container.querySelector('button')?.getAttribute('aria-pressed')).toBe('false');
  document.body.appendChild(container);
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => { root = hydrateRoot(container, <Controls />, { onRecoverableError: (error) => errors.push(error) }); });
  expect(errors).toEqual([]);
  expect(write).not.toHaveBeenCalled();
  expect(screen.getByText('Saved in this browser. Links open the current season.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Following América. Unfollow América' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('link', { name: 'América' }).getAttribute('href')).toBe('/en/c/liga-mx/2026-apertura/team/mex-america#performance');
  fireEvent.click(screen.getByRole('button', { name: 'Remove América' }));
  expect(screen.getByRole('button', { name: 'Follow América' }).getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByRole('link', { name: 'América' })).toBeNull();
  await act(async () => root.unmount());
  container.remove();
});

it('follows and unfollows with pressed state, and reroutes the same stored team when locale changes', () => {
  const { rerender } = render(<Controls />);
  expect(screen.queryByText('Saved in this browser. Links open the current season.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Follow América' }));
  expect(screen.getByRole('button', { name: 'Following América. Unfollow América' }).getAttribute('aria-pressed')).toBe('true');
  rerender(<Controls locale="es" />);
  expect(screen.getByRole('link', { name: 'América' }).getAttribute('href')).toBe('/es/c/liga-mx/2026-apertura/team/mex-america#performance');
  expect(JSON.parse(window.localStorage.getItem(TEAM_FOLLOWS_KEY)!)).toEqual({ version: 2, teams: [america] });
  fireEvent.click(screen.getByRole('button', { pressed: true }));
  expect(screen.queryByRole('link', { name: 'América' })).toBeNull();
});

it('shows persistence failure while both mounted consumers retain a usable session follow', () => {
  render(<Controls />);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  fireEvent.click(screen.getByRole('button', { name: 'Follow América' }));
  expect(screen.getByRole('link', { name: 'América' })).toBeTruthy();
  expect(screen.queryByText('Saved in this browser. Links open the current season.')).toBeNull();
  expect(screen.getAllByRole('status').every((notice) => notice.textContent?.includes('session'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Following América. Unfollow América' }));
  expect(screen.queryByRole('link', { name: 'América' })).toBeNull();
});
