'use client';

import { useState, useEffect } from 'react';
import type { Group, TopScorer } from '@/server/data/types';
import GroupTable from './GroupTable';
import TopScorersTable from './TopScorersTable';
import ThirdPlaceTable from './ThirdPlaceTable';

interface Props {
  initialGroups: Group[];
  initialScorers: TopScorer[];
}

const REFRESH_MS = 30_000;

export default function StandingsLive({ initialGroups, initialScorers }: Props) {
  const [groups, setGroups] = useState<Group[]>(initialGroups);
  const [scorers, setScorers] = useState<TopScorer[]>(initialScorers);

  // Keep standings + Golden Boot fresh (groups shift during the group stage;
  // top scorers change as knockout goals go in).
  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const [g, s] = await Promise.all([
          fetch('/api/groups', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
          fetch('/api/top-scorers', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
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
      <div className="std-columns">
        <div className="std-block">
          <h2 className="std-block-title">Golden Boot · Top Scorers</h2>
          <TopScorersTable scorers={scorers} />
        </div>

        <div className="std-block">
          <h2 className="std-block-title">Best Third-Placed Teams</h2>
          {groups.length > 0 ? (
            <ThirdPlaceTable groups={groups} />
          ) : (
            <p className="empty-text">Group data is unavailable right now.</p>
          )}
        </div>
      </div>

      <div className="std-block">
        <h2 className="std-block-title">Group Stage Results</h2>
        {groups.length > 0 ? (
          <div className="groups-grid">
            {groups.map((group) => (
              <GroupTable key={group.id} group={group} />
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
