import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createPreviewServer } from '../../../scripts/reader-preview';
import { competitionPlayerIndex } from './playerIndex';
import { configuredDataStore } from './configuredStore';
import { createDataStore } from './store';
import { TtlCache } from './cache';
import { resolveSeason } from './competitions';

it('builds the directory on the synthetic reader within its shared transport budget, without profile fan-out', async () => {
  const server = createPreviewServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local reader did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  let calls = 0, bytes = 0, active = 0, peak = 0;
  const urls: string[] = [];
  const measured: typeof fetch = async (input, options) => {
    calls++; active++; peak = Math.max(peak, active); urls.push(String(input));
    try {
      const response = await fetch(input, options);
      bytes += (await response.clone().arrayBuffer()).byteLength;
      return response;
    } finally { active--; }
  };
  const espn = createDataStore({ cache: new TtlCache(), fetchJson: async () => { throw new Error('No ESPN calls expected'); } });
  const store = configuredDataStore({ espn, fallback: () => { throw new Error('No fallback expected'); }, fetch: measured,
    env: { SCOREARC_DATA_SOURCE: 'reader', SCOREARC_READER_ORIGIN: origin },
  });
  try {
    const rc = resolveSeason('world-cup', '2026')!;
    const cold = await competitionPlayerIndex(rc, store);
    expect(cold.directory).toMatchObject({ totalTeams: 48, teamsWithRoster: 1, players: [
      { name: 'Ali Avila', slug: 'ali-avila', teamName: 'Argentina', teamAbbr: 'ARG' },
    ] });
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(128);
    expect(bytes).toBeLessThan(32 * 1024 * 1024);
    expect(peak).toBeLessThanOrEqual(4);
    expect(urls.some(url => /\/players\//.test(url))).toBe(false);
    const before = calls;
    expect((await competitionPlayerIndex(rc, store)).directory).toEqual(cold.directory);
    expect(calls - before).toBe(0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
