import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMonitor } from '../../scripts/match-freshness-monitor.mjs';
import { compareTick } from '../../scripts/compare-match-freshness.mjs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import registry from '../../backend/config/competitions.json';
import { currentScopes } from '../../scripts/match-freshness-reader.mjs';
import worker from './worker.mjs';

const origin = 'https://scorearc-reader.fly.dev';
const scopes = currentScopes(registry);
const first = Date.UTC(2026, 10, 25, 12);
const interval = 300_000;
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function database() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  sql.exec(readFileSync(new URL('./migrations/0001_shadow_tick.sql', import.meta.url), 'utf8'));
  return { sql, binding: { prepare(query: string) {
    const stmt = sql.prepare(query);
    return { bind(...values: SQLInputValue[]) { return {
      first: async () => stmt.get(...values) ?? null,
    }; } };
  } } };
}

function reader(status: number) {
  return vi.fn(async (url: string, options: RequestInit) => {
    expect(new URL(url).origin).toBe(origin);
    expect(new URL(url).search).toBe('?scope=season&detail=summary');
    expect(options.method ?? 'GET').toBe('GET');
    expect(options.redirect).toBe('manual');
    return new Response('[]', { status, headers: {
      'Content-Type': 'application/json', 'X-ScoreArc-Freshness': 'empty',
      'X-ScoreArc-Observed-At': '2026-11-25T11:00:00Z', 'X-ScoreArc-Poll-Status': 'ok',
      'X-ScoreArc-Stale-Matches': '0', 'X-ScoreArc-Overdue-Matches': '0',
    } });
  });
}

it('compares successive five-minute observations without sending events or heartbeats', async () => {
  const { binding, sql } = database();
  const bad = reader(503);
  vi.stubGlobal('fetch', bad);
  vi.spyOn(Date, 'now').mockReturnValue(first + 1000);
  await worker.scheduled({ scheduledTime: first }, { SHADOW_DB: binding });
  expect(bad).toHaveBeenCalledTimes(scopes.length);
  await worker.scheduled({ scheduledTime: first }, { SHADOW_DB: binding });
  expect(bad).toHaveBeenCalledTimes(scopes.length);
  const good = reader(200);
  vi.stubGlobal('fetch', good);
  vi.spyOn(Date, 'now').mockReturnValue(first + interval + 1000);
  await worker.scheduled({ scheduledTime: first + interval }, { SHADOW_DB: binding });
  const rows = sql.prepare('SELECT * FROM shadow_tick ORDER BY tick').all();
  expect(rows.map(row => row.requests)).toEqual([scopes.length, scopes.length]);
  const key = scopes[0].competition + '/' + scopes[0].season;
  expect(JSON.parse(String(rows[0].editions))[key]).toMatchObject({ open: true, transition: 'OPEN' });
  expect(JSON.parse(String(rows[1].editions))[key]).toMatchObject({ open: false, transition: 'RESOLVED' });
  expect(good).toHaveBeenCalledTimes(scopes.length);
  expect(rows[1].previous_tick).toBe(first);
});

it('only commits one result when observations overlap, and rejects corrupt history', async () => {
  const { binding, sql } = database();
  vi.stubGlobal('fetch', reader(200));
  vi.spyOn(Date, 'now').mockReturnValue(first);
  await Promise.all([worker.scheduled({ scheduledTime: first }, { SHADOW_DB: binding }), worker.scheduled({ scheduledTime: first }, { SHADOW_DB: binding })]);
  expect(sql.prepare('SELECT count(*) AS n FROM shadow_tick').get()?.n).toBe(1);
  sql.prepare("UPDATE shadow_tick SET editions = '{}'").run();
  await expect(worker.scheduled({ scheduledTime: first + interval }, { SHADOW_DB: binding })).rejects.toThrow(/state/i);
  expect(sql.prepare('SELECT count(*) AS n FROM shadow_tick').get()?.n).toBe(1);
});

it('replays the live GitHub producer against the same responses and identifies divergent or unpairable decisions', async () => {
  const { binding, sql } = database();
  const dir = mkdtempSync(join(tmpdir(), 'scorearc-shadow-parity-'));
  const stateFile = join(dir, 'state.json');
  const run = { repository: 'mcasillas17/ScoreArc', workflow: '.github/workflows/match-freshness.yml',
    ref: 'refs/heads/main', attempt: 1, sha: '1'.repeat(40), number: 1, id: 100 };
  try {
    for (const [i, status] of [503, 200].entries()) {
      const tick = first + i * interval;
      vi.spyOn(Date, 'now').mockReturnValue(tick + 1000);
      vi.stubGlobal('fetch', reader(status));
      await worker.scheduled({ scheduledTime: tick }, { SHADOW_DB: binding });
      await prepareMonitor({ enabled: true, initialize: i === 0, stateFile, baseURL: origin, scopes, now: tick + 1000,
        run: { ...run, number: 1 + i, id: 100 + i }, restoredRun: i === 0 ? undefined : run });
    }
    const pending = JSON.parse(readFileSync(stateFile, 'utf8'));
    const row = sql.prepare('SELECT * FROM shadow_tick ORDER BY tick DESC LIMIT 1').get()!;
    expect(compareTick(pending, row)).toMatchObject({ status: 'match', scopes: scopes.length });
    const editions = JSON.parse(String(row.editions));
    const key = Object.keys(editions)[0];
    editions[key].transition = null;
    expect(compareTick(pending, { ...row, editions: JSON.stringify(editions) })).toMatchObject({
      status: 'different', differences: [{ scope: key, github: { transition: 'RESOLVED' }, shadow: { transition: null } }],
    });
    delete editions[key];
    expect(() => compareTick(pending, { ...row, editions: JSON.stringify(editions) })).toThrow(/scope/i);
    expect(() => compareTick(pending, { ...row, previous_tick: null })).toThrow(/warm|gap/i);
    expect(() => compareTick(pending, { ...row, tick: first })).toThrow(/window/i);
    expect(() => compareTick({ ...pending, phase: 'final' }, row)).toThrow(/pending/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
