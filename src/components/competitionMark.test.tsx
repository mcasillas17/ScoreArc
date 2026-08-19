import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CompetitionMark from './CompetitionMark';
import { COMPETITIONS, listCompetitions } from '@/server/data/competitions';

// ESPN's league logos vary in quality. Measured 2026-08-19 on the 500-dark
// variant: the Leagues Cup mark is solid black (ink luminance 0) on transparent
// and vanishes on this background; Liga MX's is the BBVA Bancomer sponsor
// lockup. Seven of nine are fine. The rule is per competition, not blanket.
describe('CompetitionMark', () => {
  it('renders the logo when there is one', () => {
    const html = renderToStaticMarkup(
      <CompetitionMark logo="https://example.test/l.png" emblem="🏆" name="Test Cup" />,
    );
    expect(html).toContain('https://example.test/l.png');
    expect(html).toContain('alt="Test Cup"');
  });

  // The emblem is the fallback, not decoration: it covers a reader offline and
  // a blocked third-party CDN as well as a competition with no usable logo.
  it('falls back to the emblem when there is no logo', () => {
    const html = renderToStaticMarkup(<CompetitionMark emblem="🏆" name="Test Cup" />);
    expect(html).toContain('🏆');
    expect(html).toContain('aria-label="Test Cup"');
    expect(html).not.toContain('<img');
  });

  it('keeps an emblem for every competition, logo or not', () => {
    for (const comp of listCompetitions()) {
      expect(comp.emblem).toBeTruthy();
    }
  });

  it('gives every competition a logo', () => {
    const without = listCompetitions().filter((c) => !c.logo).map((c) => c.id);
    expect(without).toEqual([]);
  });

  // Inverting is for monochrome marks only — it would recolour a colour logo
  // into a different one. ESPN's Leagues Cup mark measured ink luminance 0.
  it('inverts only the mark that is solid black', () => {
    const inverted = listCompetitions().filter((c) => c.logoInvert).map((c) => c.id);
    expect(inverted).toEqual(['leagues-cup']);
    expect(COMPETITIONS['liga-mx'].logoInvert).toBeUndefined();
  });

  it('applies the filter only when asked', () => {
    const plain = renderToStaticMarkup(
      <CompetitionMark logo="https://example.test/l.png" emblem="🏆" name="A" />,
    );
    const flipped = renderToStaticMarkup(
      <CompetitionMark logo="https://example.test/l.png" logoInvert emblem="🏆" name="A" />,
    );
    expect(plain).not.toContain('invert');
    expect(flipped).toContain('invert(1)');
  });
});
