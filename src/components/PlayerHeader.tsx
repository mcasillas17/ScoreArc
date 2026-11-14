/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import type { PlayerProfile, PlayerSeasonTotal } from '@/server/data/types';
import type { Translator } from '@/i18n/translate';
import { teamHref } from './teamHref';
import TeamBadge from './TeamBadge';

const APPEARANCES = 'starts-subIns';

/**
 * Split the provider's totals into the figures, the one to lead with, and the
 * appearances ("3 (7)" = starts and substitute appearances) as numbers.
 * Goals lead when scored, then assists, else the first figure the provider
 * sends (a goalkeeper's clean sheets).
 */
export function splitTotals(totals: PlayerSeasonTotal[]) {
  const figures = totals.filter((total) => total.name !== APPEARANCES);
  const lead = figures.find((f) => f.name === 'totalGoals' && (f.value ?? 0) > 0)
    ?? figures.find((f) => f.name === 'goalAssists' && (f.value ?? 0) > 0)
    ?? figures[0];
  const raw = totals.find((total) => total.name === APPEARANCES)?.display ?? '';
  const m = /^(\d+)\s*\((\d+)\)$/.exec(raw.trim());
  return {
    lead,
    rest: figures.filter((f) => f !== lead),
    apps: m ? { starts: Number(m[1]), subs: Number(m[2]) } : null,
  };
}

/**
 * Identity and season totals for a player page, one band. Server-rendered.
 *
 * Headshots are frequently null on this provider (the recorded fixture player
 * has none), so the portrait slot is designed around absence: initials on the
 * club-colored disc, never a broken <img> or an empty grey frame.
 */
export default function PlayerHeader({
  player,
  teamBase,
  teamStyle,
  t,
}: {
  player: PlayerProfile;
  teamBase?: string;
  teamStyle?: 'crest' | 'flag';
  t: Translator;
}) {
  const { lead, rest, apps } = splitTotals(player.totals);
  const label = (f: PlayerSeasonTotal) =>
    f.name === 'totalGoals' ? t('squad.goals') : f.name === 'goalAssists' ? t('squad.assists') : f.label;
  const initials = player.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');

  const clubHref = player.team ? teamHref(teamBase, player.team) : undefined;

  return (
    <header className="ph">
      <div className="ph-portrait" aria-hidden={player.headshotUrl ? undefined : true}>
        {player.headshotUrl ? (
          <img className="ph-headshot" src={player.headshotUrl} alt={player.name} />
        ) : (
          <span className="ph-initials">{initials}</span>
        )}
      </div>

      <div className="ph-id">
        <h1 className="ph-name">
          {player.jersey && <span className="ph-jersey">#{player.jersey}</span>}
          {player.name}
        </h1>
        <p className="ph-meta">
          {player.position && <span>{player.position}</span>}
          {player.age !== null && <span>{t('player.yearsOld', player.age)}</span>}
          {player.nationality && (
            <span className="ph-nation">
              {player.flagUrl && <img className="ph-flag" src={player.flagUrl} alt="" />}
              {player.nationality}
            </span>
          )}
        </p>
        {player.team && (
          <p className="ph-club">
            <TeamBadge team={player.team} size={22} style={teamStyle ?? 'crest'} />
            {clubHref ? (
              <Link href={clubHref}>{player.team.name}</Link>
            ) : (
              <span>{player.team.name}</span>
            )}
          </p>
        )}
      </div>

      <div className="ph-stats">
        {!lead && !apps ? (
          <p className="pl-none">{t('player.noSeasonStats')}</p>
        ) : (
          <>
            <div className="ph-figs">
              {lead && (
                <p className="ph-fig ph-fig--lead">
                  <strong>{lead.display || '–'}</strong>
                  <span>{label(lead)}</span>
                </p>
              )}
              {rest.map((f) => (
                <p key={f.name} className="ph-fig">
                  <strong>{f.display || '–'}</strong>
                  <span>{label(f)}</span>
                </p>
              ))}
            </div>
            <p className="ph-apps">
              {apps ? t('player.startsSubs', apps.starts, apps.subs) : null}
              {apps && ' · '}
              {/* The provider labels the season itself ("2026-27 Liga MX Stats"). */}
              {player.seasonLabel || t('player.seasonStats')}
            </p>
          </>
        )}
      </div>
    </header>
  );
}
