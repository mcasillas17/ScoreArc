import { dataService } from "@/server/data/service";
import type { NewsArticle } from "@/server/data/types";
import NewsLive from "@/components/NewsLive";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ScoreArc · World Cup News",
  description: "Latest FIFA World Cup 2026 headlines, match reports, and stories.",
};

export default async function NewsPage() {
  let news: NewsArticle[] = [];
  try {
    news = await dataService.getNews();
  } catch {
    // ESPN feed unavailable — render empty state
  }

  return (
    <main className="main">
      <section id="news">
        <header className="page-head">
          <p className="bracket-eyebrow">FIFA World Cup 2026</p>
          <h1 className="bracket-title">News</h1>
          <p className="page-subtitle">Latest headlines from around the tournament.</p>
        </header>

        {news.length > 0 ? (
          <NewsLive initial={news} />
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
