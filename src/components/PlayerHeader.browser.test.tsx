// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getTranslator } from '@/i18n/translate';
import type { PlayerProfile } from '@/server/data/types';
import PlayerHeader from './PlayerHeader';

afterEach(cleanup);

it('replaces a failed portrait with initials and retries a different portrait', () => {
  const player: PlayerProfile = {
    id: 'test-player', name: 'Sarah Luebbert', headshotUrl: 'https://example.test/missing.png', age: null,
    position: '', jersey: null, nationality: null, flagUrl: null, seasonLabel: 'Apertura 2026',
    totals: [], gameLogLabel: '', gameLog: [], career: [], team: null,
  };
  const t = getTranslator('es', 'liga-mx-femenil');
  const { rerender } = render(<PlayerHeader player={player} t={t} />);
  fireEvent.error(screen.getByRole('img', { name: player.name }));
  expect(screen.queryByRole('img', { name: player.name })).toBeNull();
  expect(screen.getByText('SL').closest('.ph-portrait')?.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByRole('heading', { name: player.name })).toBeTruthy();
  rerender(<PlayerHeader player={{ ...player, headshotUrl: 'https://example.test/portrait.png' }} t={t} />);
  expect(screen.getByRole('img', { name: player.name }).getAttribute('src')).toContain('/portrait.png');
});
