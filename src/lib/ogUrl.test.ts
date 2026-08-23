import { describe, it, expect } from 'vitest';
import { OG_VERSION, ogUrl, shareMetadata } from './ogUrl';

describe('ogUrl', () => {
  it('drops empty params and always appends the version', () => {
    const url = ogUrl({ compId: 'liga-mx', comp: 'Liga MX', crest: null, subject: undefined, locale: 'es' });
    expect(url).toBe(`/api/og?compId=liga-mx&comp=Liga+MX&locale=es&v=${OG_VERSION}`);
  });

  it('encodes reserved characters', () => {
    expect(ogUrl({ subject: 'América & Co' })).toContain('subject=Am%C3%A9rica+%26+Co');
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
