import { describe, it, expect } from 'vitest';
import { OG_VERSION, ogUrl, safeCrest, shareMetadata } from './ogUrl';

describe('ogUrl', () => {
  it('drops empty params and always appends the version', () => {
    const url = ogUrl({ compId: 'liga-mx', comp: 'Liga MX', crest: null, subject: undefined, locale: 'es' });
    expect(url).toBe(`/api/og?compId=liga-mx&comp=Liga+MX&locale=es&v=${OG_VERSION}`);
  });

  it('encodes reserved characters', () => {
    expect(ogUrl({ subject: 'América & Co' })).toContain('subject=Am%C3%A9rica+%26+Co');
  });

  it('keeps category and edition context on same-name team shares', () => {
    const men = ogUrl({ subject: 'América', compId: 'liga-mx', comp: 'Liga MX Apertura 2026', locale: 'es' });
    const women = ogUrl({ subject: 'América', compId: 'liga-mx-femenil', comp: 'Liga MX Femenil Apertura 2026', locale: 'es' });
    expect(men).not.toBe(women);
    expect(new URL(women, 'https://scorearc.futbol').searchParams.get('comp')).toBe('Liga MX Femenil Apertura 2026');
  });
});

describe('shareMetadata', () => {
  it('emits matching openGraph and twitter blocks for one image', () => {
    const m = shareMetadata('T', 'D', '/api/og?v=3');
    expect(m.openGraph).toEqual({
      title: 'T', description: 'D', type: 'website', siteName: 'ScoreArc',
      images: [{ url: '/api/og?v=3', width: 1200, height: 630 }],
    });
    expect(m.twitter).toEqual({ card: 'summary_large_image', title: 'T', description: 'D', images: ['/api/og?v=3'] });
  });
});

describe('safeCrest', () => {
  it.each([
    'https://a.espncdn.com/i/teamlogos/soccer/500/227.png',
    'https://r2.thesportsdb.com/images/media/team/badge/x.png',
    // The ScoreArc CDN, where the ingester mirrors crests (teams/<canonical id>).
    'https://cdn.scorearc.futbol/teams/mex-america',
  ])('honors a crest from a host our data layer serves: %s', (crest) => {
    expect(safeCrest(crest)).toBe(crest);
  });

  it.each([
    ['plain http', 'http://cdn.scorearc.futbol/teams/mex-america'],
    ['lookalike suffix', 'https://cdn.scorearc.futbol.evil.example/teams/x'],
    ['lookalike host', 'https://cdn-scorearc.futbol/teams/x'],
    ['subdomain', 'https://x.cdn.scorearc.futbol/teams/x'],
    ['parent domain', 'https://scorearc.futbol/teams/x'],
    ['sibling host', 'https://assets.scorearc.futbol/teams/x'],
    ['non-default port', 'https://cdn.scorearc.futbol:8443/teams/x'],
    ['non-default port on an existing host', 'https://a.espncdn.com:8443/i/x.png'],
  ])('rejects %s', (_label, crest) => {
    expect(safeCrest(crest)).toBeNull();
  });
});
