import type { PlayoffFormat } from '../competitions';

type LegRound = 'quarterfinals' | 'semifinals' | 'final';

// The scoreboard uses "apertura---quarterfinals"; the team schedule uses "Apertura - Quarterfinals".
export function femenilLegRound(format: PlayoffFormat | undefined, phase: unknown): LegRound | null {
  if (format !== 'femenil-apertura' || typeof phase !== 'string') return null;
  const name = phase.toLowerCase().split(/---|\s+-\s+/).at(-1);
  if (name === 'quarterfinals' || name === 'quarter-finals') return 'quarterfinals';
  if (name === 'semifinals' || name === 'semi-finals') return 'semifinals';
  return name === 'final' ? name : null;
}

export const legPrefix = /^\s*(\d+(?:st|nd|rd|th))\s+leg\b/i;
export function noteLeg(text: unknown): number | undefined {
  const prefix = typeof text === 'string' ? legPrefix.exec(text)?.[1].toLowerCase() : undefined;
  if (!prefix) return undefined;
  return prefix === '1st' ? 1 : prefix === '2nd' ? 2 : 0;
}

// The same evidence as Go's competitionNote: every reported ordinal must agree.
export function providerLeg(leg: { value?: unknown; displayValue?: string } | undefined, notes: { text?: string }[]): number | null {
  const values = [leg?.value, noteLeg(leg?.displayValue), ...notes.map(n => noteLeg(n.text))].filter(n => n != null);
  const ordinal = values[0];
  return (ordinal === 1 || ordinal === 2) && values.every(n => n === ordinal) ? ordinal : null;
}

// FMF settles quarters and semis in regulation; only the final's return leg can go to penalties.
export function playedLegStatus(status: string, round: string, ordinal: number | null | undefined): boolean {
  return status === 'STATUS_FULL_TIME' || (round === 'final' && ordinal === 2 && status === 'STATUS_FINAL_PEN');
}
