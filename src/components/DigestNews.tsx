'use client';

import type { NewsArticle } from '@/server/data/types';
import type { Bilingual } from '@/lib/digest';
import { trackEvent } from '@/lib/telemetry/client';
import LanguageText from './LanguageText';

export interface DigestNewsItem {
  article: NewsArticle;
  /**
   * How long ago it was published, already worded, in both languages.
   *
   * This replaced the competition-feed label. ESPN's per-league /news is mostly
   * generic — measured, four of six rows were tagged with a competition the
   * article had nothing to do with — and the tag was arbitrary as well, since
   * the cross-feed dedupe keeps whichever copy sorts first. Recency is the one
   * thing a story row can say about itself that is always true.
   *
   * Computed on the server as a duration, which is timezone-free, so it cannot
   * disagree with the client the way a formatted wall clock would.
   */
  ago: Bilingual | null;
}

/**
 * A compact list with small thumbnails, deliberately NOT a hero.
 *
 * A 16:9 lead image makes whatever the provider ranked first the largest
 * object on the home page. The day this was designed that was "Adidas drops
 * dog kits", which is exactly the editorial decision we are not in a position
 * to make.
 */
export default function DigestNews({ items, surface }: { items: DigestNewsItem[]; surface: string }) {
  if (items.length === 0) {
    return (
      <p className="dg-empty">
        <LanguageText en="News is unavailable right now." es="Las noticias no están disponibles en este momento." />
      </p>
    );
  }
  return (
    <div className="dg-news">
      {items.map(({ article, ago }) => (
        <a
          className="dg-nw"
          key={article.id}
          href={article.url}
          target="_blank"
          rel="noreferrer"
          onClick={() => trackEvent('News article opened', { surface })}
        >
          {article.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="dg-nwimg" src={article.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className="dg-nwimg dg-nwimg--blank" aria-hidden>⚽</span>
          )}
          <span className="dg-nwbody">
            <span className="dg-nwhead">{article.headline}</span>
            {ago && (
              <span className="dg-nwsrc">
                <LanguageText en={ago.en} es={ago.es} />
              </span>
            )}
          </span>
        </a>
      ))}
    </div>
  );
}
