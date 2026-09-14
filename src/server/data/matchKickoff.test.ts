import { expect, it } from 'vitest';
import { isMatchKickoff } from './matchKickoff';

it.each(['2026-09-13T12:00Z', '2026-09-13T12:00:00Z', '2024-02-29T23:59:59.123Z',
  '2026-09-13T19:00:00+07:00', '2026-09-13T05:00:00-07:00'])('accepts a real explicit-zone kickoff: %s', (value) => {
  expect(isMatchKickoff(value)).toBe(true);
});

it.each([null, '', '0', 'September 13, 2026', '2026-09-13', '2026-09-13T12:00:00',
  '2026-02-30T12:00:00Z', '2025-02-29T00:00Z', '2026-13-01T12:00Z',
  '2026-09-13T24:00:00Z', '2026-09-13T12:60:00Z', '2026-09-13T12:00:00Z\n'])('rejects an invalid or ambiguous kickoff: %s', (value) => {
  expect(isMatchKickoff(value)).toBe(false);
});
