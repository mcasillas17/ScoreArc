import type { BracketMatch } from '@/server/data/types';

export type ScoreCells = [number | null, number | null];
export type ScoreField = 1 | 2 | 'penalties';
// Stored columns follow sorted club IDs; the scorecard columns follow the tie's display order.
export type TiePrediction = Partial<Record<ScoreField, ScoreCells>>;
export type LiguillaPredictions = Record<string, TiePrediction>;
export const MAX_LIGUILLA_SCORE = 99;

export function liguillaTieKey(match: BracketMatch): string {
  return [match.round, ...[match.home.id, match.away.id].sort()].join('|');
}

export function displayedPrediction(match: BracketMatch, cells?: ScoreCells): ScoreCells {
  if (!cells) return [null, null];
  return match.home.id < match.away.id ? [...cells] : [cells[1], cells[0]];
}

function fanScore(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LIGUILLA_SCORE;
}

export function setLiguillaScore(
  predictions: LiguillaPredictions, match: BracketMatch, field: ScoreField, teamId: string, score: number | null,
): LiguillaPredictions {
  const clubs = [match.home.id, match.away.id].sort();
  const index = clubs.indexOf(teamId);
  if (index < 0 || match.home.placeholder || match.away.placeholder || clubs[0] === clubs[1] ||
      (score !== null && !fanScore(score)) || (field === 'penalties' && match.round !== 'final')) return predictions;
  const key = liguillaTieKey(match);
  const entry = { ...predictions[key] };
  const cells: ScoreCells = [...(entry[field] ?? [null, null])];
  cells[index] = score;
  if (cells.every(n => n === null)) delete entry[field];
  else entry[field] = cells;
  const next = { ...predictions };
  if (Object.keys(entry).length) next[key] = entry;
  else delete next[key];
  return next;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Both the edition's local storage and a shared bracket URL contain untrusted JSON. */
export function parseLiguillaPredictions(value: unknown): LiguillaPredictions {
  const picks: LiguillaPredictions = {};
  if (!record(value)) return picks;
  for (const [key, entry] of Object.entries(value).slice(0, 128)) {
    if (!/^(quarterfinals|semifinals|final)\|[\w-]{1,100}\|[\w-]{1,100}$/.test(key) || !record(entry)) continue;
    const [round, a, b] = key.split('|');
    if (a >= b) continue;
    const prediction: TiePrediction = {};
    for (const field of [1, 2, 'penalties'] as const) {
      const cells = entry[field];
      if (field === 'penalties' && round !== 'final') continue;
      if (Array.isArray(cells) && cells.length === 2 && cells.every(n => n === null || fanScore(n)) &&
          cells.some(n => n !== null)) prediction[field] = [cells[0], cells[1]];
    }
    if (Object.keys(prediction).length) picks[key] = prediction;
  }
  return picks;
}
