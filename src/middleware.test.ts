import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import middleware from './middleware';

const request = (path: string, headers?: HeadersInit) =>
  new NextRequest(`https://www.scorearc.futbol${path}`, { headers });

describe('locale middleware', () => {
  it('keeps a prefixed URL authoritative', () => {
    const response = middleware(request('/es/c/world-cup/2026', {
      cookie: 'scorearc-language=en',
      'accept-language': 'en-US',
    }));
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects an unprefixed URL and preserves its query', () => {
    const response = middleware(request('/c/world-cup/2026?view=now', {
      'accept-language': 'es-MX,es;q=0.9',
    }));
    expect(response.headers.get('location')).toBe(
      'https://www.scorearc.futbol/es/c/world-cup/2026?view=now',
    );
  });

  it('replaces an unsupported locale-looking segment', () => {
    const response = middleware(request('/fr/c/world-cup/2026'));
    expect(response.headers.get('location')).toBe(
      'https://www.scorearc.futbol/en/c/world-cup/2026',
    );
  });

  it.each([
    '/api/world-cup/2026/matches',
    '/_next/static/chunks/app.js',
    '/brand/scorearc.svg',
    '/favicon.ico',
  ])('does not localize excluded path %s', (path) => {
    expect(middleware(request(path)).headers.get('location')).toBeNull();
  });

  it('uses the deterministic default for invalid negotiation input', () => {
    const response = middleware(request('/matches', {
      cookie: 'scorearc-language=javascript:alert(1)',
      'accept-language': 'es;q=not-a-number',
    }));
    expect(response.headers.get('location')).toBe('https://www.scorearc.futbol/en/matches');
  });
});
