import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSeason } from './competitions';
import { boundedFetchJson, fetchScoreboardWindow } from './scoreboardWindow';
import recorded from './__fixtures__/scoreboard-window-recorded.json';

const mx = resolveSeason('liga-mx', '2026-apertura')!;
const clausura = { ...mx, season: { ...mx.season, id: '2026-clausura' } };
const wc = resolveSeason('world-cup', '2022')!;
const event = (id = '1', date = '2026-09-15T02:00Z', year = 2026) => ({
  ...structuredClone(recorded.samples['mex-month'].events[0]), id, date,
  season: { year, slug: 'torneo-apertura' },
});
const envelope = (events: unknown[] = [], slug = 'mex.1') => ({ leagues: [{ slug }], events });
const months: string[] = [];
const loader = (responses: Record<string, unknown> = {}) => async (url: string) => {
  const selector = new URL(url).searchParams.get('dates')!;
  months.push(selector);
  expect(new URL(url).searchParams.get('limit')).toBe('1000');
  if (!(selector in responses)) return envelope();
  if (responses[selector] instanceof Error) throw responses[selector];
  return responses[selector];
};
afterEach(() => { months.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('explicit scoreboard windows', () => {
  it('requests compact month selectors and filters exact UTC dates before returning raw events', async () => {
    const inside = event();
    const result = await fetchScoreboardWindow(mx, '20260915-20260915', loader({202609: envelope([
      event('before', '2026-09-14T23:59Z'), inside, event('after', '2026-09-16T00:00Z'),
    ])}));
    expect(result.events).toEqual([inside]);
    expect(months).toEqual(['202609']);
  });
  it('recovers February UTC matches present only in the recorded January provider month', async () => {
    const result = await fetchScoreboardWindow(clausura, '20260201-20260201', loader({
      202601: recorded.samples['mex-jan'], 202602: recorded.samples['mex-feb'],
    }));
    expect(result.events.map(e => e.id)).toEqual(['401840847', '401840846', '401840849']);
    expect(months).toEqual(['202601', '202602']);
  });
  it('pads both month edges and intersects split-season bounds', async () => {
    await expect(fetchScoreboardWindow(mx, '20261231-20270102', loader())).resolves.toEqual({events: []});
    expect(months).toEqual(['202612', '202701']);
  });
  it('crosses a year for a European season', async () => {
    const rc = resolveSeason('laliga', '2026-27')!;
    const fetchJson = async (url: string) => { months.push(new URL(url).searchParams.get('dates')!); return envelope([], rc.competition.espnSlug); };
    await fetchScoreboardWindow(rc, '20261231-20270101', fetchJson);
    expect(months).toEqual(['202612', '202701']);
  });
  it('preserves historical bracket metadata and provider ids', async () => {
    const result = await fetchScoreboardWindow(wc, '20221214-20221218', async () => recorded.samples['world-2022']);
    expect(result.events).toEqual(recorded.samples['world-2022'].events);
  });
  it('returns genuine empty results and skips windows outside a season', async () => {
    await expect(fetchScoreboardWindow(mx, '20260915-20260915', loader())).resolves.toEqual({events: []});
    await expect(fetchScoreboardWindow(mx, '20260101-20260131', loader())).resolves.toEqual({events: []});
    expect(months).toEqual(['202609']);
  });
  it('merges identical duplicates independent of key order', async () => {
    const e = event('1', '2026-10-01T01:00Z');
    const reordered = Object.fromEntries(Object.entries(e).reverse());
    const result = await fetchScoreboardWindow(mx, '20260930-20261001', loader({202609: envelope([e]),202610: envelope([reordered])}));
    expect(result.events).toEqual([e]);
  });
  it('rejects inconsistent duplicates even outside the retained window', async () => {
    const e = event('1', '2026-10-01T01:00Z');
    await expect(fetchScoreboardWindow(mx, '20260930-20260930', loader({202609: envelope([e]),202610: envelope([{...e,name:'conflict'}])}))).rejects.toThrow(/conflict/i);
  });
  it.each([
    ['wrong league', {leagues:[{slug:'esp.1'}], events:[]}],
    ['missing events', {leagues:[{slug:'mex.1'}]}],
    ['reached limit', envelope(Array.from({length:1000},()=>event()))],
    ['count mismatch', {...envelope(),count:1}],
    ['truncated total', {...envelope(),total:1}],
    ['multiple pages', {...envelope(),pageCount:2}],
    ['ignored selector', envelope([event('1','2026-08-15T00:00Z')])],
    ['invalid timestamp', envelope([{...event(),date:'tomorrow'}])],
    ['rolled timestamp', envelope([{...event(),date:'2026-09-31T01:00Z'}])],
    ['invalid identity', envelope([{...event(),id:''}])],
    ['invalid status', envelope([{...event(),status:{type:{state:'bogus'}}}])],
    ['missing team', envelope([{...event(),competitions:[]}])],
    ['object status detail', envelope([{...event(),status:{...event().status,type:{...event().status.type,shortDetail:{text:'FT'}}}}])],
    ['object note', envelope([{...event(),competitions:[{...event().competitions[0],notes:[{text:{value:'FT'}}]}]}])],
    ['negative score', envelope([{...event(),competitions:[{...event().competitions[0],competitors:event().competitions[0].competitors.map(c=>({...c,score:'-1'}))}]}])],
    ['repeated team', envelope([{...event(),competitions:[{...event().competitions[0],competitors:event().competitions[0].competitors.map(c=>({...c,team:event().competitions[0].competitors[0].team}))}]}])],
    ['wrong season', envelope([event('1','2026-09-15T02:00Z',2025)])],
    ['wrong split', envelope([{...event(),season:{year:2026,slug:'torneo-clausura'}}])],
  ])('rejects %s', async (_name, raw) => {
    await expect(fetchScoreboardWindow(mx, '20260915-20260915', loader({202609:raw}))).rejects.toThrow(/scoreboard|abort|range|upstream/i);
  });
  it('allows recorded split-season quarterfinals, semifinals and finals', async () => {
    const result = await fetchScoreboardWindow(clausura,'20260502-20260530',loader({202605:recorded.samples['mex-finals']}));
    expect(result.events).toEqual(recorded.samples['mex-finals'].events);
  });
  it.each([
    ['2025-apertura', '20251101-20251130', '202511', recorded.samples['mex-202511']],
    ['2025-clausura', '20250501-20250531', '202505', recorded.samples['mex-202505']],
  ] as const)('retains recorded play-in phases in %s', async (id, range, month, raw) => {
    const rc = { ...mx, season: { ...mx.season, id } };
    const result = await fetchScoreboardWindow(rc, range, loader({ [month]: raw }));
    expect(result.events).toEqual(raw.events);
  });
  it.each(['apertura-2025---8th-seed-game', 'clausura-2026---8th-seed-game', 'aperturax---8th-seed-game', 'apertura---'])('rejects malformed or wrong-scope phase %s', async slug => {
    const e = { ...event(), season: { year: 2026, slug } };
    await expect(fetchScoreboardWindow(mx, '20260915-20260915', loader({202609: envelope([e])}))).rejects.toThrow(/season/i);
  });
  it('preserves first-seen provider order across partitions and duplicate events', async () => {
    const september = event('9', '2026-09-30T23:00Z');
    const overlap = event('3', '2026-10-01T01:00Z');
    const october = event('1', '2026-10-01T05:00Z');
    const result = await fetchScoreboardWindow(mx, '20260930-20261001', loader({
      202609: envelope([september, overlap]), 202610: envelope([overlap, october]),
    }));
    expect(result.events.map(e => e.id)).toEqual(['9', '3', '1']);
  });
  it('fails the complete window if one partition fails without retrying', async () => {
    await expect(fetchScoreboardWindow(mx,'20260901-20260930',loader({202609:new Error('upstream')}))).rejects.toThrow(/scoreboard|abort|range|upstream/i);
    expect(months).toEqual(['202608','202609']);
  });
  it('bounds request count and rejects excessive ranges before I/O', async () => {
    await fetchScoreboardWindow(mx,'20260801-20261101',loader());
    expect(months).toEqual(['202607','202608','202609','202610','202611']);
    months.length = 0;
    await expect(fetchScoreboardWindow(mx,'20260701-20261231',loader())).rejects.toThrow(/scoreboard|abort|range|upstream/i);
    expect(months).toEqual([]);
  });
  it('rejects oversized response and aggregate payloads', async () => {
    await expect(fetchScoreboardWindow(mx,'20260915-20260915',loader({202609:{...envelope(),padding:'x'.repeat(4*1024*1024)}}))).rejects.toThrow(/bytes/i);
    const fetchJson = async () => ({...envelope(),padding:'x'.repeat(3500000)});
    await expect(fetchScoreboardWindow(mx,'20260801-20261101',fetchJson)).rejects.toThrow(/bytes/i);
  });
  it('honors cancellation before any request and before the next partition', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchScoreboardWindow(mx,'20260915-20260915',loader(),controller.signal)).rejects.toThrow(/scoreboard|abort|range|upstream/i);
    expect(months).toEqual([]);
    const during = new AbortController();
    let calls = 0;
    await expect(fetchScoreboardWindow(mx,'20260901-20260930',async()=>{calls++;during.abort();return envelope();},during.signal)).rejects.toThrow(/scoreboard|abort|range|upstream/i);
    expect(calls).toBe(1);
  });
  it('enforces the whole-window deadline even when injected I/O never settles', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = fetchScoreboardWindow(mx,'20260915-20260915',async (_url, options)=>{signal=options?.signal;return new Promise(()=>{});});
    const assertion = expect(pending).rejects.toThrow(/timeout|deadline/i);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
});

describe('bounded native transport',()=>{
  it('retains the no-options response behavior', async()=>{
    vi.stubGlobal('fetch',async()=>new Response('{"hello":1}'));
    await expect(boundedFetchJson('https://example.test')).resolves.toEqual({hello:1});
  });
  it('decodes UTF-8 split across transport chunks without Node globals', async()=>{
    const encoded=new TextEncoder().encode('{"name":"México"}');
    const body=new ReadableStream({start(c){for(const byte of encoded)c.enqueue(new Uint8Array([byte]));c.close();}});
    vi.stubGlobal('fetch',async()=>new Response(body));
    await expect(boundedFetchJson('https://example.test',{signal:new AbortController().signal,maxBytes:100})).resolves.toEqual({name:'México'});
  });
  it('rejects an oversized declared body before consuming it',async()=>{
    let cancelled=false;
    const body=new ReadableStream({cancel(){cancelled=true;}});
    vi.stubGlobal('fetch',async()=>new Response(body,{headers:{'content-length':'101'}}));
    await expect(boundedFetchJson('https://example.test',{signal:new AbortController().signal,maxBytes:100})).rejects.toThrow(/bytes/i);
    expect(cancelled).toBe(true);
  });
  it('limits streamed bytes and cancels the body on overflow',async()=>{
    let cancelled=false;
    const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(20));},cancel(){cancelled=true;}});
    vi.stubGlobal('fetch',async()=>new Response(body));
    await expect(boundedFetchJson('https://example.test',{signal:new AbortController().signal,maxBytes:10})).rejects.toThrow(/bytes/i);
    expect(cancelled).toBe(true);
  });
  it('cancels a stalled body when the signal aborts',async()=>{
    let cancelled=false;
    const body=new ReadableStream({cancel(){cancelled=true;}});
    vi.stubGlobal('fetch',async()=>new Response(body));
    const controller=new AbortController();
    const pending=boundedFetchJson('https://example.test',{signal:controller.signal,maxBytes:100});
    const assertion=expect(pending).rejects.toThrow(/scoreboard|abort|range|upstream/i);
    await Promise.resolve(); controller.abort();
    await assertion;
    expect(cancelled).toBe(true);
  });
});
