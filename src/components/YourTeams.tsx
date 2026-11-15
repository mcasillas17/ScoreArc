'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { teamFollowHref, unfollowTeam, useTeamFollows } from '@/lib/teamFollows';
import { TeamFollowsNotice } from './FollowTeamButton';
import { getCompetition, inView, type View } from '@/server/data/competitions';

export default function YourTeams({ view = 'all' }: { view?: View }) {
  const locale = useLocale();
  const t = useTranslations();
  const { teams: followed, notice } = useTeamFollows();
  // The view changes what is shown, never what is followed: All brings the
  // rest back.
  const teams = followed.filter((team) => {
    const competition = getCompetition(team.competitionId);
    return !competition || inView(competition, view);
  });
  // Following no one is one quiet line, not a heading over a prompt.
  if (teams.length === 0) {
    return (
      <div className="your-teams your-teams--empty">
        <p>{t('follows.empty')}</p>
        <TeamFollowsNotice notice={notice} />
      </div>
    );
  }
  return (
    <section className="your-teams" aria-labelledby="your-teams-title">
      <h2 id="your-teams-title">{t('follows.title')}</h2>
      {(notice === null || notice === 'limit') && <p>{t('follows.local')}</p>}
      <ul className="your-teams-list">
        {teams.map((team) => (
          <li className="your-teams-item" key={team.teamId}>
            <Link href={teamFollowHref(team, locale)} prefetch={false}>
              {team.name}
              {/* Following both Américas: say which is which. */}
              {teams.some((other) => other.name === team.name && other.teamId !== team.teamId)
                && ` · ${getCompetition(team.competitionId)?.shortName ?? ''}`}
            </Link>
            <button
              className="your-teams-remove"
              type="button"
              aria-label={t('follows.removeTeam', team.name)}
              onClick={() => unfollowTeam(team.teamId)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        ))}
      </ul>
      <TeamFollowsNotice notice={notice} />
    </section>
  );
}
