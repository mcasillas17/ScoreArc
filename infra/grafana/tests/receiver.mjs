import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Use only the disposable stack from the runbook. Its tokens are intentionally public.
const { TEST_LOKI_URL, TEST_VERCEL_URL, TEST_FLY_URL } = process.env;
for (const url of [TEST_LOKI_URL, TEST_VERCEL_URL, TEST_FLY_URL]) {
  if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('Supply the disposable loopback URLs');
}
const id = randomUUID();
const stamp = new Date().toISOString();
const event = { event: 'scorearc_http', service: 'reader', direction: 'inbound', dependency: 'self',
  endpoint: 'test', method: 'GET', status: 503, outcome: 'http_error', durationMs: 182 };
const read = { event: 'scorearc_reader_comparison', type: 'read', endpoint: 'getMatches',
  outcome: 'mismatch', timestamp: stamp, untrustedField: 'must-not-appear' };
const vercel = { projectId: 'test-project', environment: 'production', id, message: JSON.stringify(read) };
const fly = { fly: {app: {name: 'scorearc-reader'}}, message: JSON.stringify({...event,time: stamp}) };
async function send(url, token, rows) {
  return fetch(url, {method: 'POST', headers: {Authorization: 'Bearer '+token, 'Content-Type':'application/json'},
    body: JSON.stringify(rows), signal: AbortSignal.timeout(20000)});
}
assert.ok([401,403].includes((await send(TEST_VERCEL_URL, 'bad', [vercel])).status));
assert.ok([401,403].includes((await send(TEST_FLY_URL, 'test-vercel', [fly])).status));
assert.equal((await send(TEST_VERCEL_URL, 'test-vercel', [vercel, vercel,
  {...vercel,id:id+'preview',environment:'preview'}, {...vercel,id:id+'foreign',projectId:'elsewhere'},
  {...vercel,id:id+'bad',message:JSON.stringify({...read,timestamp:'invalid'})}])).status, 200);
assert.equal((await send(TEST_FLY_URL, 'test-fly', [fly,{...fly,fly:{app:{name:'unrelated'}}}])).status, 200);
const url = new URL('/loki/api/v1/query_range', TEST_LOKI_URL);
url.searchParams.set('query','{job="scorearc"}');
url.searchParams.set('start', String((Date.now()-120000)*1e6));
let streams = [];
for (let n=0;n<15;n++) {
  const response = await fetch(url);
  assert.equal(response.status,200);
  streams = (await response.json()).data.result;
  if (streams.length>=2) break;
  await delay(500);
}
const rows=streams.flatMap(s=>s.values.map(v=>({labels:s.stream,row:JSON.parse(v[1])})));
assert.equal(rows.length,2,'use a fresh disposable Loki for this test');
assert.ok(rows.some(r=>r.labels.service==='frontend' && r.row.outcome==='mismatch'));
assert.ok(rows.some(r=>r.labels.service==='reader' && r.row.status===503 && r.row.durationMs===182));
assert.ok(!JSON.stringify(rows).includes('must-not-appear'));
console.log('Vercel and Fly authentication, batching, filtering and Loki delivery passed.');
