'use client';

import { useState, useEffect, useRef } from 'react';
import type { NewsArticle } from '@/server/data/types';
import NewsList from './NewsList';
import { trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';

// Refresh headlines periodically (news changes slowly, so a gentle cadence).
interface Props {
  initial: NewsArticle[];
  apiBase: string;
}

export default function NewsLive({ initial, apiBase }: Props) {
  const [news, setNews] = useState<NewsArticle[]>(initial);
  const feedFailed = useRef(false);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch(`${apiBase}/news`, { cache: 'no-store' });
        if (!mounted) return;
        if (res.ok) {
          const data = (await res.json()) as NewsArticle[];
          if (!mounted) return;
          if (mounted && Array.isArray(data) && data.length) setNews(data);
          if (feedFailed.current) {
            trackFeedRecovery('news');
            feedFailed.current = false;
          }
        } else if (!feedFailed.current) {
          trackFeedFailure('news', res.status);
          feedFailed.current = true;
        }
      } catch {
        if (!mounted) return;
        if (!feedFailed.current) {
          trackFeedFailure('news');
          feedFailed.current = true;
        }
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
