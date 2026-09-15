'use client';

import { useTranslations } from '@/i18n/I18nProvider';
import { followTeam, unfollowTeam, useTeamFollows, type TeamFollow } from '@/lib/teamFollows';

export function TeamFollowsNotice({ notice }: { notice: ReturnType<typeof useTeamFollows>['notice'] }) {
  const t = useTranslations();
  return notice ? <p className="team-follows-notice" role="status">{t(`follows.${notice}`)}</p> : null;
}

export default function FollowTeamButton(team: TeamFollow) {
  const t = useTranslations();
  const { teams, notice } = useTeamFollows();
  const following = teams.some((entry) => entry.teamId === team.teamId);
  return (
    <div className="follow-team">
      <button
        className="follow-team-button"
        type="button"
        aria-pressed={following}
        aria-label={following ? `${t('follows.following')} ${team.name}. ${t('follows.unfollowTeam', team.name)}` : t('follows.followTeam', team.name)}
        onClick={() => following ? unfollowTeam(team.teamId) : followTeam(team)}
      >
        {following ? t('follows.following') : t('follows.follow')}
      </button>
      <TeamFollowsNotice notice={notice} />
    </div>
  );
}
