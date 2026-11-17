'use client';

import { useTranslations } from '@/i18n/I18nProvider';
import { followTeam, unfollowTeam, useTeamFollows, type TeamFollow } from '@/lib/teamFollows';

export function TeamFollowsNotice({ notice }: { notice: ReturnType<typeof useTeamFollows>['notice'] }) {
  const t = useTranslations();
  return notice ? <p className="team-follows-notice" role="status">{t(`follows.${notice}`)}</p> : null;
}

export function FollowTeamToggle({ team, label = team.name, following }: { team: TeamFollow; label?: string; following: boolean }) {
  const t = useTranslations();
  return (
    <button
      className="follow-team-button"
      type="button"
      aria-pressed={following}
      aria-label={following ? `${t('follows.following')} ${label}. ${t('follows.unfollowTeam', label)}` : t('follows.followTeam', label)}
      onClick={() => following ? unfollowTeam(team.teamId) : followTeam(team)}
    >
      {following ? t('follows.following') : t('follows.follow')}
    </button>
  );
}

export default function FollowTeamButton(team: TeamFollow) {
  const { teams, notice } = useTeamFollows();
  return (
    <div className="follow-team">
      <FollowTeamToggle team={team} following={teams.some(entry => entry.teamId === team.teamId)} />
      <TeamFollowsNotice notice={notice} />
    </div>
  );
}
