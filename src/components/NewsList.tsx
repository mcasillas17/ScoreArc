import type { NewsArticle } from '@/server/data/types';

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function NewsCard({ a }: { a: NewsArticle }) {
  return (
    <a className="nw-card" href={a.url} target="_blank" rel="noreferrer">
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
          <span>{a.byline || 'ESPN'}</span>
          {a.published && (
            <span suppressHydrationWarning className="nw-time">
              {relTime(a.published)}
            </span>
          )}
        </div>
      </div>
    </a>
  );
}

export default function NewsList({ articles }: { articles: NewsArticle[] }) {
  if (articles.length === 0) {
    return <p className="empty-text">News is unavailable right now.</p>;
  }
  return (
    <div className="nw-grid">
      {articles.map((a) => (
        <NewsCard key={a.id} a={a} />
      ))}
    </div>
  );
}
