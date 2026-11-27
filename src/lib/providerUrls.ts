const ARTICLE_DOMAINS = [
  'espn.com',
  'espn.co.uk',
  'espn.com.mx',
  'espn.com.ar',
  'espn.com.br',
  'espn.com.co',
  'espn.com.au',
  'espn.cl',
  'espn.in',
  'espndeportes.com',
  'espnfc.com',
  'andscape.com',
] as const;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function parseSafeHttps(raw: unknown): { url: URL; raw: string } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.port !== '' && parsed.port !== '443')
  ) {
    return null;
  }
  return { url: parsed, raw };
}

/** Rejects non-HTTPS URLs, embedded credentials, non-443 ports, and whitespace padding. */
export function isSafeHttpsUrl(raw: unknown): raw is string {
  return parseSafeHttps(raw) !== null;
}

/** Returns raw when it is a safe HTTPS URL on an editorial ESPN domain, otherwise ''. */
export function sanitizeNewsArticleUrl(raw: unknown): string {
  const parsed = parseSafeHttps(raw);
  if (!parsed) return '';
  const host = parsed.url.hostname.toLowerCase();
  return ARTICLE_DOMAINS.some((domain) => hostMatches(host, domain)) ? parsed.raw : '';
}

/** Returns raw when it is a safe HTTPS URL on an allowed ESPN CDN/video host, otherwise null. */
export function sanitizeProviderMediaUrl(raw: unknown): string | null {
  const parsed = parseSafeHttps(raw);
  if (!parsed) return null;
  const host = parsed.url.hostname.toLowerCase();
  if (
    hostMatches(host, 'espncdn.com') ||
    hostMatches(host, 'espn.com') ||
    host === 'espnmedia-cdn.akamaized.net'
  ) {
    return parsed.raw;
  }
  return null;
}
