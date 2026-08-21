'use client';

import type { Group } from '@/server/data/types';
import { computeQuarterfinals } from '@/server/data/leaguesCupTables';
import TeamBadge from './TeamBadge';
import type { ConfiguredRound, ISODate } from '@/server/data/competitions';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatDateRange } from '@/i18n/format';

interface Props {
  groups: Group[];
  cut: number;
  teamStyle?: 'flag' | 'crest';
  // Semantic round and ISO window. Shown when
  // this renders as the page's top banner, standing in for the fixtures the
  // provider has not published.
  round?: { round: ConfiguredRound; startDate: ISODate; endDate: ISODate };
}

// The knockout ties for a cross-league cup, derived rather than fetched.
//
// The bracket is fixed and pre-seeded — MLS 1 v LMX 4, MLS 2 v LMX 3, and so
// on — so once both tables are final the pairings follow from results alone.
// That is why this renders while the provider still has no knockout fixture
// published: there is nothing left to find out.
export default function PhaseQualifiers({ groups, cut, teamStyle = 'crest', round }: Props) {
  const locale = useLocale();
  const t = useTranslations();
  const ties = computeQuarterfinals(groups, cut);
  if (ties.length === 0) return null;
  const roundTitle = round?.round === 'quarterfinals'
    ? t('round.quarterfinals')
    : null;
  const roundDateRange = round
    ? formatDateRange(round.startDate, round.endDate, locale)
    : null;

  return (
    <div className="lcq">
      {round ? (
        <p className="lcq-when">
          <span className="lcq-round">{roundTitle ?? t('common.unavailable')}</span>
          <span className="lcq-dot" aria-hidden="true">·</span>
          <span>{roundDateRange ?? t('common.unavailable')}</span>
        </p>
      ) : null}
      <p className="lcq-note">
        {t('standings.seededPairingExplanation')}
      </p>
      <ol className="lcq-list">
        {ties.map((tie) => (
          <li key={`${tie.home.team.id}-${tie.away.team.id}`} className="lcq-tie">
            <span className="lcq-side lcq-side-home">
              <span className="lcq-seed">{tie.homeSeed}</span>
              <TeamBadge team={tie.home.team} style={teamStyle} size={28} />
              <span className="lcq-name">{tie.home.team.name}</span>
            </span>
            <span className="lcq-v">{t('match.versusShort')}</span>
            <span className="lcq-side lcq-side-away">
              <span className="lcq-name">{tie.away.team.name}</span>
              <TeamBadge team={tie.away.team} style={teamStyle} size={28} />
              <span className="lcq-seed">{tie.awaySeed}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
