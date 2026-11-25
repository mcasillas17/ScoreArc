import { useId } from 'react';
import { useTranslations } from '@/i18n/I18nProvider';
import type { Translator } from '@/i18n/translate';
import { MAX_LIGUILLA_SCORE, type LiguillaLeg, type LiguillaTie, type ScoreField } from '@/lib/liguilla';
import type { BracketTeam } from '@/server/data/types';
import { roundLabelKey } from './bracketShape';
import { matchStatusText, TeamMark } from './MatchRow';

interface Props {
  tie: LiguillaTie;
  mode: 'live' | 'predict';
  onScore: (field: ScoreField, teamId: string, score: number | null) => void;
  onClose: () => void;
}

function legVenue(tie: LiguillaTie, leg: LiguillaLeg, t: Translator) {
  if (leg.match && !leg.match.home.placeholder) return t('liguilla.at', leg.match.home.abbr);
  const other = tie.legs[leg.number === 1 ? 1 : 0].match;
  if (other && !other.away.placeholder) return t('liguilla.projectedVenue', other.away.abbr);

  const { home, away } = tie.match;
  if (!home.overallSeed || !away.overallSeed || home.overallSeed === away.overallSeed) {
    return t('liguilla.venuePending');
  }
  const higherSeedHosts = leg.number === 2;
  const host = (home.overallSeed < away.overallSeed) === higherSeedHosts ? home : away;
  return t('liguilla.projectedVenue', host.abbr);
}

function GoalsInput({ value, label, onChange }: {
  value: number | null;
  label: string;
  onChange: (score: number | null) => void;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={String(MAX_LIGUILLA_SCORE).length}
      placeholder="–"
      aria-label={label}
      value={value ?? ''}
      onChange={event => {
        const text = event.target.value;
        if (text === '') onChange(null);
        else if (/^\d+$/.test(text) && Number(text) <= MAX_LIGUILLA_SCORE) onChange(Number(text));
      }}
    />
  );
}

function Verdict({ tie, predict, canPickPenalties }: {
  tie: LiguillaTie;
  predict: boolean;
  canPickPenalties: boolean;
}) {
  const t = useTranslations();
  const outcome = predict ? tie.forecast : tie.official;
  const [a, b] = outcome.aggregate;
  const club = [tie.match.home, tie.match.away].find(team => team.id === (outcome.winnerId ?? outcome.leaderId));
  const final = tie.match.round === 'final';
  let title = t('liguilla.awaiting');
  let detail = predict && tie.legs.some(leg => !leg.locked) ? t('liguilla.enterScores') : '';
  if (club && a !== null && b !== null) {
    title = outcome.winnerId
      ? t(final ? 'liguilla.champion' : 'liguilla.advances', club.name)
      : t('liguilla.leader', club.name);
    if (outcome.reason === 'penalties') {
      detail = t('liguilla.penaltyVerdict');
    } else if (outcome.reason === 'seed') {
      detail = t(outcome.winnerId ? 'liguilla.seedVerdict' : 'liguilla.seedLead', a, b);
    } else {
      detail = t(outcome.reason === 'extra-time' ? 'liguilla.extraTimeVerdict' : 'liguilla.aggregateVerdict', Math.max(a, b), Math.min(a, b));
    }
  } else if (a !== null && a === b) {
    title = t('liguilla.level');
    detail = t(canPickPenalties ? 'liguilla.enterPenalties' : final ? 'liguilla.finalRule' : 'liguilla.seedNeeded');
  } else if (tie.legs.every(leg => leg.locked)) {
    detail = t('liguilla.pendingResult');
  }
  return (
    <div className="liguilla-verdict" aria-live="polite" aria-atomic="true">
      {club && <TeamMark team={club} style="crest" />}
      <div><strong>{title}</strong>{detail && <p>{detail}</p>}</div>
    </div>
  );
}

export default function LiguillaScorecard({ tie, mode, onScore, onClose }: Props) {
  const t = useTranslations();
  const titleId = useId();
  const predict = mode === 'predict';
  const teams = [tie.match.home, tie.match.away];
  const outcome = predict ? tie.forecast : tie.official;
  const final = tie.match.round === 'final';
  const vuelta = tie.legs[1];
  const [a, b] = outcome.aggregate;
  const canPickPenalties = final && predict && !vuelta.locked && a !== null && a === b
    && tie.legs.every(leg => leg.effective.every(score => score !== null));
  const hasPenalties = tie.penalties.some(score => score !== null);
  const hasSavedPenalties = vuelta.locked && tie.savedPenalties.some(score => score !== null);
  const savedPenaltiesOnly = hasSavedPenalties && !hasPenalties;
  const legName = (leg: LiguillaLeg) => t(leg.number === 1 ? 'liguilla.ida' : 'liguilla.vuelta');

  function scoreCell(leg: LiguillaLeg, team: BracketTeam, index: number) {
    if (predict && !leg.locked) {
      return <GoalsInput value={leg.saved[index]} label={t('liguilla.goals', team.name, legName(leg))}
        onChange={score => onScore(leg.number, team.id, score)} />;
    }
    const saved = leg.saved[index];
    return <>
      <span className="liguilla-score">{leg.actual[index] ?? '–'}</span>
      {leg.locked && saved !== null && <small>{t('liguilla.savedPick', saved)}</small>}
    </>;
  }

  return (
    <aside className="liguilla-card" id="liguilla-scorecard" tabIndex={-1} aria-labelledby={titleId}
      onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <p className="liguilla-round">{t(roundLabelKey(tie.match.round))}</p>
      <button type="button" className="liguilla-close" aria-label={t('liguilla.close')} onClick={onClose}>×</button>
      <h3 id={titleId}>{tie.match.home.name} {t('match.versusShort')} {tie.match.away.name}</h3>
      <table>
        <caption className="sr-only">{t('liguilla.scorecard')}</caption>
        <thead><tr>
          <th scope="col">{t('liguilla.club')}</th>
          {tie.legs.map(leg => (
            <th scope="col" key={leg.number}>
              {legName(leg)}
              <small>{legVenue(tie, leg, t)}</small>
              {leg.match && <small className="liguilla-status" data-live={leg.match.state === 'live'}>
                {matchStatusText(leg.match, t)}
              </small>}
            </th>
          ))}
          <th scope="col"><abbr title={t('liguilla.aggregate')}>{t('liguilla.aggregateShort')}</abbr></th>
        </tr></thead>
        <tbody>{teams.map((team, i) => (
          <tr key={team.id}>
            <th scope="row">{team.name}<small>{team.overallSeed ? t('liguilla.seed', team.overallSeed) : t('liguilla.seedPending')}</small></th>
            {tie.legs.map(leg => <td key={leg.number}>{scoreCell(leg, team, i)}</td>)}
            <td className="liguilla-total">{outcome.aggregate[i] ?? '–'}</td>
          </tr>
        ))}</tbody>
      </table>
      {final && predict && !vuelta.locked && <p className="liguilla-note">{t('liguilla.includeExtraTime')}</p>}
      {final && (canPickPenalties || hasPenalties || hasSavedPenalties) && (
        <fieldset className="liguilla-shootout">
          <legend>{t(savedPenaltiesOnly ? 'liguilla.originalPenalties' : 'matchDetails.penaltyShootout')}</legend>
          {teams.map((team, i) => (
            <div key={team.id}>
              <span>{team.name}</span>
              {canPickPenalties
                ? <GoalsInput value={tie.savedPenalties[i]} label={t('liguilla.penaltyGoals', team.name)}
                    onChange={score => onScore('penalties', team.id, score)} />
                : <strong>{(savedPenaltiesOnly ? tie.savedPenalties[i] : tie.penalties[i]) ?? '–'}</strong>}
              {hasPenalties && hasSavedPenalties && tie.savedPenalties[i] !== null
                && <small>{t('liguilla.savedPick', tie.savedPenalties[i])}</small>}
            </div>
          ))}
        </fieldset>
      )}
      <Verdict tie={tie} predict={predict} canPickPenalties={canPickPenalties} />
    </aside>
  );
}
