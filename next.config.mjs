/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dev indicator defaults to bottom-left, which is exactly where the
  // rail's pin button and the phone bar's first tab are. Dev only.
  env: {
    SCOREARC_WEBSITE_STAGING_EDITIONS: process.env.SCOREARC_ENV === 'staging' && process.env.VERCEL_ENV !== 'production'
      ? (process.env.SCOREARC_STAGING_EDITIONS ?? '').split(',').map(scope => scope.trim()).join(',')
      : '',
  },
  devIndicators: { position: 'top-right' },
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"} https://va.vercel-scripts.com`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://*.espncdn.com https://*.espn.com https://espnmedia-cdn.akamaized.net https://cdn.scorearc.futbol https://flagcdn.com https://r2.thesportsdb.com",
      "media-src 'self' https://media.video-cdn.espn.com https://*.espn.com https://*.espncdn.com https://espnmedia-cdn.akamaized.net",
      "font-src 'self' data:",
      "connect-src 'self' https://vitals.vercel-insights.com https://va.vercel-scripts.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(isProd ? ['upgrade-insecure-requests'] : []),
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // The calendar page was /fixtures until 2026-08-18. "Fixtures" is British
      // idiom on a Liga MX-first product; the page is now /matches. Permanent,
      // because the old path is live in production and may already be linked.
      //
      // The API route keeps its /fixtures name deliberately: /api/.../matches
      // already exists and serves the current week only, so renaming that one
      // would collide with a different endpoint.
      // Localized prefixes are authoritative in middleware, so each supported
      // locale needs a redirect that keeps the reader on that locale.
      {
        source: '/:locale(en|es)/c/:comp/:season/fixtures',
        destination: '/:locale/c/:comp/:season/matches',
        permanent: true,
      },
      {
        source: '/c/:comp/:season/fixtures',
        destination: '/c/:comp/:season/matches',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
