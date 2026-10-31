// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { Group, Match, Standing, Team } from '@/server/data/types';
import type { StandingsForm } from '@/server/data/standingsForm';
import { trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import StandingsLive from './StandingsLive';

vi.mock('@/lib/telemetry/client', () => ({ trackEvent: vi.fn(), trackFeedFailure: vi.fn(), trackFeedRecovery: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/en/c/mls/2026/standings', useRouter: () => ({ push: vi.fn() }) }));

const API = '/api/mls/2026';
const team = (id: string, name: string): Team => ({ id, name, abbr: id.toUpperCase(), crestUrl: null });
const austin = team('a', 'Austin FC');
const boston = team('b', 'Boston City');
const row = (t: Team, played = 2): Standing => ({ team: t, rank: 1, played, wins: 1, draws: 0, losses: 1, goalsFor: 2,
  goalsAgainst: 2, goalDifference: 0, points: 3, advanced: false });
const match = (id: string, home: Team, away: Team, homeScore: number, awayScore: number): Match => ({
  id, scope: { competitionId: 'mls', seasonId: '2026' }, kickoff: '2026-10-11T12:00:00Z', state: 'finished', minute: null, statusDetail: 'FT',
  statusName: 'STATUS_FULL_TIME', home, away, homeScore, awayScore, winnerId: null, note: null, scorers: [], cards: [], shootout: null,
  shootoutDetail: null, stats: null, winProbability: null });
const form: StandingsForm = {
  scope: 'regular-season',
  matches: [match('m2', boston, austin, 0, 2), match('m1', austin, boston, 1, 1)],
  teams: {
    a: { status: 'available', results: [{ matchId: 'm2', result: 'W' }, { matchId: 'm1', result: 'D' }] },
    b: { status: 'available', results: [{ matchId: 'm2', result: 'L' }, { matchId: 'm1', result: 'D' }] },
  },
};
const groups: Group[] = [
  { id: 'east', name: 'East', standings: [row(austin)] },
  { id: 'west', name: 'West', standings: [row(boston)] },
  { id: 'shield', name: 'Shield', standings: [row(austin), row(boston)] },
];

const third = (id: string, t: Team): Group => ({ id, name: id, standings: [
  { ...row(team(`${id}1`, `${id} one`)), rank: 1 }, { ...row(team(`${id}2`, `${id} two`)), rank: 2 }, { ...row(t), rank: 3 }] });

let formResponses: unknown[];
let fetcher: ReturnType<typeof vi.fn>;
const formCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/standings/form'));
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

beforeEach(() => {
  formResponses = [];
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/standings/form')) {
      const next = formResponses.length ? formResponses.shift() : form;
      if (next instanceof Error) throw next;
      return next === 'fail' ? json({ error: { code: 'UPSTREAM_UNAVAILABLE' } }, false, 502) : json(next);
    }
    if (url.includes('/match/')) return json({ scorers: [] });
    if (url.endsWith('/standings')) return json(groups);
    return json([]);
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function mount(locale: 'en' | 'es' = 'en', tables = groups) {
  return render(<I18nProvider locale={locale}>
    <StandingsLive initialGroups={tables} initialScorers={[]} initialAssists={[]} apiBase={API} teamStyle="crest" showThirdPlace={false}
      teamBase="/en/c/mls/2026/team" playerBase="/en/c/mls/2026/player" />
  </I18nProvider>);
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

it('serves every table from one shared load and requests no summary before a click', async () => {
  mount();
  await waitFor(() => expect(screen.getAllByRole('list', { name: /Austin FC/ })).toHaveLength(2));
  expect(formCalls()).toHaveLength(1);
  expect(screen.getAllByRole('list', { name: /Boston City/ })).toHaveLength(2);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/match/'))).toBe(false);
});

it('names result, opponent, score and date on a keyboard-reachable newest-first badge', async () => {
  mount();
  const list = (await screen.findAllByRole('list', { name: /Austin FC/ }))[0];
  const buttons = within(list).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(['W', 'D']);
  expect(buttons[0].tagName).toBe('BUTTON');
  expect(buttons[0].getAttribute('aria-label')).toMatch(/Win.*Boston City.*2–0.*Oct/);
});

it('localizes the badge in Spanish', async () => {
  mount('es');
  const list = (await screen.findAllByRole('list', { name: /Austin FC/ }))[0];
  const first = within(list).getAllByRole('button')[0];
  expect(first.textContent).toBe('G');
  expect(first.getAttribute('aria-label')).toMatch(/Ganado.*Boston City.*2–0/);
});

it('opens the match in the competition scope with its real sides only when clicked', async () => {
  mount();
  const list = (await screen.findAllByRole('list', { name: /Austin FC/ }))[0];
  await act(async () => { fireEvent.click(within(list).getAllByRole('button')[0]); });
  const requested = fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/match/'));
  expect(requested).toEqual([`${API}/match/m2?home=b&away=a`]);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('does not refetch form on quiet polls and refreshes once when the table changes, then settles', async () => {
  mount();
  await screen.findAllByRole('list', { name: /Austin FC/ });
  await tick(); await tick();
  expect(formCalls()).toHaveLength(1);
  const changed = [{ ...groups[0], standings: [row(austin, 3)] }, groups[1], groups[2]];
  fetcher.mockImplementation(async (url: string) => (url.endsWith('/standings') ? json(changed)
    : url.endsWith('/standings/form') ? json(form) : json([])));
  await tick();
  expect(formCalls()).toHaveLength(2);
  await tick(); await tick(); await tick();
  expect(formCalls()).toHaveLength(2);
  await tick(); await tick();
  expect(formCalls()).toHaveLength(3);
  await tick();
  expect(formCalls()).toHaveLength(3);
});

it('refreshes on a score correction that leaves the played count unchanged', async () => {
  mount();
  await screen.findAllByRole('list', { name: /Austin FC/ });
  const corrected = [{ ...groups[0], standings: [{ ...row(austin), goalsFor: 9 }] }, groups[1], groups[2]];
  fetcher.mockImplementation(async (url: string) => (url.endsWith('/standings') ? json(corrected)
    : url.endsWith('/standings/form') ? json(form) : json([])));
  await tick();
  expect(formCalls()).toHaveLength(2);
});

it('verifies the first answer once, then refreshes on a slow cadence with no table change', async () => {
  mount();
  await screen.findAllByRole('list', { name: /Austin FC/ });
  for (let i = 0; i < 4; i++) await tick();
  expect(formCalls()).toHaveLength(1);
  await tick();
  expect(formCalls()).toHaveLength(2);
  for (let i = 0; i < 9; i++) await tick();
  expect(formCalls()).toHaveLength(2);
  await tick();
  expect(formCalls()).toHaveLength(3);
  expect(screen.queryByRole('status')).toBeNull();
});

it('never overlaps form requests', async () => {
  let release!: (value: unknown) => void;
  fetcher.mockImplementation((url: string) => (url.endsWith('/standings/form')
    ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(json(url.endsWith('/standings') ? groups : []))));
  mount();
  for (let i = 0; i < 12; i++) await tick();
  expect(formCalls()).toHaveLength(1);
  await act(async () => { release(json(form)); });
});

it('keeps the standings and says so when the first form load fails', async () => {
  formResponses = ['fail'];
  mount();
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toMatch(/form is unavailable/i);
  expect(screen.getAllByText('Austin FC').length).toBeGreaterThan(0);
  expect(screen.queryByRole('list', { name: /Austin FC/ })).toBeNull();
  expect(trackFeedFailure).toHaveBeenCalledWith('standings-form', 502);
});

it('treats an invalid body as a failure, not as an empty season', async () => {
  formResponses = [{ teams: 'nope' }];
  mount();
  expect((await screen.findByRole('status')).textContent).toMatch(/form is unavailable/i);
});

it('labels the last good form as out of date on a failed refresh, then recovers', async () => {
  mount();
  await screen.findAllByRole('list', { name: /Austin FC/ });
  formResponses = [new Error('offline')];
  for (let i = 0; i < 5; i++) await tick();
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toMatch(/may be out of date/i);
  expect(screen.getByText(/regular-season.*newest first/i)).toBeTruthy();
  expect(screen.getAllByRole('list', { name: /Austin FC/ })).toHaveLength(2);
  expect(trackFeedFailure).toHaveBeenCalledWith('standings-form', undefined);
  for (let i = 0; i < 2; i++) await tick();
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(trackFeedRecovery).toHaveBeenCalledWith('standings-form');
});

const changedTable = () => {
  const changed = [{ ...groups[0], standings: [row(austin, 3)] }, groups[1], groups[2]];
  fetcher.mockImplementation(async (url: string) => {
    if (url.endsWith('/standings')) return json(changed);
    if (!url.endsWith('/standings/form')) return json([]);
    const next = formResponses.length ? formResponses.shift() : form;
    return next === 'fail' ? json({}, false, 502) : json(next);
  });
};

it('labels form as catching up from a table change until the settle read', async () => {
  mount();
  await screen.findAllByRole('list', { name: /Austin FC/ });
  changedTable();
  await tick();
  expect(screen.getByRole('status').textContent).toMatch(/catching up/i);
  expect(screen.getByText(/regular-season.*newest first/i)).toBeTruthy();
  for (let i = 0; i < 4; i++) await tick();
  expect(screen.getByRole('status').textContent).toMatch(/catching up/i);
  await tick();
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps the settle read when the refresh after a table change fails', async () => {
  mount();
  await screen.findAllByRole('list', { name: /Austin FC/ });
  changedTable();
  formResponses = ['fail'];
  await tick();
  expect(formCalls()).toHaveLength(2);
  await tick(); await tick();
  expect(formCalls()).toHaveLength(3);
  await tick(); await tick(); await tick();
  expect(formCalls()).toHaveLength(4);
  expect(screen.queryByRole('status')).toBeNull();
});

it('reads again right after an in-flight read when the table changes during it', async () => {
  let release!: (value: unknown) => void;
  const changed = [{ ...groups[0], standings: [row(austin, 3)] }, groups[1], groups[2]];
  fetcher.mockImplementation((url: string) => (url.endsWith('/standings/form')
    ? (formCalls().length === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(json(form)))
    : Promise.resolve(json(url.endsWith('/standings') ? changed : []))));
  mount();
  await tick();
  expect(formCalls()).toHaveLength(1);
  await act(async () => { release(json(form)); });
  await tick();
  expect(formCalls()).toHaveLength(2);
});

it('backs off a repeated failure on the documented schedule, reporting it once', async () => {
  formResponses = Array(8).fill('fail');
  mount();
  await screen.findByRole('status');
  const counts: Record<number, number> = {};
  for (let seconds = 30; seconds <= 750; seconds += 30) { await tick(); counts[seconds] = formCalls().length; }
  // Reads at 0, then 60, 180, 420 and 720 seconds.
  expect(counts[30]).toBe(1);
  expect(counts[60]).toBe(2);
  expect(counts[150]).toBe(2);
  expect(counts[180]).toBe(3);
  expect(counts[390]).toBe(3);
  expect(counts[420]).toBe(4);
  expect(counts[690]).toBe(4);
  expect(counts[720]).toBe(5);
  expect(trackFeedFailure).toHaveBeenCalledTimes(1);
});

it('gives up on a hung request so later polls can retry', async () => {
  const realSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === 30_000) { expire = fn; return 0; }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);
  fetcher.mockImplementation((url: string, init?: RequestInit) => (url.endsWith('/standings/form')
    ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    : Promise.resolve(json([]))));
  mount();
  await waitFor(() => expect(expire).toBeDefined());
  await act(async () => { expire!(); });
  expect((await screen.findByRole('status')).textContent).toMatch(/form is unavailable/i);
  await tick(); await tick();
  expect(formCalls()).toHaveLength(2);
});

it('treats a malformed result or match entry as a failed load', async () => {
  formResponses = [{ scope: 'season', matches: [], teams: { a: { status: 'available', results: [null] } } }];
  const { unmount } = mount();
  expect((await screen.findByRole('status')).textContent).toMatch(/form is unavailable/i);
  unmount();
  formResponses = [{ scope: 'season', matches: [], teams: { a: { status: 'available', results: [] } } }];
  const empty = mount();
  expect((await screen.findByRole('status')).textContent).toMatch(/form is unavailable/i);
  empty.unmount();
  formResponses = [{ scope: 'season', matches: [null], teams: {} }];
  const second = mount();
  expect((await screen.findByRole('status')).textContent).toMatch(/form is unavailable/i);
  second.unmount();
  formResponses = [{ scope: 'season', matches: [], teams: { a: { status: 'available', results: [{ matchId: 'gone', result: 'W' }] } } }];
  mount();
  expect((await screen.findByRole('status')).textContent).toMatch(/form is unavailable/i);
});

it('explains form above the best-third table, the first with badges on a group page', async () => {
  const { container } = render(<I18nProvider locale="en">
    <StandingsLive initialGroups={[third('A', austin), third('B', boston)]} initialScorers={[]} initialAssists={[]} apiBase={API} showThirdPlace />
  </I18nProvider>);
  await screen.findAllByRole('list', { name: /Austin FC/ });
  const notes = container.querySelectorAll('.sf-note');
  expect(notes).toHaveLength(1);
  const first = container.querySelector('.sf-form')!;
  expect(notes[0].compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('treats a malformed team entry as a failed load rather than crashing the table', async () => {
  formResponses = [{ scope: 'season', matches: [], teams: { a: { status: 'available' } } }];
  mount();
  expect((await screen.findByRole('status')).textContent).toMatch(/form is unavailable/i);
  expect(screen.getAllByText('Austin FC').length).toBeGreaterThan(0);
});

it('dates a badge in the reader\'s time zone, like the popup it opens', async () => {
  vi.stubEnv('TZ', 'America/Mexico_City');
  try {
    formResponses = [{ ...form, matches: [{ ...form.matches[0], kickoff: '2026-10-12T02:00:00Z' }, form.matches[1]] }];
    mount();
    const list = (await screen.findAllByRole('list', { name: /Austin FC/ }))[0];
    expect(within(list).getAllByRole('button')[0].getAttribute('aria-label')).toMatch(/Oct 11, 2026/);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('reaches the zone table in both MLS conference and Supporters\' Shield rows', async () => {
  render(<I18nProvider locale="en">
    <StandingsLive initialGroups={groups} initialScorers={[]} initialAssists={[]} apiBase={API} showThirdPlace={false} teamStyle="crest"
      zones={[{ from: 1, to: 1, kind: 'playoff', labelKey: 'zone.mlsRoundOne' }]} />
  </I18nProvider>);
  expect(await screen.findAllByRole('list', { name: /Austin FC/ })).toHaveLength(2);
  expect(screen.getAllByRole('list', { name: /Boston City/ })).toHaveLength(2);
  expect(formCalls()).toHaveLength(1);
});

it('requests no form on a page with no table, and starts when a table arrives', async () => {
  fetcher.mockImplementation(async (url: string) => (url.endsWith('/standings/form') ? json(form) : json([])));
  mount('en', []);
  await tick();
  expect(formCalls()).toHaveLength(0);
  expect(screen.queryByRole('status')).toBeNull();
  fetcher.mockImplementation(async (url: string) => (url.endsWith('/standings') ? json(groups)
    : url.endsWith('/standings/form') ? json(form) : json([])));
  await tick();
  expect(formCalls()).toHaveLength(1);
  expect(screen.getAllByRole('list', { name: /Austin FC/ })).toHaveLength(2);
  expect(screen.queryByRole('status')).toBeNull();
  for (let i = 0; i < 5; i++) await tick();
  expect(formCalls()).toHaveLength(2);
});

it('does not warn about form a pre-season table has nothing of', async () => {
  const preSeason = [{ id: 'east', name: 'East', standings: [row(austin, 0)] }];
  const responses: unknown[] = [{ scope: 'season', teams: {}, matches: [] }, 'fail'];
  fetcher.mockImplementation(async (url: string) => {
    if (url.endsWith('/standings')) return json(preSeason);
    if (!url.endsWith('/standings/form')) return json([]);
    const next = responses.shift() ?? { scope: 'season', teams: {}, matches: [] };
    return next === 'fail' ? json({}, false, 502) : json(next);
  });
  mount('en', preSeason);
  await waitFor(() => expect(formCalls()).toHaveLength(1));
  for (let i = 0; i < 5; i++) await tick();
  expect(formCalls()).toHaveLength(2);
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows no notice when a first read fails before kick-off', async () => {
  const preSeason = [{ id: 'east', name: 'East', standings: [row(austin, 0)] }];
  fetcher.mockImplementation(async (url: string) => (url.endsWith('/standings/form') ? json({}, false, 502)
    : url.endsWith('/standings') ? json(preSeason) : json([])));
  mount('en', preSeason);
  await waitFor(() => expect(formCalls()).toHaveLength(1));
  await act(async () => {});
  expect(trackFeedFailure).toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows no notice when a refresh fails on an edition with no form', async () => {
  formResponses = [{ scope: null, teams: {}, matches: [] }, 'fail'];
  mount();
  await waitFor(() => expect(formCalls()).toHaveLength(1));
  for (let i = 0; i < 5; i++) await tick();
  expect(formCalls()).toHaveLength(2);
  expect(screen.queryByRole('status')).toBeNull();
});

it('says form is unavailable when played teams have none and the refresh failed', async () => {
  formResponses = [{ scope: 'season', teams: {}, matches: [] }, 'fail'];
  mount();
  await waitFor(() => expect(formCalls()).toHaveLength(1));
  for (let i = 0; i < 5; i++) await tick();
  expect(screen.getByRole('status').textContent).toMatch(/form is unavailable/i);
});

it('renders a labelled gap for an unavailable team and nothing for an unplayed one', async () => {
  formResponses = [{ ...form, teams: { a: { status: 'unavailable' } } }];
  mount('en', [{ id: 'east', name: 'East', standings: [row(austin), row(boston, 0)] }]);
  expect((await screen.findByLabelText(/Austin FC.*unavailable/i)).textContent).toBe('Form unavailable');
  expect(screen.queryByLabelText(/Boston City.*unavailable/i)).toBeNull();
});

it('reaches the group, best-third and ladder presentations', async () => {
  const { unmount } = render(<I18nProvider locale="en">
    <StandingsLive initialGroups={[third('A', austin), third('B', boston)]} initialScorers={[]} initialAssists={[]} apiBase={API} showThirdPlace />
  </I18nProvider>);
  // Each team's group row plus its best-third row.
  expect(await screen.findAllByRole('list', { name: /Austin FC/ })).toHaveLength(2);
  unmount();
  render(<I18nProvider locale="en">
    <StandingsLive initialGroups={groups.slice(0, 1)} initialScorers={[]} initialAssists={[]} apiBase={API} showThirdPlace={false}
      teamStyle="crest" qualification={{ cut: 1, labelKey: 'standings.liguilla' }} />
  </I18nProvider>);
  expect(await screen.findAllByRole('list', { name: /Austin FC/ })).toHaveLength(1);
});

it('shows nothing and no notice for a season with no form scope', async () => {
  formResponses = [{ scope: null, teams: {}, matches: [] }];
  const { container } = mount();
  await waitFor(() => expect(formCalls()).toHaveLength(1));
  await act(async () => {});
  expect(container.querySelector('.sf-note')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

it('aborts the form read and stops polling on unmount', async () => {
  let aborted = false;
  fetcher.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/standings/form')) init?.signal?.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  });
  const { unmount } = mount();
  await act(async () => {});
  unmount();
  expect(aborted).toBe(true);
  const calls = fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fetcher.mock.calls.length).toBe(calls);
});
