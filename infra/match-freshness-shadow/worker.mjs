import registry from '../../backend/config/competitions.json' with { type: 'json' };
import { currentScopes, checkScope, scopeKey, MAX_SCOPES } from '../../scripts/match-freshness-reader.mjs';
import { assessAlert, newSignal, validSignal } from '../../scripts/match-freshness-policy.mjs';

const scopes = currentScopes(registry);
const keys = new Set(scopes.map(scopeKey));
const reader = 'https://scorearc-reader.fly.dev';
const interval = 5 * 60_000;

function restore(row) {
  if (!row) return {};
  const editions = JSON.parse(row.editions);
  if (!editions || typeof editions !== 'object' || Array.isArray(editions) ||
      !Number.isSafeInteger(row.requests) || row.requests < 1 || row.requests > MAX_SCOPES ||
      Object.keys(editions).length !== row.requests) throw new Error('Invalid shadow state');
  for (const [key, entry] of Object.entries(editions)) {
    if (!entry || typeof entry.open !== 'boolean' || !validSignal(entry.signal, row.finished_ms)) {
      throw new Error('Invalid shadow edition state');
    }
    // A retired edition may leave once quiet or verified dormant, as in the live monitor.
    if (!keys.has(key) && !entry.signal.dormant &&
        (entry.open || entry.signal.prior || Object.keys(entry.signal.waiting).length)) {
      throw new Error('Active shadow edition retired');
    }
  }
  return editions;
}

async function observeTick(scheduledTime, db) {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) throw new Error('Invalid scheduled time');
  const tick = Math.floor(scheduledTime / interval) * interval;
  const previous = await db.prepare('SELECT * FROM shadow_tick ORDER BY tick DESC LIMIT 1').bind().first();
  if (previous && previous.tick >= tick) return { status: 'already-observed', tick, requests: 0 };

  const previousEditions = restore(previous);
  const started = Date.now();
  const editions = {};
  for (const scope of scopes) {
    const key = scopeKey(scope);
    const before = previousEditions[key];
    const signal = before?.signal ?? newSignal();
    const result = await checkScope({ baseURL: reader, ...scope });
    const { alert, cause, observation } = assessAlert(signal, result, before?.open ?? false, started);
    const transition = alert === (before?.open ?? false) ? null : (alert ? 'OPEN' : 'RESOLVED');
    editions[key] = { open: alert, transition, cause, error: observation.error, signal };
  }
  const finished = Date.now();
  // Two ticks can overlap during a slow reader response. Only advance the state we actually read.
  const committed = await db.prepare(`
    INSERT INTO shadow_tick (tick, previous_tick, started_ms, finished_ms, requests, editions)
    SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT MAX(tick) FROM shadow_tick) IS ?
    RETURNING tick
  `).bind(tick, previous?.tick ?? null, started, finished, scopes.length, JSON.stringify(editions), previous?.tick ?? null).first();
  return { status: committed ? 'observed' : 'overlap', tick, requests: scopes.length, wallMs: finished - started };
}

const worker = {
  async scheduled(controller, env) {
    console.log(await observeTick(controller.scheduledTime, env.SHADOW_DB));
  },
};

export default worker;
