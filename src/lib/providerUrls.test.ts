import { describe, expect, it } from 'vitest';
import {
  isSafeHttpsUrl,
  sanitizeNewsArticleUrl,
  sanitizeProviderMediaUrl,
} from './providerUrls';

describe('providerUrls', () => {
  it('validates generic safe HTTPS URLs without allowing schemes, creds, or custom ports', () => {
    expect(isSafeHttpsUrl('https://www.espn.com/story')).toBe(true);
    expect(isSafeHttpsUrl('https://WWW.ESPN.COM:443/story')).toBe(true);
    for (const bad of [
      null,
      undefined,
      '',
      ' https://www.espn.com/story',
      'http://www.espn.com/story',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://user:pass@www.espn.com/story',
      'https://www.espn.com:8443/story',
      '/relative/path',
    ]) {
      expect(isSafeHttpsUrl(bad)).toBe(false);
    }
  });

  it('allows editorial ESPN domains for news article links and rejects lookalikes', () => {
    for (const ok of [
      'https://www.espn.com/soccer/story/_/id/1',
      'https://espn.com/soccer/story',
      'https://www.espn.co.uk/football/story/_/id/1',
      'https://www.espn.com.mx/futbol/nota/_/id/1',
      'https://www.espndeportes.com/futbol/nota/_/id/1',
      'https://www.andscape.com/features/story',
    ]) {
      expect(sanitizeNewsArticleUrl(ok)).toBe(ok);
    }

    for (const bad of [
      'http://www.espn.com/soccer/story',
      'https://evil.example/story',
      'https://espn.com.evil.test/story',
      'https://notespn.com/story',
      'https://user@www.espn.com/story',
      'https://www.espn.com:8443/story',
      'https://127.0.0.1/story',
      'javascript:alert(1)',
    ]) {
      expect(sanitizeNewsArticleUrl(bad)).toBe('');
    }
  });

  it('allows ESPN CDN/video media hosts and Akamai WSC host only', () => {
    for (const ok of [
      'https://a.espncdn.com/photo/2026/img.jpg',
      'https://media.video-cdn.espn.com/motion/clip.mp4',
      'https://media.video-origin.espn.com/motion/clip.mp4',
      'https://espnmedia-cdn.akamaized.net/espn/media/clip.mp4',
    ]) {
      expect(sanitizeProviderMediaUrl(ok)).toBe(ok);
    }

    for (const bad of [
      'http://a.espncdn.com/photo/img.jpg',
      'http://media.video-cdn.espn.com/motion/clip.mp4',
      'https://evil.akamaized.net/clip.mp4',
      'https://espnmedia-cdn.akamaized.net.evil.test/clip.mp4',
      'https://user@a.espncdn.com/photo/img.jpg',
      'https://a.espncdn.com:8443/photo/img.jpg',
      'javascript:alert(1)',
    ]) {
      expect(sanitizeProviderMediaUrl(bad)).toBeNull();
    }
  });
});
