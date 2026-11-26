import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateState } from './match-freshness-monitor.mjs';
import { validSignal } from './match-freshness-policy.mjs';

const interval = 300_000;
const reader = 'https://scorearc-reader.fly.dev';

export function compareTick(pending, row) {
  if (pending?.version !== 3 || pending.phase !== 'pending' || pending.monitorFailure === 'queue-full') {
    throw new Error('Need an observed v3 match-freshness-pending checkpoint');
  }
  const keys = Object.keys(pending.incidents).sort();
  const scopes = keys.map(key => { const [competition, season] = key.split('/'); return { competition, season }; });
  validateState(pending, { run: pending.run, scopes, baseURL: reader, now: Date.now() });
  const prepared = Date.parse(pending.updatedAt);
  const tick = Math.floor(prepared / interval) * interval;
  if (!row || row.tick !== tick || !Number.isSafeInteger(row.started_ms) || !Number.isSafeInteger(row.finished_ms) ||
      row.started_ms < tick || row.finished_ms < row.started_ms || row.finished_ms >= tick + interval ||
      Math.abs(row.finished_ms - prepared) > 60_000) throw new Error('No aligned observation window');
  if (row.previous_tick !== tick - interval) throw new Error('Shadow warm-up or gap before this observation');

  const editions = JSON.parse(row.editions);
  if (row.requests !== keys.length || Object.keys(editions).sort().join(' ') !== keys.join(' ')) {
    throw new Error('Different scope sets');
  }
  const runUrl = `https://github.com/mcasillas17/ScoreArc/actions/runs/${pending.run.id}`;
  const events = new Map(pending.pending.filter(e => e.runUrl === runUrl).map(e => [e.scope, e.status]));
  const differences = [];
  for (const scope of keys) {
    const entry = editions[scope];
    if (!entry || typeof entry.open !== 'boolean' || !validSignal(entry.signal, row.finished_ms) ||
        entry.cause !== entry.signal.prior || ![null, entry.open ? 'OPEN' : 'RESOLVED'].includes(entry.transition)) {
      throw new Error('Invalid shadow observation');
    }
    const github = { open: pending.incidents[scope] !== null, transition: events.get(scope) ?? null, cause: pending.signals[scope].prior };
    const shadow = { open: entry.open, transition: entry.transition, cause: entry.cause };
    if (github.open !== shadow.open || github.transition !== shadow.transition || github.cause !== shadow.cause) {
      differences.push({ scope, github, shadow });
    }
  }
  return { status: differences.length ? 'different' : 'match', tick, runUrl, scopes: keys.length, differences };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [pendingPath, shadowPath] = process.argv.slice(2);
    if (!pendingPath || !shadowPath) throw new Error('Usage: node scripts/compare-match-freshness.mjs pending.json d1-result.json');
    const [pending, queries] = await Promise.all([pendingPath, shadowPath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
    if (queries.length !== 1 || queries[0]?.success !== true || queries[0].results.length !== 1) {
      throw new Error('Expected one completed D1 shadow tick');
    }
    const report = compareTick(pending, queries[0].results[0]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'match' ? 0 : 1;
  } catch (error) {
    console.error('Inconclusive comparison:', error.message);
    process.exitCode = 2;
  }
}
