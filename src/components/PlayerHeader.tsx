/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import type { PlayerProfile } from '@/server/data/types';
import type { Translator } from '@/i18n/translate';
import { teamHref } from './teamHref';
import TeamBadge from './TeamBadge';

/**
 * Identity block for a player page. Server-rendered.
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
    </header>
  );
}
