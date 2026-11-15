'use client';

import type { DigestNewsItem } from '@/lib/digest';
import { useTranslations } from '@/i18n/I18nProvider';
import NewsRow from './NewsRow';

/**
 * A compact list with small thumbnails, deliberately NOT a hero.
 *
 * A 16:9 lead image makes whatever the provider ranked first the largest
 * object on the home page. The day this was designed that was "Adidas drops
 * dog kits", which is exactly the editorial decision we are not in a position
 * to make.
 *
 * `thumbs="first"` pictures only the newest story and lists the rest as
 * headlines: thirty thumbnails in a column is thirty things asking to be
 * looked at, and it was the reason /news read as clutter.
 */
export default function DigestNews({
  items,
  surface,
  thumbs = 'all',
}: {
  items: DigestNewsItem[];
  surface: string;
  thumbs?: 'all' | 'first';
}) {
  const t = useTranslations();
  if (items.length === 0) {
    return (
      <p className="dg-empty">{t('home.digest.newsUnavailable')}</p>
    );
  }
  return (
    <div className="dg-news">
      {items.map(({ article, ago }, i) => (
        <NewsRow
          key={article.id}
          article={article}
          ago={ago}
          surface={surface}
          image={thumbs === 'all' || i === 0}
        />
      ))}
    </div>
  );
}
