/**
 * Builds a /api/og URL. Every caller goes through here so each card carries
 * the same versioned shape — and so a cache-buster bump is ONE edit. WhatsApp
 * and friends cache previews by exact URL: bump OG_VERSION whenever the card's
 * rendering changes, or shares keep showing the old art indefinitely.
 */
export const OG_VERSION = '3';

export function ogUrl(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  search.set('v', OG_VERSION);
  return `/api/og?${search.toString()}`;
}

/** The openGraph + twitter block every card-bearing route repeats — one
 *  shape, four call sites, zero drift. type/siteName are restated because
 *  Next replaces an inherited openGraph wholesale, not per-field. */
export function shareMetadata(title: string, description: string, og: string) {
  return {
    openGraph: {
      title,
      description,
      type: 'website' as const,
      siteName: 'ScoreArc',
      images: [{ url: og, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image' as const, title, description, images: [og] },
  };
}

// Crest images travel inside share URLs, which anyone can craft. Rendering an
// arbitrary ?crest= would make /api/og an open image proxy, so only the hosts
// our own data layer serves crests from are honored — and the card route and
// the page that echoes crest into its alternates both use THIS check.
const CREST_HOSTS = new Set(['a.espncdn.com', 'r2.thesportsdb.com']);

export function safeCrest(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !CREST_HOSTS.has(u.hostname)) return null;
    // Normalized, credentials stripped: satori cannot fetch a credentialed
    // URL, which would render as a phantom gap where the crest should be.
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return null;
  }
}
