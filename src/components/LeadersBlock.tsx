'use client';

import { useState } from 'react';
import type { StatLeader } from '@/server/data/types';
import LeaderTable from './LeaderTable';
import TrackedLink from './TrackedLink';
import { useTranslations } from '@/i18n/I18nProvider';

const TOP = 5;

// Scorers and assists share one compact block: a switch, the top five, and a
// way out to the full Players directory. Competitions with no assists feed
// (or no scorers) show only the metric they have.
export default function LeadersBlock({
  scorers, assists, teamStyle, teamBase, playerBase, playersHref,
}: {
  scorers: StatLeader[];
  assists: StatLeader[];
  teamStyle?: 'flag' | 'crest';
  teamBase?: string;
  playerBase?: string;
  playersHref?: string;
}) {
  const t = useTranslations();
  const [metric, setMetric] = useState<'goals' | 'assists'>('goals');
  const options = ([
    { metric: 'goals', label: t('standings.scorers'), rows: scorers },
    { metric: 'assists', label: t('standings.assists'), rows: assists },
  ] as const).filter((o) => o.rows.length > 0);
  if (options.length === 0) return null;
  const active = options.find((o) => o.metric === metric) ?? options[0];

  return (
    <section className="std-block ldb">
      <h2 className="sr-only">{t('standings.leaders')}</h2>
      <div className="ldb-bar">
        <div className="ldb-switch" role="group" aria-label={t('standings.leaders')}>
          {options.map((o) => (
            <button
              key={o.metric}
              type="button"
              className="ldb-opt"
              aria-pressed={o.metric === active.metric}
              onClick={() => setMetric(o.metric)}
            >
              {o.label}
            </button>
          ))}
        </div>
        {playersHref ? (
          <TrackedLink href={playersHref} className="ldb-all" event="standings_leaders_players" properties={{ metric: active.metric }}>
            {t('standings.allPlayers')}
          </TrackedLink>
        ) : null}
      </div>
      <LeaderTable leaders={active.rows} metric={active.metric} limit={TOP} teamStyle={teamStyle} teamBase={teamBase} playerBase={playerBase} />
    </section>
  );
}
