import { correlationFields, emitHttpHealth, healthContext } from '@/lib/telemetry/http';

type Dependency = 'reader' | 'espn';

const readerRoutes = [
  '/healthz', '/v1/matches/{id}', '/v1/matches/{id}/box-score', '/v1/competitions/{comp}/news',
  ...['matches','identities','calendar','standings','bracket','top-scorers','leaders','teams',
    'teams/{teamId}','teams/{teamId}/squad','players/{playerId}'].map(path => '/v1/competitions/{comp}/{season}/' + path),
].map(template => ({ template, pattern: new RegExp('^' + template.replace(/\{\w+\}/g, '[^/]+') + '$') }));

export function buildOutboundEndpoint(dependency: Dependency, address: string): string {
  const url = URL.canParse(address) ? new URL(address) : undefined;
  if (!url) return 'other';
  if (dependency === 'reader') return readerRoutes.find(route => route.pattern.test(url.pathname))?.template ?? 'other';
  const route = url.pathname.match(/^\/apis\/(?:site\/v2|v2|common\/v3)\/sports\/soccer\/[^/]+\/(.+)$/)?.[1];
  if (!route) return 'other';
  if (['scoreboard', 'summary', 'standings', 'statistics', 'news', 'teams'].includes(route)) return route;
  if (/^teams\/[^/]+$/.test(route)) return 'team';
  if (/^teams\/[^/]+\/roster$/.test(route)) return 'roster';
  if (/^teams\/[^/]+\/schedule$/.test(route)) return url.searchParams.get('fixture') === 'true' ? 'schedule-upcoming' : 'schedule-results';
  if (/^athletes\/[^/]+$/.test(route)) return 'athlete';
  return route.match(/^athletes\/[^/]+\/(overview|bio)$/)?.[1] ?? 'other';
}

export function startOutboundHttp(dependency: Dependency, url: string, signal?: AbortSignal) {
  const onHttp = healthContext().onHttp ?? (process.env.SCOREARC_HTTP_TELEMETRY === '1' ? emitHttpHealth : undefined);
  if (!onHttp) return;
  const fields = correlationFields();
  const started = performance.now();
  const endpoint = buildOutboundEndpoint(dependency, url);
  return (response: Response | undefined, outcome: string, bytes?: number) => {
    if (signal?.aborted && outcome !== 'success') {
      outcome = signal.reason?.name === 'TimeoutError' || signal.reason?.reason === 'timeout' ? 'timeout' : 'cancelled';
    }
    const requestId = dependency === 'reader' && response?.headers.get('x-request-id');
    const readerRequestId = requestId && /^[a-f0-9]{16}$/.test(requestId) ? requestId : undefined;
    onHttp({ direction:'outbound', dependency, endpoint, method:'GET', status:response?.status ?? null,
      outcome, bytes, durationMs:Math.max(0, Math.round(performance.now() - started)), readerRequestId, ...fields });
  };
}
