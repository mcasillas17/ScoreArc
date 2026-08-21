import { describe, it, expect } from 'vitest';
import type { NewsArticle } from '@/server/data/types';
import {
  chooseWhatsOn,
  collectStories,
  publishedAgo,
  untilKickoff,
  whatsOnHeadline,
  UPCOMING_HORIZON_MS,
} from './digest';

const H = 3600_000;

describe('untilKickoff', () => {
  it('reads in minutes under an hour', () => {
    expect(untilKickoff(25 * 60_000)?.en).toBe('in 25 minutes');
  });

  it('rounds to whole hours once past one', () => {
    expect(untilKickoff(4 * H + 12 * 60_000)?.en).toBe('in about 4 hours');
  });

  it('switches to days past a day out', () => {
    expect(untilKickoff(50 * H)?.en).toBe('in about 2 days');
  });

  // A kickoff already in the past is not a countdown. Returning null lets the
  // caller fall back to a sentence that does not quote a negative duration.
  it('refuses a kickoff that has passed', () => {
    expect(untilKickoff(-H)).toBeNull();
    expect(untilKickoff(0)).toBeNull();
  });
});

describe('publishedAgo', () => {
  it('reads in minutes, hours and days', () => {
    expect(publishedAgo(20 * 60_000)?.en).toBe('20 minutes ago');
    expect(publishedAgo(3 * H)?.en).toBe('3 hours ago');
    expect(publishedAgo(50 * H)?.en).toBe('2 days ago');
  });

  it('floors rather than rounds, so nothing reads older than it is', () => {
    expect(publishedAgo(119 * 60_000)?.en).toBe('1 hour ago');
  });

  it('says just now under a minute', () => {
    expect(publishedAgo(30_000)?.en).toBe('just now');
    expect(publishedAgo(30_000)?.es).toBe('ahora mismo');
  });

  // A publish time in the future is a provider defect, not a duration.
  it('refuses a negative or unparseable age', () => {
    expect(publishedAgo(-1)).toBeNull();
    expect(publishedAgo(NaN)).toBeNull();
  });
});

describe('chooseWhatsOn', () => {
  const b = (live: string[], upcoming: string[], recent: string[]) => ({ live, upcoming, recent });

  it('puts live above everything', () => {
    expect(chooseWhatsOn(b(['l'], ['u'], ['r']), 2 * H)).toEqual({ mode: 'live', pool: ['l'] });
  });

  it('takes a kickoff inside the horizon over recent results', () => {
    expect(chooseWhatsOn(b([], ['u'], ['r']), 4 * H).mode).toBe('upcoming');
  });

  // The bug this exists for: getLiveWindow reads +14 days, so without a bound
  // the upcoming branch always won and the dead-day fallback below it could
  // never fire -- "next kickoff in about 12 days" above a fortnight-out
  // fixture, while a week of results sat unused in the same payload.
  it('drops a distant fixture below recent results', () => {
    const chosen = chooseWhatsOn(b([], ['u'], ['r']), 9 * 24 * H);
    expect(chosen).toEqual({ mode: 'recent', pool: ['r'] });
  });

  it('switches over exactly at the horizon', () => {
    expect(chooseWhatsOn(b([], ['u'], ['r']), UPCOMING_HORIZON_MS).mode).toBe('upcoming');
    expect(chooseWhatsOn(b([], ['u'], ['r']), UPCOMING_HORIZON_MS + 1).mode).toBe('recent');
  });

  // An opening weekend has fixtures and no results yet. A distant fixture is
  // still better than an empty block, so it stays on the ladder.
  it('shows a distant fixture when there is nothing else', () => {
    expect(chooseWhatsOn(b([], ['u'], []), 9 * 24 * H)).toEqual({ mode: 'upcoming', pool: ['u'] });
  });

  it('reports none when every bucket is empty', () => {
    expect(chooseWhatsOn(b([], [], []), null)).toEqual({ mode: 'none', pool: [] });
  });
});

describe('whatsOnHeadline', () => {
  it('counts live matches', () => {
    expect(whatsOnHeadline('live', 3, null).en).toBe('3 matches live right now.');
    expect(whatsOnHeadline('live', 1, null).en).toBe('1 match live right now.');
  });

  it('says how far off the next kickoff is', () => {
    expect(whatsOnHeadline('upcoming', 4, 4 * H).en).toContain('next kickoff in about 4 hours');
  });

  // The dead-day case the spec calls out: an empty block reads as a broken
  // site, so the heading has to say these are results rather than fixtures.
  it('names recent results as results', () => {
    expect(whatsOnHeadline('recent', 4, null).en).toContain('latest results');
    expect(whatsOnHeadline('recent', 4, null).es).toContain('últimos resultados');
  });

  // Falling through to 'recent' when there is nothing at all put "here are the
  // latest results" directly above "No matches in the current window."
  it('does not promise results when there are none', () => {
    const line = whatsOnHeadline('none', 0, null);
    expect(line.en).not.toContain('results');
    expect(line.en).toContain('window is empty');
    expect(line.es).toContain('ventana está vacía');
  });

  it('is bilingual in every mode', () => {
    for (const m of ['live', 'upcoming', 'recent', 'none'] as const) {
      const line = whatsOnHeadline(m, 2, 2 * H);
      expect(line.en.length).toBeGreaterThan(0);
      expect(line.es.length).toBeGreaterThan(0);
      expect(line.es).not.toBe(line.en);
    }
  });
});

const article = (id: string, published: string): NewsArticle => ({
  id,
  headline: `Headline ${id}`,
  description: '',
  published,
  image: null,
  url: `https://example.test/${id}`,
  byline: 'ESPN',
});

describe('collectStories', () => {
  it('caps each feed before merging, so one busy feed cannot crowd the rest out', () => {
    const busy = ['a', 'b', 'c'].map((id) => article(id, '2026-08-18T12:00:00Z'));
    const quiet = [article('z', '2026-08-18T11:00:00Z')];
    const out = collectStories([busy, quiet], { perFeed: 2, limit: 10 });
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'z']);
  });

  it('collapses the same article syndicated across feeds', () => {
    const shared = [article('same', '2026-08-18T12:00:00Z')];
    const out = collectStories([shared, shared, shared], { perFeed: 2, limit: 10 });
    expect(out).toHaveLength(1);
  });

  it('orders newest first across feeds', () => {
    const out = collectStories(
      [
        [article('old', '2026-08-18T08:00:00Z')],
        [article('new', '2026-08-18T18:00:00Z')],
        [article('mid', '2026-08-18T13:00:00Z')],
      ],
      { perFeed: 2, limit: 10 },
    );
    expect(out.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  // Two articles sharing a publish timestamp must not swap places between
  // renders: an unstable order is a hydration mismatch waiting to happen.
  it('breaks a timestamp tie deterministically', () => {
    const same = '2026-08-18T12:00:00Z';
    const out = collectStories([[article('b', same)], [article('a', same)]], { perFeed: 2, limit: 10 });
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('sorts an unparseable publish time last rather than at random', () => {
    const out = collectStories(
      [[article('broken', 'not-a-date')], [article('good', '2026-08-18T12:00:00Z')]],
      { perFeed: 2, limit: 10 },
    );
    expect(out.map((s) => s.id)).toEqual(['good', 'broken']);
  });

  it('applies the overall limit last', () => {
    const feeds = ['a', 'b', 'c', 'd'].map((id) => [article(id, '2026-08-18T12:00:00Z')]);
    expect(collectStories(feeds, { perFeed: 2, limit: 3 })).toHaveLength(3);
  });
});
