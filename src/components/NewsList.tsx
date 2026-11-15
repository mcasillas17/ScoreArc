'use client';

import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatRelativeTime } from '@/i18n/format';
import type { NewsArticle } from '@/server/data/types';
import NewsRow from './NewsRow';

/** A competition's own stories: the shared row, with description and byline. */
export default function NewsList({ articles }: { articles: NewsArticle[] }) {
  const locale = useLocale();
  const t = useTranslations();
  if (articles.length === 0) {
    return <p className="empty-text">{t('news.unavailable')}</p>;
  }
  const now = new Date();
  return (
    <div className="dg-news dg-news--detail dg-onecol">
      {articles.map((a) => {
        const published = new Date(a.published);
        const ago = Number.isNaN(published.getTime())
          ? null
          : Math.abs(now.getTime() - published.getTime()) < 60_000
            ? t('time.justNow')
            : formatRelativeTime(published, now, locale);
        return <NewsRow key={a.id} article={a} ago={ago} surface="competition" detail />;
      })}
    </div>
  );
}
