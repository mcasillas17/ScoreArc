import { parseReaderResources, type ReaderResources } from '@/lib/readerResources';
import { abortable } from './scoreboardWindow';

export type ReaderFailureReason = 'network' | 'http' | 'timeout' | 'metadata' | 'body' | 'stale' | 'unavailable' | 'identity' | 'scope' | 'budget';
export class ReaderFailure extends Error {
  constructor(readonly reason: ReaderFailureReason, readonly fallback = true, readonly status?: number) {
    super(`Reader ${reason}`);
  }
}

/** Configuration is server-only; callers can supply identities, never an origin. */
export function readerOrigin(raw: string | undefined, production: boolean): string {
  let url: URL;
  try { url = new URL(raw ?? ''); } catch { throw new Error('Invalid reader origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.replace(/\.$/, ''));
  if ((production && loopback) || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !production)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid reader origin');
  return url.origin;
}

export interface RequestBudget {
  readonly signal: AbortSignal;
  readonly calls: number;
  readonly bytes: number;
  json(url: string, signal?: AbortSignal): Promise<{ body: unknown; headers: Headers }>;
}

/** One shared budget includes queued reads, response streaming and fallback. */
export function createRequestBudget(options: {
  fetch?: typeof fetch; signal: AbortSignal; maxCalls?: number; maxResponseBytes?: number; maxBytes?: number;
}): RequestBudget {
  const fetcher = options.fetch ?? fetch;
  const maxCalls = options.maxCalls ?? 128;
  const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  let calls = 0, admitted = 0, bytes = 0, active = 0;
  const queue: (() => void)[] = [];
  async function acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (active < 4) { active++; return; }
    let grant!: () => void;
    const pending = new Promise<void>(resolve => { grant = resolve; queue.push(grant); });
    try { await abortable(pending, signal); }
    catch (error) {
      const index = queue.indexOf(grant);
      if (index >= 0) queue.splice(index, 1);
      else release(); // cancellation raced with a reserved slot
      throw error;
    }
  }
  function release() {
    const next = queue.shift();
    if (next) next(); else active--;
  }
  return {
    signal: options.signal,
    get calls() { return calls; },
    get bytes() { return bytes; },
    async json(url, requestSignal) {
      const signal = requestSignal ? AbortSignal.any([options.signal, requestSignal]) : options.signal;
      signal.throwIfAborted();
      if (admitted >= maxCalls) throw new ReaderFailure('budget');
      admitted++;
      await acquire(signal);
      try {
        signal.throwIfAborted();
        if (calls >= maxCalls) throw new ReaderFailure('budget');
        calls++;
        let response: Response;
        try {
          response = await abortable(fetcher(url, { signal, cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'scorearc' } }), signal);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ReaderFailure) throw error;
          throw new ReaderFailure('network');
        }
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          void response.body?.cancel().catch(() => {});
          throw new ReaderFailure('http', false, response.status);
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new ReaderFailure('http', response.status === 429 || response.status >= 500, response.status);
        }
        if (Number(response.headers.get('content-length')) > maxResponseBytes) {
          void response.body?.cancel().catch(() => {});
          throw new ReaderFailure('budget');
        }
        if (!response.body) throw new ReaderFailure('body');
        const stream = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '', size = 0, complete = false;
        try {
          while (true) {
            const part = await abortable(stream.read(), signal);
            signal.throwIfAborted();
            if (part.done) { complete = true; break; }
            size += part.value.byteLength;
            bytes += part.value.byteLength;
            if (size > maxResponseBytes || bytes > maxBytes) throw new ReaderFailure('budget');
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          const body: unknown = JSON.parse(text);
          return { body, headers: response.headers };
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ReaderFailure) throw error;
          throw new ReaderFailure('body');
        } finally {
          if (!complete) void stream.cancel().catch(() => {});
          stream.releaseLock();
        }
      } finally { release(); }
    },
  };
}

export interface ReaderResponse { body: unknown; resources: ReaderResources; headers: Headers }
export type ReaderTransport = (path: string, query?: Record<string, string>) => Promise<ReaderResponse>;
export function createReaderTransport(origin: string, budget: RequestBudget, signal: AbortSignal): ReaderTransport {
  return async (path, query) => {
    if (!path.startsWith('/v1/') || path.includes('?') || path.includes('#') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.')) throw new ReaderFailure('scope', false);
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new ReaderFailure('scope', false);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const { body, headers } = await budget.json(url.href, signal);
    let resources: ReaderResources;
    try { resources = parseReaderResources(headers); }
    catch { throw new ReaderFailure('metadata'); }
    return { body, headers, resources };
  };
}
