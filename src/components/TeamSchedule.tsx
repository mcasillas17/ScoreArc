'use client';

import type { Match } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { useLocale } from '@/i18n/I18nProvider';
import MatchRow from './MatchRow';
import MatchDetailPopup from './MatchDetailPopup';
import { useMatchDetails } from './useMatchDetails';
import { toMatchDetailInput } from './upcomingWindow';

export default function TeamSchedule({ matches, competitionId, seasonId, teamStyle }: {
  matches: Match[]; competitionId: string; seasonId: string; teamStyle: TeamStyle;
}) {
  const locale = useLocale();
  const details = useMatchDetails(`/api/${competitionId}/${seasonId}`, 'team-page');
  const base = `/${locale}/c/${competitionId}/${seasonId}`;
  return <>
    <ul className="tm-matchlist">{matches.map((match) => <li key={match.id}>
      <MatchRow match={match} teamStyle={teamStyle} showDate onOpen={() => void details.openDetails(match)} />
    </li>)}</ul>
    {details.detail && <MatchDetailPopup match={toMatchDetailInput(details.detail)} summary={details.summary}
      loading={details.loadingDetail} onClose={details.closeDetails} teamBase={`${base}/team`} playerBase={`${base}/player`} />}
  </>;
}
