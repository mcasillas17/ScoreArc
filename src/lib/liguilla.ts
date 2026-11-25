import { playedLegStatus } from '@/server/data/providers/espn-leg';
import { parseShootout } from '@/server/data/providers/espn-matches';
import { placeholderTeam, projectedMatch } from '@/server/data/liguillaProjection';
import type { BracketMatch, BracketRound, BracketTeam } from '@/server/data/types';
import {
  displayedPrediction, liguillaTieKey, type LiguillaPredictions, type ScoreCells, type TiePrediction,
} from './liguillaPredictions';

export { liguillaTieKey, MAX_LIGUILLA_SCORE, parseLiguillaPredictions, setLiguillaScore } from './liguillaPredictions';
export type { LiguillaPredictions, ScoreCells, ScoreField } from './liguillaPredictions';

export interface LiguillaLeg {
  number: 1 | 2;
  match: BracketMatch | null;
  actual: ScoreCells;
  saved: ScoreCells;
  effective: ScoreCells;
  locked: boolean;
}

export interface LiguillaOutcome {
  aggregate: ScoreCells;
  winnerId: string | null;
  leaderId: string | null;
  reason: 'aggregate' | 'seed' | 'extra-time' | 'penalties' | null;
}

export interface LiguillaTie {
  key: string;
  match: BracketMatch;
  legs: [LiguillaLeg, LiguillaLeg];
  official: LiguillaOutcome;
  forecast: LiguillaOutcome;
  penalties: ScoreCells;
  savedPenalties: ScoreCells;
}

const emptyOutcome = (): LiguillaOutcome => ({ aggregate: [null, null], winnerId: null, leaderId: null, reason: null });

function scored(cells: ScoreCells): cells is [number, number] {
  return cells.every(n => n !== null && Number.isSafeInteger(n) && n >= 0);
}

// mapState maps several interruptions to "live"; only an actual period of play carries a score.
function liveLeg(leg: BracketMatch): boolean {
  if (leg.state !== 'live') return false;
  if (/^STATUS_(IN_PROGRESS|FIRST_HALF|HALFTIME|SECOND_HALF|END_PERIOD)$/.test(leg.statusName)) return true;
  return leg.round === 'final' && leg.legNumber === 2 &&
    /^STATUS_(EXTRA_TIME.*|OVERTIME.*|SHOOTOUT|PENALTY_SHOOTOUT)$/.test(leg.statusName);
}

function finishedLeg(leg: BracketMatch): boolean {
  return leg.state === 'finished' && playedLegStatus(leg.statusName, leg.round, leg.legNumber, 'liga-mx-apertura');
}

function inDisplayOrder(tie: BracketMatch, leg: BracketMatch, home: number | null, away: number | null): ScoreCells {
  return tie.home.id === leg.home.id ? [home, away] : [away, home];
}

function sameClubs(a: BracketMatch, b: BracketMatch): boolean {
  return a.round === b.round && ((a.home.id === b.home.id && a.away.id === b.away.id) ||
    (a.home.id === b.away.id && a.away.id === b.home.id));
}

function upcomingLeg(leg: BracketMatch): boolean {
  return leg.state === 'scheduled' && ['STATUS_SCHEDULED', 'STATUS_DELAYED', 'STATUS_POSTPONED'].includes(leg.statusName);
}

function validEvidence(match: BracketMatch, ida: BracketMatch | null, vuelta: BracketMatch | null): boolean {
  if (match.home.placeholder || match.away.placeholder || match.home.id === match.away.id) return false;
  const raw = match.legs ?? [];
  if (raw.length !== Number(!!ida) + Number(!!vuelta) || raw.some(m => !sameClubs(m, match))) return false;
  if (raw.some(m => !upcomingLeg(m) && !liveLeg(m) && !finishedLeg(m))) return false;
  if (vuelta && !upcomingLeg(vuelta) && (!ida || !finishedLeg(ida))) return false;
  return !ida || !vuelta || (ida.id !== vuelta.id && ida.home.id === vuelta.away.id &&
    Date.parse(ida.kickoff) < Date.parse(vuelta.kickoff));
}

interface SeriesScores {
  ida: ScoreCells;
  vuelta: ScoreCells;
  penalties: ScoreCells;
  complete: boolean;
}

function outcome(
  match: BracketMatch, { ida, vuelta, penalties, complete }: SeriesScores,
  returnLeg: BracketMatch | null, eligible: boolean,
): LiguillaOutcome {
  const returnStatus = returnLeg?.statusName;
  const returnStarted = !!returnLeg && returnLeg.state !== 'scheduled';
  const result = emptyOutcome();
  if (!eligible || !scored(ida) || (returnStarted && !scored(vuelta))) return result;
  const [home, away] = scored(vuelta) ? [ida[0] + vuelta[0], ida[1] + vuelta[1]] : ida;
  result.aggregate = [home, away];
  let advancing: string | null = null;
  if (home !== away) {
    // A final cannot both end in penalties and have a non-level aggregate.
    if (returnStatus === 'STATUS_FINAL_PEN') return result;
    advancing = home > away ? match.home.id : match.away.id;
    result.reason = returnStatus === 'STATUS_FINAL_AET' ? 'extra-time' : 'aggregate';
  } else if (match.round !== 'final') {
    const a = match.home.overallSeed, b = match.away.overallSeed;
    if (a && b && Number.isSafeInteger(a) && Number.isSafeInteger(b) && a > 0 && b > 0 && a !== b) {
      advancing = a < b ? match.home.id : match.away.id;
      result.reason = 'seed';
    }
  } else if (complete && scored(penalties) && penalties[0] !== penalties[1]) {
    advancing = penalties[0] > penalties[1] ? match.home.id : match.away.id;
    result.reason = 'penalties';
  }
  if (complete) result.winnerId = advancing;
  else result.leaderId = advancing;
  return result;
}

/** The wrapper's score and winner are derived exclusively from its constituent games. */
export function analyzeLiguillaTie(match: BracketMatch, prediction: TiePrediction = {}): LiguillaTie {
  const raw = match.legs ?? [];
  const byOrdinal = (number: 1 | 2) => {
    const candidates = raw.filter(m => m.legNumber === number && sameClubs(match, m));
    return candidates.length === 1 ? candidates[0] : null;
  };
  const ida = byOrdinal(1), vuelta = byOrdinal(2);
  const valid = validEvidence(match, ida, vuelta);
  const returnStarted = !!vuelta && vuelta.state !== 'scheduled';
  function legView(number: 1 | 2, leg: BracketMatch | null): LiguillaLeg {
    const actual: ScoreCells = leg && (liveLeg(leg) || finishedLeg(leg))
      ? inDisplayOrder(match, leg, leg.homeScore, leg.awayScore) : [null, null];
    const saved = displayedPrediction(match, prediction[number]);
    const locked = !valid || (leg ? leg.state !== 'scheduled' : number === 1 && returnStarted);
    return { number, match: leg, actual, saved, locked, effective: locked ? actual : saved };
  }
  const first = legView(1, ida), second = legView(2, vuelta);
  const complete = !!ida && finishedLeg(ida) && !!vuelta && finishedLeg(vuelta);
  const inShootout = vuelta?.state === 'live' && ['STATUS_SHOOTOUT', 'STATUS_PENALTY_SHOOTOUT'].includes(vuelta.statusName);
  const afterShootout = vuelta?.state === 'finished' && vuelta.statusName === 'STATUS_FINAL_PEN';
  const shootout = vuelta?.round === 'final' && (inShootout || afterShootout)
    ? vuelta.shootout ?? parseShootout(vuelta.note, vuelta.home.name, vuelta.away.name, true) : null;
  const penalties: ScoreCells = vuelta && shootout
    ? inDisplayOrder(match, vuelta, shootout.homeScore, shootout.awayScore) : [null, null];
  const savedPenalties = displayedPrediction(match, prediction.penalties);
  const official = outcome(match, { ida: first.actual, vuelta: second.actual, penalties, complete }, vuelta, valid);
  const canFinish = (leg: LiguillaLeg) => scored(leg.effective) && (!leg.locked || (!!leg.match && finishedLeg(leg.match)));
  const forecast = outcome(match, {
    ida: first.effective, vuelta: second.effective, penalties: second.locked ? penalties : savedPenalties,
    complete: canFinish(first) && canFinish(second),
  }, vuelta, valid);
  return { key: liguillaTieKey(match), match, legs: [first, second], official, forecast, penalties, savedPenalties };
}

type LiguillaRound = 'quarterfinals' | 'semifinals' | 'final';

function hasClubs(match: BracketMatch): boolean {
  return !match.home.placeholder && !match.away.placeholder && match.home.id !== match.away.id;
}

function winner(match: BracketMatch): BracketTeam | null {
  if (match.winnerId === match.home.id) return match.home;
  if (match.winnerId === match.away.id) return match.away;
  return null;
}

function openMatch(round: LiguillaRound, slot: number, a?: BracketTeam, b?: BracketTeam): BracketMatch {
  const id = 'proj-' + round + '-' + slot;
  return projectedMatch(id, round, a ?? placeholderTeam(id + '-a'), b ?? placeholderTeam(id + '-b'));
}

function semifinals(quarters: BracketMatch[], published: BracketMatch[]): BracketMatch[] {
  if (published.length >= 2) return published.slice(0, 2);
  if (published.length === 1) {
    const known = published[0];
    // Exclude both clubs in each feeder. A projected winner in those quarters can
    // differ from the semifinalist the league subsequently publishes.
    const entrants = new Set([known.home.id, known.away.id]);
    const remaining = quarters.filter(q => !entrants.has(q.home.id) && !entrants.has(q.away.id));
    const [a, b] = remaining.length === 2 ? remaining.map(winner) : [];
    return [known, openMatch('semifinals', 2, a ?? undefined, b ?? undefined)];
  }
  const winners = quarters.map(winner).filter((team): team is BracketTeam => !!team);
  const seeds = winners.map(team => team.overallSeed);
  if (winners.length === 4 && seeds.every(Boolean) && new Set(seeds).size === 4) {
    winners.sort((a, b) => a.overallSeed! - b.overallSeed!);
    return [openMatch('semifinals', 1, winners[0], winners[3]), openMatch('semifinals', 2, winners[1], winners[2])];
  }
  return [openMatch('semifinals', 1), openMatch('semifinals', 2)];
}

export function buildLiguillaModel(
  source: BracketRound[], predictions: LiguillaPredictions = {}, mode: 'live' | 'predict' = 'live',
): { rounds: BracketRound[]; ties: Record<string, LiguillaTie> } {
  const ties: Record<string, LiguillaTie> = {};
  function render(match: BracketMatch): BracketMatch {
    if (!hasClubs(match)) return match;
    const key = liguillaTieKey(match);
    const tie = analyzeLiguillaTie(match, predictions[key]);
    const view = mode === 'predict' ? tie.forecast : tie.official;
    tie.match = { ...match, homeScore: view.aggregate[0], awayScore: view.aggregate[1], winnerId: view.winnerId };
    ties[key] = tie;
    return tie.match;
  }
  const matches = (round: LiguillaRound) => source.find(r => r.slug === round)?.matches ?? [];
  const quarters = matches('quarterfinals').map(render);
  // Reserve all eight outer arc positions even when only one tie has been published.
  while (quarters.length < 4) quarters.push(openMatch('quarterfinals', quarters.length + 1));
  const semis = semifinals(quarters, matches('semifinals').filter(hasClubs)).map(render);
  const publishedFinal = matches('final').find(hasClubs);
  const final = publishedFinal ?? openMatch('final', 1, winner(semis[0]) ?? undefined, winner(semis[1]) ?? undefined);
  return { rounds: [
    { slug: 'quarterfinals', matches: quarters }, { slug: 'semifinals', matches: semis }, { slug: 'final', matches: [render(final)] },
  ], ties };
}
