import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { NewsArticle } from '@/server/data/types';
import NewsLive from '@/components/NewsLive';
import LanguageText from '@/components/LanguageText';
import SiteFooter from '@/components/SiteFooter';

export const dynamic = 'force-dynamic';

export default async function NewsPage({ params }: { params: { comp: string; season: string } }) {
  const rc = resolveSeason(params.comp, params.season);
  if (!rc) notFound();
  const apiBase = `/api/${rc.competition.id}/${rc.season.id}`;
  let news: NewsArticle[] = [];
  try {
    news = await dataStore.getNews(rc);
  } catch {
    // ESPN feed unavailable — render empty state
  }

  return (
    <main className="main">
      <section id="news">
        <header className="page-head">
          <p className="bracket-eyebrow">{rc.competition.name}</p>
          <h1 className="bracket-title"><LanguageText en="News" es="Noticias" /></h1>
          <p className="page-subtitle"><LanguageText en="Latest headlines from around the tournament." es="Las últimas noticias del torneo." /></p>
        </header>

        {news.length > 0 ? (
          <NewsLive initial={news} apiBase={apiBase} />
        ) : (
          <div className="empty-section">
            <p className="empty-text"><LanguageText en="News is unavailable right now." es="Las noticias no están disponibles en este momento." /></p>
          </div>
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
