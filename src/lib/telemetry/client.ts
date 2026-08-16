'use client';

import { track } from '@vercel/analytics';

type EventProperties = Record<string, string | number | boolean | null | undefined>;

export function trackEvent(name: string, properties?: EventProperties) {
  track(name, properties);
}

export function trackFeedFailure(feed: string, status?: number) {
  trackEvent('Live feed unavailable', { feed, status });
}

export function trackFeedRecovery(feed: string) {
  trackEvent('Live feed recovered', { feed });
}
