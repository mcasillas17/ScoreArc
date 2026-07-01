import type { Scorer, Card } from '../types';

export function mapSummaryScorers(raw: unknown): Scorer[] {
  const keyEvents: any[] = (raw as any)?.keyEvents ?? [];
  return keyEvents
    .filter((e: any) => e.scoringPlay === true && e.team?.id != null)
    .map(
      (e: any): Scorer => ({
        teamId: String(e.team.id),
        player: e.participants?.[0]?.athlete?.displayName ?? '',
        minute: e.clock?.displayValue ?? '',
        penalty: !!e.penaltyKick,
        shootout: !!e.shootout,
      })
    );
}

// Yellow / red cards from the summary keyEvents (same shape as goals).
// "Yellow Red Card" (second yellow -> sending off) counts as a red.
export function mapSummaryCards(raw: unknown): Card[] {
  const keyEvents: any[] = (raw as any)?.keyEvents ?? [];
  return keyEvents
    .filter((e: any) => /card/i.test(e.type?.text ?? '') && e.team?.id != null)
    .map((e: any): Card => ({
      teamId: String(e.team.id),
      player: e.participants?.[0]?.athlete?.displayName ?? '',
      minute: e.clock?.displayValue ?? '',
      type: /red/i.test(e.type?.text ?? '') ? 'red' : 'yellow',
    }));
}
