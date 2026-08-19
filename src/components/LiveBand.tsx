'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { LiveEntry } from '@/server/data/liveFeed';
import { matchPriority } from '@/server/data/matchPriority';
import { trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import { kickoffTime } from './MatchRow';

const REFRESH_MS = 30_000;

// How many rows each mode shows. A band is a glance, not a list -- the
// competition tiles below it are the way into everything else.
const LIVE_SHOWN = 6;
const SIDE_SHOWN = 3;

interface Props {
  initialEntries: LiveEntry[];
}

function scoreLine(entry: LiveEntry): string {
  const { match } = entry;
  if (match.state === 'scheduled') return kickoffTime(match.kickoff);
  return `${match.homeScore ?? 0}–${match.awayScore ?? 0}`;
}

function EntryRow({ entry, tone }: { entry: LiveEntry; tone: 'live' | 'next' | 'recent' }) {
  const { competition, match } = entry;
  // The centre already shows a scheduled match's kickoff time, so the detail
  // slot carries only what the centre cannot: which day it is on. Today needs
  // no day at all, and printing the time twice is what the first cut did.
  const detail = match.state === 'live'
    ? (match.minute ?? match.statusDetail)
    : match.state === 'finished'
      ? (match.statusDetail || 'FT')
      : kickoffDay(match.kickoff);

  return (
    <Link
      href={`/c/${competition.id}/${competition.seasonId}/matches`}
      className={`lb-row lb-row--${tone}`}
      aria-label={`${match.home.name} versus ${match.away.name}, ${detail}, ${competition.name}`}
    >
      <span className="lb-teams">
        <span className="lb-team">{match.home.abbr}</span>
        <strong className="lb-score">{scoreLine(entry)}</strong>
        <span className="lb-team">{match.away.abbr}</span>
      </span>
      <span className="lb-meta">
        <span className="lb-comp">{competition.emblem} {competition.shortName}</span>
        {detail && <span className="lb-detail">{detail}</span>}
      </span>
    </Link>
  );
}

function kickoffDay(iso: string): string {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return 'Today';
  return d.toLocaleDateString([], { weekday: 'long' });
}

/**
 * The fixture band across the top of the home page.
 *
 * One slot, three modes by priority: anything in play wins; otherwise it shows
 * what just happened beside what is coming; and when it has neither it renders
 * nothing rather than a heading over an empty row.
 *
 * Bucketing happens **after mount**, deliberately. The server runs UTC and a
 * reader in UTC-6 disagrees with it about which day an 8pm kickoff falls on, so
 * a server-rendered "later today" would hydrate into a different set of rows
 * than the client computes -- on exactly the matches people care about most.
 * Until mount we render the server's list unbucketed, which is stable in both
 * places.
 */
export default function LiveBand({ initialEntries }: Props) {
  const [entries, setEntries] = useState<LiveEntry[]>(initialEntries);
  const [mounted, setMounted] = useState(false);
  const failing = useRef(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const next = await res.json();
        if (!alive) return;
        if (!Array.isArray(next)) throw new Error('not an array');
        // Keep the last good feed on a bad one: an empty band is a worse
        // answer than a slightly stale one.
        setEntries(next);
        if (failing.current) {
          trackFeedRecovery('live');
          failing.current = false;
        }
      } catch {
        if (!alive || failing.current) return;
        trackFeedFailure('live');
        failing.current = true;
      }
    }
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const { live, upcoming, recent } = useMemo(
    () => {
      const buckets = matchPriority(entries.map((e) => e.match), new Date());
      const byId = new Map(entries.map((e) => [e.match.id, e]));
      const pick = (ms: typeof buckets.live) =>
        ms.map((m) => byId.get(m.id)).filter((e): e is LiveEntry => e !== undefined);
      return { live: pick(buckets.live), upcoming: pick(buckets.upcoming), recent: pick(buckets.recent) };
    },
    // `mounted` is a dependency because the first pass runs on the server's
    // clock and the second must re-run on the reader's.
    [entries, mounted],
  );

  if (live.length > 0) {
    return (
      <section className="lb" aria-label="Live matches">
        <h2 className="lb-title lb-title--live">
          <span className="lb-ping" aria-hidden />
          Live now · {live.length}
        </h2>
        <div className="lb-grid">
          {live.slice(0, LIVE_SHOWN).map((e) => (
            <EntryRow key={e.match.id} entry={e} tone="live" />
          ))}
        </div>
      </section>
    );
  }

  if (recent.length === 0 && upcoming.length === 0) return null;

  return (
    <section className="lb" aria-label="Recent and upcoming matches">
      <div className="lb-split">
        {recent.length > 0 && (
          <div className="lb-col">
            <h2 className="lb-title">Just finished</h2>
            <div className="lb-list">
              {recent.slice(0, SIDE_SHOWN).map((e) => (
                <EntryRow key={e.match.id} entry={e} tone="recent" />
              ))}
            </div>
          </div>
        )}
        {upcoming.length > 0 && (
          <div className="lb-col">
            <h2 className="lb-title lb-title--next">Next up</h2>
            <div className="lb-list">
              {upcoming.slice(0, SIDE_SHOWN).map((e) => (
                <EntryRow key={e.match.id} entry={e} tone="next" />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
