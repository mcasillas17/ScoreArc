import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../next.config.mjs';

const redirects = nextConfig.redirects;
const headers = nextConfig.headers;

if (!redirects) {
  throw new Error('nextConfig.redirects is required');
}
if (!headers) {
  throw new Error('nextConfig.headers is required');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('legacy fixtures redirects', () => {
  it.each([
    ['/c/:comp/:season/fixtures', '/c/:comp/:season/matches'],
    ['/:locale(en|es)/c/:comp/:season/fixtures', '/:locale/c/:comp/:season/matches'],
  ])('redirects %s to %s permanently', async (source, destination) => {
    const configuredRedirects = await redirects();

    expect(configuredRedirects).toContainEqual({ source, destination, permanent: true });
  });
});

describe('security headers', () => {
  it('defines all six security headers on /:path* and omits upgrade-insecure-requests in non-production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const entries = await headers();
    const root = entries.find((entry) => entry.source === '/:path*');
    expect(root).toBeDefined();
    const byKey = new Map(root!.headers.map((h) => [h.key, h.value]));

    expect(byKey.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
    expect(byKey.get('X-Frame-Options')).toBe('DENY');
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(byKey.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');

    const csp = byKey.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('includes upgrade-insecure-requests and excludes unsafe-eval in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const entries = await headers();
    const root = entries.find((entry) => entry.source === '/:path*');
    const byKey = new Map(root!.headers.map((h) => [h.key, h.value]));
    const csp = byKey.get('Content-Security-Policy') ?? '';

    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
