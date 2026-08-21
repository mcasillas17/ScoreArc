import type { NewsArticle } from '@/server/data/types';

/**
 * What the home digest's "What's on" block is showing, and how it says so.
 *
 * A scores site with nothing on it reads as broken, so an empty state is the
 * last resort: with nothing live and no kickoff in the near window, the block
 * leads with recent results and the heading says that is what they are. Only
 * when there is genuinely nothing — no live, no fixture, no result — does the
 * heading say so, because the alternative is a heading that promises results
 * above a block that has none.
 */
export type WhatsOnMode = 'live' | 'upcoming' | 'recent' | 'none';

export interface Bilingual {
  en: string;
  es: string;
}

/**
 * How far ahead a fixture still counts as "what's on".
 *
 * `getLiveWindow` reads -7/+14 days, and every scheduled match in it lands in
 * the upcoming bucket. Without a bound the upcoming branch always wins, so the
 * dead-day fallback below it is unreachable: on a quiet day the page led with
 * fixtures a fortnight out and said "next kickoff in about 12 days" while a
 * week of finished results sat unused in the same payload. A day is the bound
 * because "what's on" is a today question — beyond that, what just happened is
 * the more interesting answer.
 */
export const UPCOMING_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Which of the four things the block shows, and the rows it shows.
 *
 * The ladder is live → a kickoff inside the horizon → recent results → a
 * distant fixture → nothing. The distant fixture sits *below* results
 * deliberately: a result from four hours ago is news, a fixture nine days out
 * is not. It stays on the ladder at all so that a competition's opening
 * weekend, where there are no results yet, still shows something.
 *
 * The horizon has to bound the *pool*, not just which branch wins. The whole
 * +14-day window lands in `upcoming`, so one kickoff two hours away used to
 * elect the upcoming branch and then hand the caller next week's fixtures
 * along with it: five rows a week out under a heading that reads "What's on".
 * The imminent branch therefore returns only the fixtures inside the horizon.
 *
 * The last-resort branch below results stays unfiltered on purpose — by then
 * every fixture is outside the horizon by definition, and filtering there
 * would empty the one thing an opening weekend has to show.
 *
 * `msUntilKickoff` is a function rather than a precomputed number so that the
 * branch decision and the rows it returns cannot be measured against
 * different clocks.
 */
export function chooseWhatsOn<T>(
  buckets: { live: T[]; upcoming: T[]; recent: T[] },
  msUntilKickoff: (item: T) => number,
): { mode: WhatsOnMode; pool: T[] } {
  const { live, upcoming, recent } = buckets;
  if (live.length > 0) return { mode: 'live', pool: live };
  const imminent = upcoming.filter((item) => msUntilKickoff(item) <= UPCOMING_HORIZON_MS);
  if (imminent.length > 0) return { mode: 'upcoming', pool: imminent };
  if (recent.length > 0) return { mode: 'recent', pool: recent };
  if (upcoming.length > 0) return { mode: 'upcoming', pool: upcoming };
  return { mode: 'none', pool: [] };
}

/**
 * How far off the next kickoff is, in plain words.
 *
 * A duration is the difference between two instants, so it is the one time
 * fact that is safe to format on the server: unlike "Thursday 8pm", it means
 * the same thing in every timezone. Deliberately approximate — "in about 4
 * hours" cannot be wrong by the time the page is read the way "in 3h 58m" can.
 */
export function untilKickoff(ms: number): Bilingual | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return {
      en: minutes <= 1 ? 'in a minute' : `in ${minutes} minutes`,
      es: minutes <= 1 ? 'en un minuto' : `en ${minutes} minutos`,
    };
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return {
      en: hours === 1 ? 'in about an hour' : `in about ${hours} hours`,
      es: hours === 1 ? 'en aproximadamente una hora' : `en aproximadamente ${hours} horas`,
    };
  }
  const days = Math.round(hours / 24);
  return {
    en: days === 1 ? 'in about a day' : `in about ${days} days`,
    es: days === 1 ? 'en aproximadamente un día' : `en aproximadamente ${days} días`,
  };
}

/**
 * How long ago an article was published, in plain words.
 *
 * The same reasoning as `untilKickoff`: a duration is timezone-free, so it is
 * safe to compute on a server running UTC and hand to a client component as a
 * finished string. This is what a news row says about itself instead of naming
 * the competition feed it arrived through — the per-league /news endpoints are
 * mostly generic, so that label was wrong on most rows.
 *
 * It does not re-tick while a tab sits open, and that is a judgement rather
 * than a constraint. A mount-time clock would be perfectly hydration-safe --
 * `useLocalNow` does exactly that, on this same page, in DigestMatches -- so
 * "it would break hydration" is not the reason and must not be recorded as one.
 * The reason is that the error equals the tab's open time against a label whose
 * granularity is already coarse, and both pages are force-dynamic, so arriving
 * or reloading is always correct.
 */
export function publishedAgo(ms: number): Bilingual | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    return {
      en: minutes <= 1 ? 'just now' : `${minutes} minutes ago`,
      es: minutes <= 1 ? 'ahora mismo' : `hace ${minutes} minutos`,
    };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return {
      en: hours === 1 ? '1 hour ago' : `${hours} hours ago`,
      es: hours === 1 ? 'hace 1 hora' : `hace ${hours} horas`,
    };
  }
  const days = Math.floor(hours / 24);
  return {
    en: days === 1 ? '1 day ago' : `${days} days ago`,
    es: days === 1 ? 'hace 1 día' : `hace ${days} días`,
  };
}

/**
 * The line under the digest's title. It states which of the four things the
 * block is showing, so "recent results" is never mistaken for "what's next"
 * and an empty block is never introduced as a list of results.
 *
 * `count` is the number of rows the block actually renders — after dedupe and
 * after the cap. Taking it from the raw entry list made the heading claim "4
 * matches live right now" above three cards, because two competitions carry
 * the same provider event id for a club playing in both.
 */
export function whatsOnHeadline(
  mode: WhatsOnMode,
  count: number,
  msToNextKickoff: number | null,
): Bilingual {
  if (mode === 'live') {
    return {
      en: count === 1 ? '1 match live right now.' : `${count} matches live right now.`,
      es: count === 1 ? '1 partido en vivo ahora mismo.' : `${count} partidos en vivo ahora mismo.`,
    };
  }
  if (mode === 'upcoming') {
    const away = msToNextKickoff === null ? null : untilKickoff(msToNextKickoff);
    if (!away) {
      return {
        en: 'Nothing live right now — here is what is next.',
        es: 'Nada en vivo ahora mismo — esto es lo que sigue.',
      };
    }
    return {
      en: `Nothing live right now — next kickoff ${away.en}.`,
      es: `Nada en vivo ahora mismo — próximo silbatazo ${away.es}.`,
    };
  }
  if (mode === 'none') {
    return {
      en: 'Nothing live, nothing next, nothing just played — the window is empty.',
      es: 'Nada en vivo, nada por jugarse, nada recién jugado — la ventana está vacía.',
    };
  }
  return {
    en: 'Nothing live right now — here are the latest results.',
    es: 'Nada en vivo ahora mismo — estos son los últimos resultados.',
  };
}

/**
 * A story as the UI shows it: the article, and how old it is in plain words.
 *
 * The age replaced the competition-feed label. ESPN's per-league /news is
 * mostly generic — measured, four of six rows were tagged with a competition
 * the article had nothing to do with — and the tag was arbitrary as well,
 * since the cross-feed dedupe keeps whichever copy sorts first. Recency is the
 * one thing a story row can say about itself that is always true.
 *
 * Computed on the server as a duration, which is timezone-free, so it cannot
 * disagree with the client the way a formatted wall clock would.
 *
 * It lives here rather than on the component so the server module that builds
 * these rows and the client component that renders them share one definition
 * without either importing the other.
 */
export interface DigestNewsItem {
  article: NewsArticle;
  ago: Bilingual | null;
}

/**
 * The stories worth showing, across every competition's feed.
 *
 * Per-feed cap first, so one busy competition cannot crowd out another's lead
 * story; then dedupe, because ESPN publishes the same wire article under
 * several leagues; then newest first, with the id as a tie-break so two
 * articles sharing a publish timestamp always sort the same way.
 */
export function collectStories(
  perCompetition: NewsArticle[][],
  { perFeed, limit }: { perFeed: number; limit: number },
): NewsArticle[] {
  const seen = new Set<string>();
  const unique: NewsArticle[] = [];
  for (const feed of perCompetition) {
    for (const article of feed.slice(0, perFeed)) {
      if (seen.has(article.id)) continue;
      seen.add(article.id);
      unique.push(article);
    }
  }
  // An unparseable `published` sorts oldest rather than poisoning the
  // comparator: NaN makes every comparison false and the order arbitrary.
  const at = (article: NewsArticle) => {
    const t = new Date(article.published).getTime();
    return Number.isNaN(t) ? -Infinity : t;
  };
  return unique
    .sort((a, b) => (at(b) !== at(a) ? at(b) - at(a) : a.id.localeCompare(b.id)))
    .slice(0, limit);
}
