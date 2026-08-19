import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import LiveBand from './LiveBand';
import type { LiveEntry } from '@/server/data/liveFeed';
import type { Match, MatchState } from '@/server/data/types';

// Presentational components are normally verified by running the app here.
// This one gets a render test because *which mode renders* is an invisible
// rule -- three modes sharing one slot -- and the empty case must produce no
// markup at all rather than a heading over nothing.

const NOW = new Date('2026-08-18T18:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();

function entry(id: string, state: MatchState, kickoff: string, comp = 'Liga MX'): LiveEntry {
  const match = {
    id, kickoff, state, minute: state === 'live' ? "67'" : null,
    statusDetail: state === 'finished' ? 'FT' : '', statusName: '',
    home: { id: `${id}h`, name: 'América', abbr: 'AME', crestUrl: null },
    away: { id: `${id}a`, name: 'Cruz Azul', abbr: 'CAZ', crestUrl: null },
    homeScore: state === 'scheduled' ? null : 1,
    awayScore: state === 'scheduled' ? null : 0,
    winnerId: null, note: null, scorers: [], cards: [],
    shootout: null, shootoutDetail: null, stats: null, winProbability: null,
  } as Match;
  return {
    competition: { id: 'liga-mx', seasonId: '2026-apertura', name: comp, shortName: comp, emblem: '🇲🇽' },
    match,
  };
}

describe('LiveBand', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('renders nothing when there is nothing to say', () => {
    expect(renderToStaticMarkup(<LiveBand initialEntries={[]} />)).toBe('');
  });

  // A finished edition contributes only results too old to be "just finished".
  it('renders nothing when every match is long past', () => {
    const html = renderToStaticMarkup(
      <LiveBand initialEntries={[entry('old', 'finished', hours(-200))]} />,
    );
    expect(html).toBe('');
  });

  it('leads with live matches when any are in play', () => {
    const html = renderToStaticMarkup(
      <LiveBand
        initialEntries={[
          entry('l', 'live', hours(-1)),
          entry('u', 'scheduled', hours(3)),
          entry('r', 'finished', hours(-4)),
        ]}
      />,
    );
    expect(html).toContain('Live now');
    // The live mode owns the whole slot -- the other two are not also shown.
    expect(html).not.toContain('Latest results');
    expect(html).not.toContain('Next up');
  });

  it('shows what just finished beside what is next when nothing is live', () => {
    const html = renderToStaticMarkup(
      <LiveBand
        initialEntries={[entry('u', 'scheduled', hours(3)), entry('r', 'finished', hours(-4))]}
      />,
    );
    expect(html).toContain('Latest results');
    expect(html).toContain('Next up');
    expect(html).not.toContain('Live now');
  });

  it('shows only the half it has', () => {
    const upcomingOnly = renderToStaticMarkup(
      <LiveBand initialEntries={[entry('u', 'scheduled', hours(3))]} />,
    );
    expect(upcomingOnly).toContain('Next up');
    expect(upcomingOnly).not.toContain('Just finished');
  });

  it('names the competition on every row, since the band mixes them', () => {
    const html = renderToStaticMarkup(
      <LiveBand initialEntries={[entry('l', 'live', hours(-1), 'Liga MX')]} />,
    );
    expect(html).toContain('Liga MX');
  });

  it('links a row to that competition and season', () => {
    const html = renderToStaticMarkup(
      <LiveBand initialEntries={[entry('l', 'live', hours(-1))]} />,
    );
    expect(html).toContain('/c/liga-mx/2026-apertura/matches');
  });

  // Nothing on the server pass may carry a wall clock. Vercel runs UTC, and a
  // time baked into server-rendered HTML is never corrected afterwards -- the
  // reader would see a kickoff hours off, or the wrong day entirely.
  it('renders no server-formatted clock time', () => {
    const html = renderToStaticMarkup(
      <LiveBand initialEntries={[entry('u', 'scheduled', hours(3))]} />,
    );
    expect(html).not.toMatch(/\d{1,2}:\d{2}/);
    expect(html).toContain('lt-pending');
  });

  // A row that shows its day on screen but omits it from its label has fixed
  // the ambiguity only for people who can see it. Pre-mount the day is absent
  // from both, which is the point -- it is the reader's clock.
  it('keeps the score in a result row label', () => {
    const html = renderToStaticMarkup(
      <LiveBand initialEntries={[entry('r', 'finished', hours(-4))]} />,
    );
    expect(html).toMatch(/aria-label="[^"]*América 1, Cruz Azul 0[^"]*"/);
    expect(html).toMatch(/aria-label="[^"]*FT[^"]*"/);
  });

  // The same markup under two very different clocks. If any formatting leaked
  // into the server pass, these would differ -- which is exactly the defect
  // both reviewers found in the first cut.
  it('renders identically regardless of the server timezone', () => {
    const render = () =>
      renderToStaticMarkup(
        <LiveBand
          initialEntries={[entry('u', 'scheduled', hours(3)), entry('r', 'finished', hours(-4))]}
        />,
      );
    const original = process.env.TZ;
    process.env.TZ = 'UTC';
    const utc = render();
    process.env.TZ = 'America/Mexico_City';
    const cdmx = render();
    process.env.TZ = original;
    expect(utc).toBe(cdmx);
  });
});
