import type { AsyncLocalStorage } from 'node:async_hooks';

interface Correlation {
  requestId?: string;
  operationId?: string;
  sampleId?: string;
  readId?: string;
  cohort?: 'sample' | 'control' | 'news';
  logicalEndpoint?: string;
}

export interface FrontendHttpFields extends Correlation {
  direction: 'inbound' | 'outbound';
  dependency: string;
  endpoint: string;
  method: string;
  status: number | null;
  outcome: string;
  durationMs: number;
  bytes?: number;
  appError?: string;
  readerRequestId?: string;
}

export interface DependencyFault {
  code: string;
  status?: number;
}

export interface HealthContext extends Correlation {
  onHttp?: (fields: FrontendHttpFields) => void;
  onDependencyFailure?: (source: 'reader' | 'espn', fault: DependencyFault) => void;
}

// Next supplies AsyncLocalStorage in both server runtimes. Plain Node CLI/tests use the same built-in.
const host = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage };
const Storage = host.AsyncLocalStorage ?? host.process?.getBuiltinModule?.('node:async_hooks')?.AsyncLocalStorage;
const context = Storage ? new Storage<HealthContext>() : undefined;
export const healthContext = (): HealthContext => context?.getStore() ?? {};

export function withHealthContext<T>(fields: HealthContext, run: () => T): T {
  return context ? context.run({ ...context.getStore(), ...fields }, run) : run();
}

export function correlationFields(): Correlation {
  const { requestId, operationId, sampleId, readId, cohort, logicalEndpoint } = healthContext();
  return { requestId, operationId, sampleId, readId, cohort, logicalEndpoint };
}

export function comparisonHealthEnabled() {
  return process.env.SCOREARC_DATA_SOURCE === 'compare' && process.env.SCOREARC_READER_COMPARE_PERCENT !== '0';
}

export function healthMetadata() {
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV;
  const revision = process.env.VERCEL_GIT_COMMIT_SHA;
  return {
    timestamp: new Date().toISOString(),
    environment: env && ['development','test','production','preview'].includes(env) ? env : 'unknown',
    revision: revision && /^[0-9a-f]{7,64}$/i.test(revision) ? revision : undefined,
  };
}

export function emitHttpHealth(fields: FrontendHttpFields) {
  console.info(JSON.stringify({ event: 'scorearc_http', service: 'frontend', ...healthMetadata(), ...correlationFields(), ...fields }));
}
