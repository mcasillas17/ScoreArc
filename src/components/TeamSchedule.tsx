'use client';

import type { Match } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import MatchRow from './MatchRow';
import MatchDetailPopup from './MatchDetailPopup';
import { useMatchDetails } from './useMatchDetails';
import { toMatchDetailInput } from './upcomingWindow';

export default function TeamSchedule({ matches, competitionId, seasonId, teamStyle, nextId }: {
  nextId?: string; matches: Match[]; competitionId: string; seasonId: string; teamStyle: TeamStyle;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const details = useMatchDetails(`/api/${competitionId}/${seasonId}`, 'team-page');
  const base = `/${locale}/c/${competitionId}/${seasonId}`;
  // What is coming first, soonest on top; then results, newest on top. In
  // kickoff order the next match sat below a whole season of results.
  const played = (m: Match) => m.state === 'finished';
  const ordered = [...matches.filter((m) => !played(m)), ...matches.filter(played).reverse()];
  return <>
    <ul className="tm-matchlist">{ordered.map((match) => <li key={match.id} className={match.id === nextId ? 'tm-is-next' : undefined}>
      {match.id === nextId && <span className="tm-next-mark">{t('team.next')}</span>}
      <MatchRow match={match} teamStyle={teamStyle} showDate onOpen={() => void details.openDetails(match)} />
    </li>)}</ul>
    {details.detail && <MatchDetailPopup match={toMatchDetailInput(details.detail)} summary={details.summary}
      loading={details.loadingDetail} onClose={details.closeDetails} teamStyle={teamStyle} teamBase={`${base}/team`} playerBase={`${base}/player`} />}
  </>;
}
