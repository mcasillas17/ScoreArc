'use client';

import type { Match, TeamProfile } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { teamPerformance, type MatchScope, type PerformancePeriod } from '@/server/data/teamPerformance';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatDate } from '@/i18n/format';
import { intlLocale } from '@/i18n/config';
import { useMatchDetails } from './useMatchDetails';
import MatchDetailPopup from './MatchDetailPopup';
import MatchRow from './MatchRow';
import LocalTime from './LocalTime';
import { toMatchDetailInput } from './upcomingWindow';
import { FormChips, resultAbbreviation, resultLabel } from './FormBadges';

interface Props {
  matches: Match[];
  teamId: string;
  scope: MatchScope;
  next: Match | null;
  teamStyle: TeamStyle;
  availability: TeamProfile['scheduleAvailability'];
}

export default function TeamPerformance({ matches, teamId, scope, next, teamStyle, availability }: Props) {
  const t = useTranslations();
  const locale = useLocale();
  const { recent, previous, eligibleCount, change } = teamPerformance(matches, teamId, scope);
  const base = `/${locale}/c/${scope.competitionId}/${scope.seasonId}`;
  const details = useMatchDetails(`/api/${scope.competitionId}/${scope.seasonId}`, 'team-page');
  const available = availability?.results === 'available';
  const number = (n: number, signed = false, fractionDigits = 1) => new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: fractionDigits, minimumFractionDigits: fractionDigits, signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(n);
  const counts = [
    ['wins', t('standings.winsTooltip')], ['draws', t('standings.drawsTooltip')], ['losses', t('standings.lossesTooltip')],
    ['goalsFor', t('performance.goalsFor')], ['goalsAgainst', t('performance.goalsAgainst')], ['cleanSheets', t('performance.cleanSheets')],
  ] as const;
  function periodLabel(period: PerformancePeriod) {
    const date = (iso: string) => formatDate(iso, locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })!;
    return t('performance.period', date(period.matches[period.sample - 1].match.kickoff), date(period.matches[0].match.kickoff), period.sample);
  }
  function evidence(period: PerformancePeriod) {
    return <ul className="tp-evidence">
      {period.matches.map(({ match, result }) => <li key={match.id}>
        <span className={`tm-chip tm-chip--${result}`} title={resultLabel(t, result)}>{resultAbbreviation(t, result)}</span>
        <MatchRow match={match} teamStyle={teamStyle} showDate onOpen={() => void details.openDetails(match)} />
      </li>)}
    </ul>;
  }

  const nextLabel = next && `${t('team.next')}: ${next.home.name} ${t('match.versus')} ${next.away.name}`;
  const opponent = next && (next.home.id === teamId ? next.away : next.home);

  return <section className="tm-section tp" id="performance" aria-labelledby="performance-title">
    <h2 className="section-label" id="performance-title">{t('team.formAndNextMatch')}</h2>
    {!available ? <p className="tp-notice" role="status">{t('performance.unavailable')}</p>
      : recent.sample === 0 ? <p className="tp-notice">{t('performance.noEligible')}</p>
      : <>
        <FormChips buttonClassName="tp-form-button" label={t('performance.form', recent.wins, recent.draws, recent.losses)}
          onOpen={(match) => void details.openDetails(match)}
          items={recent.matches.map(({ match, result }) => ({ match, result,
            label: t('performance.openMatch', resultLabel(t, result), match.home.name, match.away.name, `${match.homeScore}–${match.awayScore}`) }))}
          trailing={next && <button type="button" className="tm-chip tp-form-button tp-next-chip" aria-label={nextLabel!}
            onClick={() => void details.openDetails(next)}>{opponent!.abbr}</button>} />
        <p className="tp-figures">
          <span>{t('performance.goalsFor')} <strong>{recent.goalsFor}</strong></span>
          <span>{t('performance.goalsAgainst')} <strong>{recent.goalsAgainst}</strong></span>
          <span>{t('performance.cleanSheets')} <strong>{recent.cleanSheets}</strong></span>
        </p>
      </>}
    {/* Outside the form branch: a team with no results yet still has a next match. */}
    {next && <button type="button" className="tp-next" onClick={() => void details.openDetails(next)}>
      <span className="tp-next-label">{t('team.next')}</span>
      <span>{next.home.abbr} {t('match.versusShort')} {next.away.abbr}</span>
      <span className="tp-next-when"><LocalTime iso={next.kickoff} mode="dayTime" /></span>
    </button>}
    {available && recent.sample > 0 && <details className="tp-compare"><summary>{t('performance.compare')}</summary>
      {previous && change ? <>
        <p className="tp-period-caption">{t('performance.previous')}: {periodLabel(previous)}</p>
        <div className="tp-comparison">
          <table>
            <caption>{t('performance.change')}</caption>
            <thead><tr><th scope="col"><span className="sr-only">{t('performance.comparison')}</span></th>
              <th scope="col">{t('performance.previous')}</th><th scope="col">{t('performance.recent', 5)}</th></tr></thead>
            <tbody>
              {counts.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{previous[key]}</td>
                <td>{recent[key]} <span>({number(change[key], true, 0)})</span></td></tr>)}
              <tr><th scope="row">{t('performance.goalsForRate')}</th><td>{number(previous.goalsForPerMatch!)}</td><td>{number(recent.goalsForPerMatch!)} <span>({number(change.goalsForPerMatch, true)})</span></td></tr>
              <tr><th scope="row">{t('performance.goalsAgainstRate')}</th><td>{number(previous.goalsAgainstPerMatch!)}</td><td>{number(recent.goalsAgainstPerMatch!)} <span>({number(change.goalsAgainstPerMatch, true)})</span></td></tr>
            </tbody>
          </table>
        </div>
        {evidence(previous)}
      </> : <p className="tp-notice">{t('performance.insufficient', eligibleCount)}</p>}
      <p className="tp-definitions">{t('performance.definitions')}</p>
    </details>}
    {details.detail && <MatchDetailPopup match={toMatchDetailInput(details.detail)} summary={details.summary}
      loading={details.loadingDetail} onClose={details.closeDetails} teamStyle={teamStyle} teamBase={`${base}/team`} playerBase={`${base}/player`} />}
  </section>;
}
