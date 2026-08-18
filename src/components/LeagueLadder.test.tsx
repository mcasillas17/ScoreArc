import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import LeagueLadder from './LeagueLadder';
import type { Standing } from '@/server/data/types';

// This component is normally "verified by running the app" per repo
// convention. It gets a render test because the pre-season path is not
// reachable through live data — the Leagues Cup is the only competition that
// renders a ladder, and it is mid-season — so reading the JSX was the only
// other option, and reading it is precisely how two defects survived review
// here: a labelled band over zero rows, and every club dimmed as eliminated.

function table(n: number, played: number): Standing[] {
  return Array.from({ length: n }, (_, i) => ({
    team: { id: `t${i + 1}`, name: `Team ${i + 1}`, abbr: `T${i + 1}`, crestUrl: null },
    rank: i + 1,
    played, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, advanced: false,
  }));
}

const QUAL = { cut: 8, label: 'Liguilla' };

function render(n: number, played: number): string {
  return renderToStaticMarkup(
    <LeagueLadder standings={table(n, played)} qualification={QUAL} teamStyle="crest" />,
  );
}

describe('LeagueLadder before kick-off', () => {
  const html = render(18, 0);

  it('marks nobody as inside the qualification cut', () => {
    expect(html).not.toContain('ll-row--in');
    expect(html).not.toContain('ll-band-label--in');
  });

  // The inverse claim is just as false. `.ll-band--out .ll-row` sets
  // opacity 0.5, so wrapping an unplayed table in it says every club is
  // eliminated.
  it('does not dim every club as eliminated', () => {
    expect(html).not.toContain('ll-band--out');
  });

  it('draws no cut line and no band headers', () => {
    expect(html).not.toContain('ll-cutline');
    expect(html).not.toContain('Quarterfinals');
  });

  it('says why it is blank', () => {
    expect(html).toContain('Season not started');
  });

  it('still lists every club', () => {
    expect((html.match(/ll-row/g) ?? []).length).toBe(18);
  });
});

describe('LeagueLadder once the season is under way', () => {
  const html = render(18, 3);

  it('restores the cut, the bands and the cut line', () => {
    expect(html).toContain('ll-band-label--in');
    expect(html).toContain('ll-cutline');
    expect(html).toContain('ll-band--out');
    expect(html).toContain('Quarterfinals');
  });

  it('does not show the pre-season caption', () => {
    expect(html).not.toContain('Season not started');
  });
});
