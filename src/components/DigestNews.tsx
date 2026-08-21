'use client';

import type { DigestNewsItem } from '@/lib/digest';
import { trackEvent } from '@/lib/telemetry/client';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';

/**
 * A compact list with small thumbnails, deliberately NOT a hero.
 *
 * A 16:9 lead image makes whatever the provider ranked first the largest
 * object on the home page. The day this was designed that was "Adidas drops
 * dog kits", which is exactly the editorial decision we are not in a position
 * to make.
 */
export default function DigestNews({ items, surface }: { items: DigestNewsItem[]; surface: string }) {
  const locale = useLocale();
  const t = useTranslations();
  if (items.length === 0) {
    return (
      <p className="dg-empty">{t('home.digest.newsUnavailable')}</p>
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
              <span className="dg-nwsrc">{ago[locale]}</span>
            )}
          </span>
        </a>
      ))}
    </div>
  );
}
