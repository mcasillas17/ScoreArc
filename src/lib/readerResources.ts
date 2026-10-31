import { isISOInstant } from './matchFreshness';

const names = ['matches', 'calendar', 'bracket', 'standings', 'leaders', 'identity', 'detail', 'squad', 'seasonStats', 'career', 'gameLog', 'participation', 'news'] as const;
const statuses = ['fresh', 'empty', 'stale', 'unavailable', 'dormant'] as const;
const availabilities = ['complete', 'empty', 'partial', 'pending', 'unavailable'] as const;
const sources = ['espn', 'mixed'] as const;
const derivations = ['direct', 'projection', 'derived', 'current-roster', 'retained', 'mixed', 'proxy'] as const;
const scopes = ['competition-season', 'selection', 'team-season', 'player-season', 'player', 'match', 'competition'] as const;

export type ReaderResourceName = typeof names[number];
export type ReaderResource = {
  status: typeof statuses[number];
  availability: typeof availabilities[number];
  source: typeof sources[number];
  derivation: typeof derivations[number];
  scope: typeof scopes[number];
  observedAt: string | null;
  finalizedAt: string | null;
};
export type ReaderResources = {
  version: 1;
  resources: Partial<Record<ReaderResourceName, ReaderResource>>;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some(item => item === value);
}

/** Parse evidence only. Source selection and fallback belong to the future apiStore. */
export function parseReaderResources(headers: Pick<Headers, 'get'>): ReaderResources {
  const invalid = () => new Error('Invalid X-ScoreArc-Resources');
  const raw = headers.get('X-ScoreArc-Resources');
  if (!raw || raw.length > 8192 || new TextEncoder().encode(raw).length > 8192) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!object(value) || Object.keys(value).length !== 2 || value.version !== 1 || !object(value.resources)) throw invalid();
  const entries = Object.entries(value.resources);
  if (entries.length === 0 || entries.length > 8) throw invalid();
  const resources: ReaderResources['resources'] = {};
  for (const [name, resource] of entries) {
    if (!member(names, name) || !object(resource) || Object.keys(resource).length !== 7 ||
      !member(statuses, resource.status) || !member(availabilities, resource.availability) ||
      !member(sources, resource.source) || !member(derivations, resource.derivation) ||
      !member(scopes, resource.scope) ||
      (resource.observedAt !== null && !isISOInstant(resource.observedAt)) ||
      (resource.finalizedAt !== null && !isISOInstant(resource.finalizedAt))) throw invalid();
    if (resource.status === 'empty' && (resource.availability !== 'empty' || resource.observedAt === null)) throw invalid();
    resources[name] = {
      status: resource.status, availability: resource.availability, source: resource.source,
      derivation: resource.derivation, scope: resource.scope,
      observedAt: resource.observedAt, finalizedAt: resource.finalizedAt,
    };
  }
  return { version: 1, resources };
}
