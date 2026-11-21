import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    // /api is JSON for our own pages; crawling it only spends provider reads.
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: 'https://www.scorearc.futbol/sitemap.xml',
  };
}
