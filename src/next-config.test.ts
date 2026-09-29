import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

const redirects = nextConfig.redirects;

if (!redirects) {
  throw new Error('nextConfig.redirects is required');
}

describe('legacy fixtures redirects', () => {
  it.each([
    ['/c/:comp/:season/fixtures', '/c/:comp/:season/matches'],
    ['/:locale(en|es)/c/:comp/:season/fixtures', '/:locale/c/:comp/:season/matches'],
  ])('redirects %s to %s permanently', async (source, destination) => {
    const configuredRedirects = await redirects();

    expect(configuredRedirects).toContainEqual({ source, destination, permanent: true });
  });
});
