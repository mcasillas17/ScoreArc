'use client';

import type { NewsArticle } from '@/server/data/types';
import { trackEvent } from '@/lib/telemetry/client';
import LanguageText from './LanguageText';

export interface DigestNewsItem {
  article: NewsArticle;
  /** Which competition's feed it came from — the row's only provenance. */
  source: string;
}

/**
 * A compact list with small thumbnails, deliberately NOT a hero.
 *
 * A 16:9 lead image makes whatever the provider ranked first the largest
 * object on the home page. The day this was designed that was "Adidas drops
 * dog kits", which is exactly the editorial decision we are not in a position
 * to make.
 */
export default function DigestNews({ items }: { items: DigestNewsItem[] }) {
  if (items.length === 0) {
    return (
      <p className="dg-empty">
        <LanguageText en="News is unavailable right now." es="Las noticias no están disponibles en este momento." />
      </p>
    );
  }
  return (
    <div className="dg-news">
      {items.map(({ article, source }) => (
        <a
          className="dg-nw"
          key={article.id}
          href={article.url}
          target="_blank"
          rel="noreferrer"
          onClick={() => trackEvent('News article opened', { surface: 'digest' })}
        >
          {article.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="dg-nwimg" src={article.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className="dg-nwimg dg-nwimg--blank" aria-hidden>⚽</span>
          )}
          <span className="dg-nwbody">
            <span className="dg-nwhead">{article.headline}</span>
            <span className="dg-nwsrc">{source}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
