import type { MatchState } from './types';

export function mapState(espnState: string, completed: boolean): MatchState {
  if (completed) return 'finished';
  if (espnState === 'pre') return 'scheduled';
  if (espnState === 'post') return 'finished';
  return 'live';
}
