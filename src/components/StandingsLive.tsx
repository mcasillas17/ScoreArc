'use client';

import { useState, useEffect, useRef } from 'react';
import type { Group, StatLeader } from '@/server/data/types';
import type { QualificationLabelKey, Zone } from '@/server/data/competitions';
import GroupTable from './GroupTable';
import LeaderTable from './LeaderTable';
import ThirdPlaceTable from './ThirdPlaceTable';
import LeagueLadder from './LeagueLadder';
import LeagueZoneTable from './LeagueZoneTable';
import { trackFeedFailure, trackFeedRecovery } from '@/lib/telemetry/client';
import { useTranslations } from '@/i18n/I18nProvider';
import { translatedGroupName } from './translatedGroupName';

interface Props {
  initialGroups: Group[];
  initialScorers: StatLeader[];
  initialAssists: StatLeader[];
  apiBase: string;
  /**
   * Competition-scoped prefix for team pages
   * (`/c/liga-mx/2026-apertura/team`). Optional: without it every crest
   * renders exactly as before, unlinked.
   */
  teamBase?: string;
  playerBase?: string;
  teamStyle?: 'flag' | 'crest';
  // Group-stage tournaments race for best third place; leagues don't.
  showThirdPlace?: boolean;
  // League qualification cut (e.g. Liga MX top 8 → Liguilla). When set, the
  // standings render as the split dial+tier ladder instead of a plain table.
  qualification?: { cut: number; labelKey: QualificationLabelKey };
  // Multi-outcome table (European leagues: UCL / UEL / UECL / relegation).
  // Takes precedence over `qualification`, which models a single cut.
  zones?: Zone[];
}

const REFRESH_MS = 30_000;

export default function StandingsLive({ initialGroups, initialScorers, initialAssists, apiBase, teamBase, playerBase, teamStyle = 'flag', showThirdPlace = true, qualification, zones }: Props) {
  const t = useTranslations();
  const [groups, setGroups] = useState<Group[]>(initialGroups);
  const [scorers, setScorers] = useState<StatLeader[]>(initialScorers);
  const [assists, setAssists] = useState<StatLeader[]>(initialAssists);
  const feedFailures = useRef<Record<string, boolean>>({
    standings: false,
    'top-scorers': false,
    'top-assists': false,
  });

  // Keep standings and both leaderboards fresh (groups shift during the group
  // stage; the boards change as goals go in). Three calls to our own API, but
  // the two leaderboards read one cached upstream /statistics fetch between
  // them.
  useEffect(() => {
    let mounted = true;
    // One descriptor per feed, so a third board costs a line rather than
    // another copy of the fetch → track → parse → track sequence.
    const feeds: { name: string; apply: (rows: unknown[]) => void }[] = [
      // Empty groups mean the feed is momentarily blank, not that the table
      // emptied — keep what we already show.
      { name: 'standings', apply: (rows) => { if (rows.length) setGroups(rows as Group[]); } },
      { name: 'top-scorers', apply: (rows) => setScorers(rows as StatLeader[]) },
      { name: 'top-assists', apply: (rows) => setAssists(rows as StatLeader[]) },
    ];

    async function poll() {
      const responses = await Promise.allSettled(
        feeds.map((f) => fetch(`${apiBase}/${f.name}`, { cache: 'no-store' })),
      );
      if (!mounted) return;
      responses.forEach((result, i) => {
        const feed = feeds[i].name;
        if (result.status === 'rejected') {
          if (!feedFailures.current[feed]) {
            trackFeedFailure(feed);
            feedFailures.current[feed] = true;
          }
          return;
        }
        if (!result.value.ok && !feedFailures.current[feed]) {
          trackFeedFailure(feed, result.value.status);
          feedFailures.current[feed] = true;
        }
      });

      const parsed = await Promise.allSettled(
        responses.map((r) => (r.status === 'fulfilled' && r.value.ok ? r.value.json() : null)),
      );
      if (!mounted) return;
      parsed.forEach((result, i) => {
        const feed = feeds[i].name;
        const value = result.status === 'fulfilled' ? result.value : null;
        if (Array.isArray(value)) {
          if (feedFailures.current[feed]) {
            trackFeedRecovery(feed);
            feedFailures.current[feed] = false;
          }
          feeds[i].apply(value);
        } else if (!feedFailures.current[feed]) {
          trackFeedFailure(feed);
          feedFailures.current[feed] = true;
        }
      });
    }
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const topScorersBlock = (
    <div className="std-block">
      <h2 className="std-block-title">{t('standings.goldenBoot')}</h2>
      <LeaderTable leaders={scorers} metric="goals" teamStyle={teamStyle} teamBase={teamBase} playerBase={playerBase} />
    </div>
  );

  const topAssistsBlock = (
    <div className="std-block">
      <h2 className="std-block-title">{t('standings.playmakers')}</h2>
      <LeaderTable leaders={assists} metric="assists" teamStyle={teamStyle} teamBase={teamBase} playerBase={playerBase} />
    </div>
  );

  const standingsBlock = (
    <div className="std-block">
      <h2 className="std-block-title">{t(showThirdPlace ? 'standings.groupStageResults' : 'standings.title')}</h2>
      {zones && zones.length > 0 && !showThirdPlace ? (
        groups.map((group) => (
          <div key={group.id} className="std-ladder" data-group={group.id}>
            {groups.length > 1 ? <h3 className="std-ladder-title">{translatedGroupName(group, t)}</h3> : null}
            {/* A table may carry its own zones. Almost none do — one league, one
                set of outcomes — but MLS's Supporters' Shield table is ranked
                across both conferences, so the conference playoff cut means
                nothing in it. */}
            <LeagueZoneTable standings={group.standings} zones={group.zones ?? zones} teamStyle={teamStyle} teamBase={teamBase} />
          </div>
        ))
      ) : qualification && !showThirdPlace ? (
        // One ladder per table. A league has exactly one; a cross-league cup
        // has two parallel tables racing for the same knockout, and rendering
        // only the first would silently drop half the competition.
        groups.map((group) => (
          <div key={group.id} className="std-ladder" data-group={group.id}>
            {groups.length > 1 ? <h3 className="std-ladder-title">{translatedGroupName(group, t)}</h3> : null}
            <LeagueLadder
              standings={group.standings}
              qualification={qualification}
              teamStyle={teamStyle}
              teamBase={teamBase}
            />
          </div>
        ))
      ) : groups.length > 0 ? (
        <div className="groups-grid">
          {groups.map((group) => (
            <GroupTable key={group.id} group={group} teamStyle={teamStyle} teamBase={teamBase} />
          ))}
        </div>
      ) : (
        <div className="empty-section">
          <p className="empty-text">{t('standings.groupsUnavailable')}</p>
        </div>
      )}
    </div>
  );

  // Group-stage tournaments (World Cup) lead with the scorers + best-third
  // columns, then the group results below. Leagues lead with the standings —
  // the headline table — and put the Golden Boot beneath it.
  if (showThirdPlace) {
    return (
      <>
        <div className="std-columns">
          {topScorersBlock}
          <div className="std-block">
            <h2 className="std-block-title">{t('standings.bestThirdPlaced')}</h2>
            {groups.length > 0 ? (
              <ThirdPlaceTable groups={groups} teamStyle={teamStyle} teamBase={teamBase} />
            ) : (
              <p className="empty-text">{t('standings.groupsUnavailable')}</p>
            )}
          </div>
        </div>
        {standingsBlock}
        {assists.length > 0 ? topAssistsBlock : null}
      </>
    );
  }

  return (
    <>
      {standingsBlock}
      {/* No scorers is a real state for competitions the provider gives no
          statistics for — render nothing rather than an empty table. */}
      {scorers.length > 0 ? topScorersBlock : null}
      {assists.length > 0 ? topAssistsBlock : null}
    </>
  );
}
