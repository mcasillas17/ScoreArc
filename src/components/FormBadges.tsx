'use client';

import { createContext, useContext } from 'react';
import type { Match, Team } from '@/server/data/types';
import type { TeamResult } from '@/server/data/teamPerformance';
import type { StandingsForm } from '@/server/data/standingsForm';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatDate } from '@/i18n/format';
import type { Translator } from '@/i18n/translate';

export const resultLabel = (t: Translator, r: TeamResult) =>
  t(r === 'W' ? 'performance.win' : r === 'D' ? 'performance.draw' : 'performance.loss');
export const resultAbbreviation = (t: Translator, r: TeamResult) =>
  t(r === 'W' ? 'team.formWinAbbreviation' : r === 'D' ? 'team.formDrawAbbreviation' : 'team.formLossAbbreviation');

export const StandingsFormContext = createContext<{ form: StandingsForm; onOpen: (match: Match) => void } | null>(null);

/** The result chips of a form row: each is a button opening its match. */
export function FormChips({ items, label, className, buttonClassName, onOpen }: {
  items: { match: Match; result: TeamResult; label: string }[];
  label: string;
  className?: string;
  buttonClassName: string;
  onOpen: (match: Match) => void;
}) {
  const t = useTranslations();
  return <ol className={`tm-form${className ? ` ${className}` : ''}`} aria-label={label}>
    {items.map(({ match, result, label: itemLabel }) => <li key={match.id}>
      <button type="button" className={`tm-chip ${buttonClassName} tm-chip--${result}`} aria-label={itemLabel}
        onClick={() => onOpen(match)}>{resultAbbreviation(t, result)}</button>
    </li>)}
  </ol>;
}

/** A team's recent results, newest first, each opening its match. Renders
 *  nothing outside a form-loaded standings page or for a team yet to play. */
export default function FormBadges({ teamId, teamName }: { teamId: string; teamName: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const context = useContext(StandingsFormContext);
  const entry = context?.form.teams[teamId];
  if (!context || !entry) return null;
  if (entry.status === 'unavailable') {
    return <span className="sf-gap" role="img" aria-label={t('standings.formTeamUnavailable', teamName)}>{t('standings.formGap')}</span>;
  }
  const items = entry.results.map(({ matchId, result }) => {
    // isStandingsForm guarantees every result's match is present.
    const match = context.form.matches.find((m) => m.id === matchId)!;
    const home = match.home.id === teamId;
    return { match, result, label: t('standings.formBadge', resultLabel(t, result), (home ? match.away : match.home).name,
      `${home ? match.homeScore : match.awayScore}–${home ? match.awayScore : match.homeScore}`,
      formatDate(match.kickoff, locale, { year: 'numeric', month: 'short', day: 'numeric' })!) };
  });
  return <FormChips className="sf-form" buttonClassName="sf-badge" label={t('standings.formTeam', teamName, items.length)}
    onOpen={context.onOpen} items={items} />;
}

/** A ladder row's name cell: name and badges share a line while they fit. */
export function LadderTeamName({ team }: { team: Team }) {
  return <div className="sf-team">
    <span className="ll-name">{team.name}</span>
    <FormBadges teamId={team.id} teamName={team.name} />
  </div>;
}
