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
