'use client';

import type { Match, TeamProfile } from '@/server/data/types';
import type { TeamStyle } from '@/server/data/competitions';
import { teamPerformance, type MatchScope, type PerformancePeriod, type TeamResult } from '@/server/data/teamPerformance';
import { useLocale, useTranslations } from '@/i18n/I18nProvider';
import { formatDate } from '@/i18n/format';
import { intlLocale } from '@/i18n/config';
import { useMatchDetails } from './useMatchDetails';
import MatchDetailPopup from './MatchDetailPopup';
import MatchRow from './MatchRow';
import { toMatchDetailInput } from './upcomingWindow';

interface Props {
  matches: Match[];
  teamId: string;
  scope: MatchScope;
  competitionName: string;
  seasonLabel: string;
  teamStyle: TeamStyle;
  availability: TeamProfile['scheduleAvailability'];
}

export default function TeamPerformance({ matches, teamId, scope, competitionName, seasonLabel, teamStyle, availability }: Props) {
  const t = useTranslations();
  const locale = useLocale();
  const { recent, previous, eligibleCount, change } = teamPerformance(matches, teamId, scope);
  const base = `/${locale}/c/${scope.competitionId}/${scope.seasonId}`;
  const details = useMatchDetails(`/api/${scope.competitionId}/${scope.seasonId}`, 'team-page');
  const available = availability?.results === 'available';
  const resultLabel = (r: TeamResult) => t(r === 'W' ? 'performance.win' : r === 'D' ? 'performance.draw' : 'performance.loss');
  const abbreviation = (r: TeamResult) => t(r === 'W' ? 'team.formWinAbbreviation' : r === 'D' ? 'team.formDrawAbbreviation' : 'team.formLossAbbreviation');
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
        <span className={`tm-chip tm-chip--${result}`} title={resultLabel(result)}>{abbreviation(result)}</span>
        <MatchRow match={match} teamStyle={teamStyle} showDate onOpen={() => void details.openDetails(match)} />
      </li>)}
    </ul>;
  }

  return <section className="tm-section tp" id="performance" aria-labelledby="performance-title">
    <h2 className="section-label" id="performance-title">{t('performance.title')}</h2>
    <p className="tp-scope">{t('performance.scope', competitionName, seasonLabel)}</p>
    {!available ? <p className="tp-notice" role="status">{t('performance.unavailable')}</p>
      : recent.sample === 0 ? <p className="tp-notice">{t('performance.noEligible')}</p>
      : <>
        <div className="tp-period-head">
          <div><h3>{t('performance.recent', recent.sample)}</h3><p>{periodLabel(recent)}</p></div>
          <ol className="tm-form" aria-label={t('performance.form', recent.wins, recent.draws, recent.losses)}>
            {recent.matches.map(({ match, result }) => <li key={match.id}>
              <button type="button" className={`tm-chip tp-form-button tm-chip--${result}`}
                aria-label={t('performance.openMatch', resultLabel(result), match.home.name, match.away.name, `${match.homeScore}–${match.awayScore}`)}
                onClick={() => void details.openDetails(match)}>{abbreviation(result)}</button>
            </li>)}
          </ol>
        </div>
        <p className="tp-record">{t('performance.form', recent.wins, recent.draws, recent.losses)}</p>
        <dl className="tp-metrics">
          <div><dt>{t('performance.goalsFor')}</dt><dd>{recent.goalsFor}<small>{t('performance.rate', number(recent.goalsForPerMatch!))}</small></dd></div>
          <div><dt>{t('performance.goalsAgainst')}</dt><dd>{recent.goalsAgainst}<small>{t('performance.rate', number(recent.goalsAgainstPerMatch!))}</small></dd></div>
          <div><dt>{t('performance.cleanSheets')}</dt><dd>{recent.cleanSheets}</dd></div>
        </dl>
        {previous && change ? <div className="tp-comparison">
          <h3>{t('performance.comparison')}</h3>
          <p className="tp-period-caption">{t('performance.previous')}: {periodLabel(previous)}</p>
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
        </div> : <p className="tp-notice">{t('performance.insufficient', eligibleCount)}</p>}
        <h3 className="tp-evidence-title">{t('performance.evidence')}</h3>
        {evidence(recent)}
        {previous && <details className="tp-previous"><summary>{t('performance.previousEvidence')}</summary>
          <p className="tp-period-caption">{periodLabel(previous)}</p>{evidence(previous)}</details>}
      </>}
    <p className="tp-definitions">{t('performance.definitions')}</p>
    {details.detail && <MatchDetailPopup match={toMatchDetailInput(details.detail)} summary={details.summary}
      loading={details.loadingDetail} onClose={details.closeDetails} teamBase={`${base}/team`} playerBase={`${base}/player`} />}
  </section>;
}
