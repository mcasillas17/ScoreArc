'use client';

import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatRelativeTime } from '@/i18n/format';
import type { NewsArticle } from '@/server/data/types';
import { trackEvent } from '@/lib/telemetry/client';

function NewsCard({ a }: { a: NewsArticle }) {
  const locale = useLocale();
  const t = useTranslations();
  const publishedAt = a.published ? new Date(a.published) : null;
  const publishedTime = publishedAt && !Number.isNaN(publishedAt.getTime())
    ? Math.abs(Date.now() - publishedAt.getTime()) < 60_000
      ? t('time.justNow')
      : formatRelativeTime(publishedAt, new Date(), locale)
    : null;

  return (
    <a className="nw-card" href={a.url} target="_blank" rel="noreferrer" onClick={() => trackEvent('News article opened')}>
      {a.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="nw-img" src={a.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="nw-img nw-img-fallback">⚽</div>
      )}
      <div className="nw-body">
        <h3 className="nw-headline">{a.headline}</h3>
        {a.description && <p className="nw-desc">{a.description}</p>}
        <div className="nw-meta">
          <span>{a.byline || t('news.defaultByline')}</span>
          {publishedTime && (
            <span suppressHydrationWarning className="nw-time">
              {publishedTime}
            </span>
          )}
        </div>
      </div>
    </a>
  );
}

export default function NewsList({ articles }: { articles: NewsArticle[] }) {
  const t = useTranslations();
  if (articles.length === 0) {
    return <p className="empty-text">{t('news.unavailable')}</p>;
  }
  return (
    <div className="nw-grid">
      {articles.map((a) => (
        <NewsCard key={a.id} a={a} />
      ))}
    </div>
  );
}
