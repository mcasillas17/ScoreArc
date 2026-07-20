'use client';

import { useState, useEffect } from 'react';
import type { Group, TopScorer } from '@/server/data/types';
import GroupTable from './GroupTable';
import TopScorersTable from './TopScorersTable';
import ThirdPlaceTable from './ThirdPlaceTable';
import LeagueLadder from './LeagueLadder';

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
}

const REFRESH_MS = 30_000;

export default function StandingsLive({ initialGroups, initialScorers, apiBase, teamStyle = 'flag', showThirdPlace = true, qualification }: Props) {
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

  return (
    <>
      {showThirdPlace ? (
        <div className="std-columns">
          <div className="std-block">
            <h2 className="std-block-title">Golden Boot · Top Scorers</h2>
            <TopScorersTable scorers={scorers} teamStyle={teamStyle} />
          </div>

          <div className="std-block">
            <h2 className="std-block-title">Best Third-Placed Teams</h2>
            {groups.length > 0 ? (
              <ThirdPlaceTable groups={groups} teamStyle={teamStyle} />
            ) : (
              <p className="empty-text">Group data is unavailable right now.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="std-block">
          <h2 className="std-block-title">Golden Boot · Top Scorers</h2>
          <TopScorersTable scorers={scorers} teamStyle={teamStyle} />
        </div>
      )}

      <div className="std-block">
        <h2 className="std-block-title">{showThirdPlace ? 'Group Stage Results' : 'Standings'}</h2>
        {qualification && !showThirdPlace ? (
          <LeagueLadder
            standings={groups[0]?.standings ?? []}
            qualification={qualification}
            teamStyle={teamStyle}
          />
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
    </>
  );
}
