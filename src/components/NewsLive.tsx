'use client';

import { useState, useEffect } from 'react';
import type { NewsArticle } from '@/server/data/types';
import NewsList from './NewsList';

// Refresh headlines periodically (news changes slowly, so a gentle cadence).
export default function NewsLive({ initial }: { initial: NewsArticle[] }) {
  const [news, setNews] = useState<NewsArticle[]>(initial);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch('/api/news', { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as NewsArticle[];
          if (mounted && Array.isArray(data) && data.length) setNews(data);
        }
      } catch {
        // ignore — next tick retries
      }
    }
    const id = setInterval(poll, 150_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  return <NewsList articles={news} />;
}
