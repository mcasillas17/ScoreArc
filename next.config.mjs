/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      // The calendar page was /fixtures until 2026-08-18. "Fixtures" is British
      // idiom on a Liga MX-first product; the page is now /matches. Permanent,
      // because the old path is live in production and may already be linked.
      //
      // The API route keeps its /fixtures name deliberately: /api/.../matches
      // already exists and serves the current week only, so renaming that one
      // would collide with a different endpoint.
      {
        source: '/c/:comp/:season/fixtures',
        destination: '/c/:comp/:season/matches',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
