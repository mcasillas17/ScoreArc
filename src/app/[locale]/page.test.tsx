import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { dataStore } from '@/server/data/store';
import { listCompetitions, resolveSeason, type CompetitionSeason } from '@/server/data/competitions';
import type { Match, NewsArticle, StatLeader } from '@/server/data/types';
import Home from './page';
import { I18nProvider } from '@/i18n/I18nProvider';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  usePathname: () => '/en',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/server/data/store', async (orig) => {
  const mod = (await orig()) as typeof import('@/server/data/store');
  return { ...mod, dataStore: { ...mod.dataStore } };
});

const NOW = new Date('2026-08-18T12:00:00Z');
const H = 3600_000;

const team = (id: string, abbr: string) => ({ id, name: abbr, abbr, crestUrl: null });

function match(id: string, kickoffHours: number, state: Match['state'] = 'scheduled'): Match {
  return {
    id,
    kickoff: new Date(NOW.getTime() + kickoffHours * H).toISOString(),
    state,
    minute: null,
    statusDetail: state === 'finished' ? 'FT' : '',
    statusName: '',
    home: team(`${id}-h`, 'AAA'),
    away: team(`${id}-a`, 'BBB'),
    homeScore: state === 'scheduled' ? null : 1,
    awayScore: state === 'scheduled' ? null : 0,
    winnerId: null,
    note: null,
    scorers: [],
    cards: [],
    shootout: null,
    shootoutDetail: null,
    stats: null,
    winProbability: null,
  };
}

const leader = (rank: number, player: string): StatLeader => ({
  rank,
  player,
  teamId: 't',
  teamAbbr: 'AAA',
  teamName: 'A',
  teamCrestUrl: null,
  value: 10 - rank,
  matches: 5,
});

const article = (id: string, published = '2026-08-18T10:00:00Z'): NewsArticle => ({
  id,
  headline: `Headline ${id}`,
  description: '',
  published,
  image: null,
  url: `https://example.test/${id}`,
  byline: 'ESPN',
});

const COMPETITIONS = listCompetitions();
const FIRST = COMPETITIONS[0].id;
const SECOND = COMPETITIONS[1].id;

/** Per-competition feeds, keyed by competition id; anything unlisted is empty. */
function byCompetition<T>(map: Record<string, T[]>) {
  return async (rc: CompetitionSeason): Promise<T[]> => map[rc.competition.id] ?? [];
}

const matchIds = (html: string) =>
  (html.match(/data-match-id="[^"]+"/g) ?? []).map((a) => a.slice(15, -1));
const count = (html: string, needle: string) => html.split(needle).length - 1;

const renderLocalized = (node: ReactNode) =>
  renderToStaticMarkup(<I18nProvider locale="en">{node}</I18nProvider>);

describe('Home digest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(dataStore, 'getLeaders').mockResolvedValue({ scorers: [], assists: [] });
    vi.spyOn(dataStore, 'getNews').mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  // One render used to cost 95 upstream ESPN requests, 77 of them per-match
  // /summary calls bought by getMatches and then discarded -- the digest reads
  // only what the scoreboard already carries.
  it('never uses the enriching match read', async () => {
    const enriching = vi.spyOn(dataStore, 'getMatches');
    const cheap = vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);

    renderLocalized(await Home({ params: { locale: 'en' } }));

    expect(enriching).not.toHaveBeenCalled();
    expect(cheap).toHaveBeenCalled();
  });

  it("reads each competition's window exactly once", async () => {
    const cheap = vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
    renderLocalized(await Home({ params: { locale: 'en' } }));
    expect(cheap).toHaveBeenCalledTimes(COMPETITIONS.length);
  });

  // A dead feed must cost that competition's rows, not the page.
  it('renders when every feed throws', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockRejectedValue(new Error('upstream unavailable'));
    vi.spyOn(dataStore, 'getLeaders').mockRejectedValue(new Error('upstream unavailable'));
    vi.spyOn(dataStore, 'getNews').mockRejectedValue(new Error('upstream unavailable'));
    const html = renderLocalized(await Home({ params: { locale: 'en' } }));
    expect(html).toContain('What&#x27;s new in ScoreArc');
  });

  // The defect this page was redesigned to remove: the old home page showed
  // the same match in the live band, in the results/next columns, and again in
  // the competition tile beneath them.
  it('renders no match more than once', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([
      match('m1', 2),
      match('m2', 3),
      match('m3', -4, 'finished'),
    ]);
    const html = renderLocalized(await Home({ params: { locale: 'en' } }));
    const ids = matchIds(html);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('the heading counts what the body shows', () => {
    // Every competition returning the same provider event id is the real case:
    // a club plays in a league and a cup and both scoreboards carry the tie.
    // The count used to come from the raw entry list, so the heading claimed
    // nine live matches above one card.
    it('counts one when nine competitions return the same live match', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('shared', 0, 'live')]);
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(matchIds(html)).toEqual(['shared']);
      expect(html).toContain('1 match live right now.');
    });

    // Eight distinct live matches, six cards: the heading must quote the cap,
    // not the pool.
    it('counts the cap, not the pool, when more are live than fit', async () => {
      const live = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => match(`live${n}`, 0, 'live'));
      vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(byCompetition({ [FIRST]: live }));
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(matchIds(html)).toHaveLength(6);
      expect(html).toContain('6 matches live right now.');
      expect(html).not.toContain('8 matches live right now.');
    });
  });

  describe('the mode ladder', () => {
    it('shows live matches ahead of imminent kickoffs', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(
        byCompetition({ [FIRST]: [match('inplay', 0, 'live')], [SECOND]: [match('soon', 2)] }),
      );
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(matchIds(html)).toEqual(['inplay']);
      expect(html).toContain('1 match live right now.');
    });

    // The dead-day bug: getLiveWindow reads +14 days and every scheduled match
    // in it counts as upcoming, so this page showed a fixture nine days out and
    // said "next kickoff in about 9 days" while a result from four hours ago
    // sat unused in the very same payload.
    it('prefers a four-hour-old result to a nine-day-away fixture', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(
        byCompetition({ [FIRST]: [match('faraway', 9 * 24)], [SECOND]: [match('done', -4, 'finished')] }),
      );
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(matchIds(html)).toEqual(['done']);
      expect(html).toContain('latest results');
      expect(html).not.toContain('in about 9 days');
    });

    // The horizon bounds which bucket wins, and it has to bound what goes into
    // it as well. getLiveWindow reads +14 days, so with one kickoff two hours
    // away the upcoming bucket also carries next week's fixtures -- and the
    // block rendered all six of them under a heading that says "What's on".
    it('shows only the fixtures inside the horizon, not the whole bucket', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(
        byCompetition({ [FIRST]: [match('soon', 2), match('sameday', 9), match('nextweek', 7 * 24)] }),
      );
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(matchIds(html)).toEqual(['soon', 'sameday']);
      expect(html).toContain('next kickoff in about 2 hours');
    });

    // With no results either, a distant fixture still beats an empty block.
    it('falls back to a distant fixture when there is no result to show', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('faraway', 9 * 24)]);
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(matchIds(html)).toEqual(['faraway']);
      expect(html).toContain('next kickoff in about 9 days');
    });
  });

  // With nothing live and nothing scheduled in the window, an empty block reads
  // as a broken site -- so the digest leads with results and says so.
  it('falls back to recent results and names them', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('done', -4, 'finished')]);
    const html = renderLocalized(await Home({ params: { locale: 'en' } }));
    expect(html).toContain('latest results');
    expect(html).toContain('data-match-id="done"');
  });

  it('says how far off the next kickoff is when nothing is live', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([match('next', 4)]);
    const html = renderLocalized(await Home({ params: { locale: 'en' } }));
    expect(html).toContain('next kickoff in about 4 hours');
  });

  // The countdown has to be the nearest kickoff anywhere, not whichever
  // competition's feed happened to be merged first.
  it('counts down to the nearest kickoff across competitions', async () => {
    vi.spyOn(dataStore, 'getLiveWindow').mockImplementation(
      byCompetition({ [FIRST]: [match('later', 9)], [SECOND]: [match('sooner', 4)] }),
    );
    const html = renderLocalized(await Home({ params: { locale: 'en' } }));
    expect(html).toContain('next kickoff in about 4 hours');
    expect(html).not.toContain('in about 9 hours');
  });

  describe('empty states', () => {
    it('says so in every block when nothing is available', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(html).toContain('No matches in the current window.');
      expect(html).toContain('No scoring boards are published yet.');
      expect(html).toContain('News is unavailable right now.');
    });

    // The heading fell through to the recent-results wording with nothing to
    // show, so the page said "here are the latest results" directly above "No
    // matches in the current window."
    it('does not promise results above an empty block', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(html).toContain('window is empty');
      expect(html).not.toContain('latest results');
    });
  });

  describe('leading scorers', () => {
    it('shows the top three of each competition board', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      vi.spyOn(dataStore, 'getLeaders').mockResolvedValue({
        scorers: [1, 2, 3, 4, 5].map((r) => leader(r, `Player ${r}`)),
        assists: [],
      });
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(html).toContain('Player 3');
      expect(html).not.toContain('Player 4');
    });

    // Nine competitions publish boards; six fit. Without the cap the block
    // would be longer than the news column beside it.
    it('caps the number of boards', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      vi.spyOn(dataStore, 'getLeaders').mockResolvedValue({ scorers: [leader(1, 'Solo')], assists: [] });
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(COMPETITIONS.length).toBeGreaterThan(6);
      expect(count(html, 'class="dg-board"')).toBe(6);
    });

    // A board saying only "WORLD CUP" beside in-progress league boards gives
    // the reader nothing to tell a concluded tournament from a live race.
    it('names the season each board is for', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      vi.spyOn(dataStore, 'getLeaders').mockResolvedValue({ scorers: [leader(1, 'Solo')], assists: [] });
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      const label = resolveSeason(FIRST)!.season.label;
      expect(html).toContain(`<span class="dg-bseason">${label}</span>`);
    });
  });

  describe('news', () => {
    it('lists news across competitions', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      vi.spyOn(dataStore, 'getNews').mockResolvedValue([article('a'), article('b'), article('c')]);
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(html).toContain('Headline a');
      // Two per competition, so the third from one feed never crowds out another
      // competition's lead story.
      expect(html).not.toContain('Headline c');
    });

    // ESPN publishes the same wire story under several leagues. Asserting only
    // that the headline is present passes whether the dedupe runs or not.
    it('shows a syndicated story exactly once', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      vi.spyOn(dataStore, 'getNews').mockResolvedValue([article('shared')]);
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(count(html, 'Headline shared')).toBe(1);
      expect(count(html, 'class="dg-nw"')).toBe(1);
    });

    it('orders stories newest first across competitions', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      vi.spyOn(dataStore, 'getNews').mockImplementation(
        byCompetition({
          [FIRST]: [article('old', '2026-08-18T06:00:00Z')],
          [SECOND]: [article('newest', '2026-08-18T11:30:00Z')],
          [COMPETITIONS[2].id]: [article('middle', '2026-08-18T09:00:00Z')],
        }),
      );
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(html.indexOf('Headline newest')).toBeLessThan(html.indexOf('Headline middle'));
      expect(html.indexOf('Headline middle')).toBeLessThan(html.indexOf('Headline old'));
    });

    it('caps the number of stories', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      vi.spyOn(dataStore, 'getNews').mockImplementation(async (rc: CompetitionSeason) => [
        article(`${rc.competition.id}-1`),
        article(`${rc.competition.id}-2`),
      ]);
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(COMPETITIONS.length * 2).toBeGreaterThan(6);
      expect(count(html, 'class="dg-nw"')).toBe(6);
    });

    // The competition label was wrong on most rows -- ESPN's per-league /news
    // is mostly generic -- and arbitrary besides, since the dedupe keeps
    // whichever copy sorted first. A row says how old it is instead.
    it('dates a story rather than attributing it to a competition feed', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      vi.spyOn(dataStore, 'getNews').mockImplementation(
        byCompetition({ [FIRST]: [article('a', '2026-08-18T10:00:00Z')] }),
      );
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(html).toContain('2 hours ago');
      expect(html).not.toContain(`<span class="dg-nwsrc">${COMPETITIONS[0].shortName}</span>`);
    });

    // Every row leaves for ESPN in a new tab; without this the block led
    // nowhere inside ScoreArc at all.
    it('offers a way into the app', async () => {
      vi.spyOn(dataStore, 'getLiveWindow').mockResolvedValue([]);
      const html = renderLocalized(await Home({ params: { locale: 'en' } }));
      expect(html).toContain('href="/news"');
    });
  });
});
