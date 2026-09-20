'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { teamFollowHref, unfollowTeam, useTeamFollows } from '@/lib/teamFollows';
import { TeamFollowsNotice } from './FollowTeamButton';

export default function YourTeams() {
  const locale = useLocale();
  const t = useTranslations();
  const { teams, notice } = useTeamFollows();
  return (
    <section className="your-teams" aria-labelledby="your-teams-title">
      <h2 id="your-teams-title">{t('follows.title')}</h2>
      {teams.length > 0 && (notice === null || notice === 'limit') && <p>{t('follows.local')}</p>}
      {teams.length === 0 ? <p>{t('follows.empty')}</p> : (
        <ul className="your-teams-list">
          {teams.map((team) => (
            <li className="your-teams-item" key={team.teamId}>
              <Link href={teamFollowHref(team, locale)} prefetch={false}>{team.name}</Link>
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
      )}
      <TeamFollowsNotice notice={notice} />
    </section>
  );
}
