import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import { BoxScoreBlock } from './MatchExtras';
import { mapSummaryLineups } from '@/server/data/providers/espn-summary';
import ownGoalFixture from '@/server/data/__fixtures__/espn-summary-own-goal.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/en',
  useRouter: () => ({ push: vi.fn() }),
}));

const renderLocalized = (node: ReactNode) =>
  renderToStaticMarkup(<I18nProvider locale="en">{node}</I18nProvider>);

// Per repo convention presentational components are verified by running the
// app. This one gets a render test because the fact it exists to carry — a
// dash for "the provider sent no such stat" versus a 0 for a real zero — is
// invisible on screen unless you know which player to look at, and collapsing
// it back to 0 would throw away the whole reason PlayerMatchStats is nullable.

const lineups = mapSummaryLineups(ownGoalFixture, '17362', '226')!;
const html = renderLocalized(
  <BoxScoreBlock lineups={lineups} homeAbbr="MIN" awayAbbr="ATL" />,
);

// The markup is one long string; pull out the row for a named player.
function rowFor(name: string): string {
  const at = html.indexOf(name);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<tr', at);
  return html.slice(start, html.indexOf('</tr>', at));
}

describe('BoxScoreBlock', () => {
  it('renders both squads', () => {
    expect(html).toContain('>MIN<');
    expect(html).toContain('>ATL<');
  });

  it('lists substitutes as well as starters, marked as subs', () => {
    expect(html).toContain('ls-box-sub');
    // 22 home + 23 away players, all with stats in this fixture.
    expect(html.split('<tr').length - 1).toBe(2 + 45); // 2 header rows
  });

  // The keeper has no offsides entry and the outfielder has no saves entry, so
  // each renders a dash where the other renders a number.
  it('shows a dash where the provider sent no such stat', () => {
    expect(rowFor('Alec Smir')).toContain('ls-box-na');
    expect(rowFor('Jefferson D')).toContain('ls-box-na');
  });

  it('shows a zero where the stat is a real zero', () => {
    // Jefferson Díaz has offsides: 0 — a fact, not an absence.
    expect(rowFor('Jefferson D')).toContain('<td>0</td>');
    // And the keeper's three saves are a number, not a dash.
    expect(rowFor('Alec Smir')).toContain('<td>3</td>');
  });

  it('renders a card chip for a booked player', () => {
    expect(rowFor('Devin Padelford')).toContain('ls-card-yellow');
  });

  it('renders nothing when no player carries stats', () => {
    const bare = {
      home: { formation: '4-4-2', players: [{ name: 'A', number: 1, position: 'G', jersey: null, starter: true, stats: null }] },
      away: { formation: '4-4-2', players: [{ name: 'B', number: 1, position: 'G', jersey: null, starter: true, stats: null }] },
    };
    expect(renderLocalized(<BoxScoreBlock lineups={bare} homeAbbr="A" awayAbbr="B" />)).toBe('');
  });
});
