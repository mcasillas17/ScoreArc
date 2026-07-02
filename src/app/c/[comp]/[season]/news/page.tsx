import { notFound } from 'next/navigation';
import { resolveSeason } from '@/server/data/competitions';
import { dataStore } from '@/server/data/store';
import type { NewsArticle } from '@/server/data/types';
import NewsLive from '@/components/NewsLive';

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
          <h1 className="bracket-title">News</h1>
          <p className="page-subtitle">Latest headlines from around the tournament.</p>
        </header>

        {news.length > 0 ? (
          <NewsLive initial={news} apiBase={apiBase} />
        ) : (
          <div className="empty-section">
            <p className="empty-text">News is unavailable right now.</p>
          </div>
        )}
      </section>

      <footer className="site-footer">
        <p>ScoreArc · Data via ESPN · Not affiliated with FIFA</p>
      </footer>
    </main>
  );
}
