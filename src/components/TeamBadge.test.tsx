import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TeamBadge from './TeamBadge';

const team = { id: '205', name: 'Brazil', abbr: 'BRA', crestUrl: 'https://logos/bra.png' };

describe('TeamBadge team style', () => {
  it('renders a flag for national style', () => {
    const html = renderToStaticMarkup(<TeamBadge team={team} style="flag" />);
    expect(html).toContain('flagcdn.com');
  });
  it('renders the crest for club style', () => {
    const html = renderToStaticMarkup(<TeamBadge team={team} style="crest" />);
    expect(html).toContain('https://logos/bra.png');
    expect(html).not.toContain('flagcdn.com');
  });
});

describe('TeamBadge linking', () => {
  it('wraps the badge in a link when href is supplied', () => {
    const html = renderToStaticMarkup(
      <TeamBadge team={team} style="crest" href="/c/liga-mx/2026-apertura/team/205" />,
    );
    expect(html).toContain('<a');
    expect(html).toContain('href="/c/liga-mx/2026-apertura/team/205"');
  });

  // Optional on purpose: every existing call site keeps working untouched, and
  // anything without a real team id -- a bracket placeholder, say -- stays
  // inert rather than linking to a 404 with a crest on it.
  it('renders no link when href is absent', () => {
    const html = renderToStaticMarkup(<TeamBadge team={team} style="crest" />);
    expect(html).not.toContain('<a');
  });
});
