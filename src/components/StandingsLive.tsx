'use client';

import { useState, useEffect } from 'react';
import type { Group, TopScorer } from '@/server/data/types';
import type { Zone } from '@/server/data/competitions';
import GroupTable from './GroupTable';
import TopScorersTable from './TopScorersTable';
import ThirdPlaceTable from './ThirdPlaceTable';
import LeagueLadder from './LeagueLadder';
import LeagueZoneTable from './LeagueZoneTable';

interface Props {
  initialGroups: Group[];
  initialScorers: TopScorer[];
  apiBase: string;
  teamStyle?: 'flag' | 'crest';
  // Group-stage tournaments race for best third place; leagues don't.
  showThirdPlace?: boolean;
  // League qualification cut (e.g. Liga MX top 8 → Liguilla). When set, the
  // standings render as the split dial+tier ladder instead of a plain table.
  qualification?: { cut: number; label: string };
  // Multi-outcome table (European leagues: UCL / UEL / UECL / relegation).
  // Takes precedence over `qualification`, which models a single cut.
  zones?: Zone[];
}

const REFRESH_MS = 30_000;

export default function StandingsLive({ initialGroups, initialScorers, apiBase, teamStyle = 'flag', showThirdPlace = true, qualification, zones }: Props) {
  const [groups, setGroups] = useState<Group[]>(initialGroups);
  const [scorers, setScorers] = useState<TopScorer[]>(initialScorers);

  // Keep standings + Golden Boot fresh (groups shift during the group stage;
  // top scorers change as knockout goals go in).
  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const [g, s] = await Promise.all([
          fetch(`${apiBase}/standings`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
          fetch(`${apiBase}/top-scorers`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (!mounted) return;
        if (Array.isArray(g) && g.length) setGroups(g);
        if (Array.isArray(s)) setScorers(s);
      } catch {
        // ignore — next tick retries
      }
    }
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const topScorersBlock = (
    <div className="std-block">
      <h2 className="std-block-title">Golden Boot · Top Scorers</h2>
      <TopScorersTable scorers={scorers} teamStyle={teamStyle} />
    </div>
  );

  const standingsBlock = (
    <div className="std-block">
      <h2 className="std-block-title">{showThirdPlace ? 'Group Stage Results' : 'Standings'}</h2>
      {zones && zones.length > 0 && !showThirdPlace ? (
        groups.map((group) => (
          <div key={group.id} className="std-ladder">
            {groups.length > 1 ? <h3 className="std-ladder-title">{group.name}</h3> : null}
            {/* A table may carry its own zones. Almost none do — one league, one
                set of outcomes — but MLS's Supporters' Shield table is ranked
                across both conferences, so the conference playoff cut means
                nothing in it. */}
            <LeagueZoneTable standings={group.standings} zones={group.zones ?? zones} teamStyle={teamStyle} />
          </div>
        ))
      ) : qualification && !showThirdPlace ? (
        // One ladder per table. A league has exactly one; a cross-league cup
        // has two parallel tables racing for the same knockout, and rendering
        // only the first would silently drop half the competition.
        groups.map((group) => (
          <div key={group.id} className="std-ladder">
            {groups.length > 1 ? <h3 className="std-ladder-title">{group.name}</h3> : null}
            <LeagueLadder
              standings={group.standings}
              qualification={qualification}
              teamStyle={teamStyle}
            />
          </div>
        ))
      ) : groups.length > 0 ? (
        <div className="groups-grid">
          {groups.map((group) => (
            <GroupTable key={group.id} group={group} teamStyle={teamStyle} />
          ))}
        </div>
      ) : (
        <div className="empty-section">
          <p className="empty-text">Group data is unavailable right now.</p>
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
            <h2 className="std-block-title">Best Third-Placed Teams</h2>
            {groups.length > 0 ? (
              <ThirdPlaceTable groups={groups} teamStyle={teamStyle} />
            ) : (
              <p className="empty-text">Group data is unavailable right now.</p>
            )}
          </div>
        </div>
        {standingsBlock}
      </>
    );
  }

  return (
    <>
      {standingsBlock}
      {/* No scorers is a real state for competitions the provider gives no
          statistics for — render nothing rather than an empty table. */}
      {scorers.length > 0 ? topScorersBlock : null}
    </>
  );
}
