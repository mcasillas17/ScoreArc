import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvaluationArgs, readEvaluationManifest, runEvaluationCLI } from './reader-evaluate';
import { createOfflineEvaluation, OFFLINE_MANIFEST } from './reader-evaluation-fixtures';

const temp: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('explicit evaluation CLI', () => {
  it('disabled invocation does no requests even with unrelated invalid website source configuration', async () => {
    const fetcher = vi.fn(() => { throw new Error('Disabled evaluator fetched'); });
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('SCOREARC_DATA_SOURCE', 'invalid');
    vi.stubEnv('SCOREARC_READER_ORIGIN', 'invalid');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runEvaluationCLI([]);
    expect(fetcher).not.toHaveBeenCalled();
    const report = JSON.parse(String(output.mock.calls[0][0]));
    expect(report).toMatchObject({ enabled: false, mode: 'disabled', counts: { attempted: 0 }, costs: { reader: { calls: 0, bytes: 0 }, espn: { calls: 0, bytes: 0 } } });
  });

  it('defaults to disabled and requires an unambiguous explicit mode', () => {
    expect(parseEvaluationArgs([])).toEqual({ mode: 'disabled' });
    expect(parseEvaluationArgs(['--offline'])).toEqual({ mode: 'offline' });
    expect(parseEvaluationArgs(['--live', '--manifest=scopes.json', '--reader-origin=https://reader.test'])).toEqual({
      mode: 'live', manifest: 'scopes.json', readerOrigin: 'https://reader.test',
    });
    for (const args of [['--live'], ['--offline', '--live'], ['--offline', '--manifest=x'], ['--live', '--manifest=x', '--manifest=y'], ['--help'], ['--reader-origin=https://reader.test']]) {
      expect(() => parseEvaluationArgs(args)).toThrow('Invalid evaluation arguments');
    }
  });

  it('bounds manifest bytes before parsing and sanitizes malformed input errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scorearc-evaluate-')); temp.push(dir);
    const file = join(dir, 'manifest.json');
    await writeFile(file, JSON.stringify({ version: 1, samples: [] }));
    expect(await readEvaluationManifest(file)).toEqual({ version: 1, samples: [] });
    await writeFile(file, ' '.repeat(32 * 1024 + 1));
    await expect(readEvaluationManifest(file)).rejects.toThrow('Invalid evaluation manifest');
    await writeFile(file, '{secret:test}');
    await expect(readEvaluationManifest(file)).rejects.toThrow(/^Invalid evaluation manifest$/);
  });
});

describe('offline fixture boundary', () => {
  it('evaluates the bounded offline manifest and actually reaches joined popups and indexes', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runEvaluationCLI(['--offline']);
    const raw = String(output.mock.calls[0][0]);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1024 * 1024);
    const report = JSON.parse(raw) as { counts: { attempted: number; matched: number }; samples: { sample: { kind: string }; categories: string[]; reader: { requests: { route: string; competition: string | null }[] }; espn: { requests: { route: string }[] } }[]; limitations: string[] };
    expect(report.counts.attempted).toBe(OFFLINE_MANIFEST.samples.length);
    expect(report.counts.matched).toBeGreaterThan(0);
    for (const kind of ['listPopup', 'playerPopup', 'teamSchedule', 'formPopup']) {
      const row = report.samples.find(sample => sample.sample.kind === kind)!;
      expect(row.reader.requests.some(request => request.route === 'matches' && request.competition === null), kind).toBe(true);
      expect(row.espn.requests.some(request => request.route === 'summary'), kind).toBe(true);
    }
    for (const kind of ['playerPopup', 'leaderLinks']) {
      const row = report.samples.find(sample => sample.sample.kind === kind)!;
      expect(row.reader.requests.some(request => request.route === 'squad'), kind).toBe(true);
      expect(row.espn.requests.some(request => request.route === 'roster'), kind).toBe(true);
    }
    expect(report.samples.find(sample => sample.sample.kind === 'getPlayer')?.categories).toEqual(expect.arrayContaining(['side', 'score']));
    expect(report.limitations.join(' ')).toContain('Not evidence about live coverage or global parity');
  });

  it('covers every non-news method and joined path in four bounded scopes', () => {
    const kinds = OFFLINE_MANIFEST.samples.map(sample => sample.kind);
    expect(kinds).toEqual(expect.arrayContaining(['getMatches', 'getFixtures', 'getLiveWindow', 'getUpcoming', 'getStandings', 'getBracket', 'getMatchSummary', 'getLeaders', 'getTeam', 'getSquad', 'getPlayer', 'listPopup', 'playerPopup', 'teamSchedule', 'leaderLinks', 'formPopup']));
    expect(kinds).not.toContain('getNews');
    expect(OFFLINE_MANIFEST.samples.length).toBeLessThanOrEqual(32);
    expect(new Set(OFFLINE_MANIFEST.samples.map(sample => `${sample.competition}/${sample.season}`)).size).toBeLessThanOrEqual(4);
  });

  it('serves provider fixtures without external fetches and rejects unknown destinations', async () => {
    const native = globalThis.fetch;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      return native(input, init);
    }));
    const offline = await createOfflineEvaluation();
    try {
      const response = await offline.fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.leagues.cup/scoreboard?dates=20260804-20260804');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.events).toHaveLength(2);
      expect(body.events[0].id).toBe('401863555');
      const month = await offline.fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.leagues.cup/scoreboard?dates=202608&limit=1000');
      expect((await month.json()).events).toHaveLength(54);
      expect(requests).toEqual([]);
      await expect(offline.fetch('https://untrusted.example/private')).rejects.toThrow('Unsupported offline request');
      await expect(offline.fetch(new Request(`${offline.readerOrigin}/v1/competitions/world-cup/2026/standings`, { method: 'POST' }))).rejects.toThrow('Unsupported offline request');
      await expect(offline.fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/statistics', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      await expect(offline.fetch(`${offline.readerOrigin}/__test/state`)).rejects.toThrow('Unsupported offline request');
      await expect(offline.fetch('https://site.api.espn.com/unknown')).rejects.toThrow('Unsupported offline request');
      const reader = await offline.fetch(`${offline.readerOrigin}/v1/competitions/leagues-cup/2026/matches?range=20260804-20260804`);
      expect(reader.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\//);
    } finally { await offline.close(); }
  });
});
