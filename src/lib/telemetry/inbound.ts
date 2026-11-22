import { httpHealthEnabled, emitHttpHealth, withHealthContext } from './http';

const responseErrors = new WeakMap<Response, string>();

export function markApiError(response: Response, code: string): Response {
  if (httpHealthEnabled()) responseErrors.set(response, code);
  return response;
}

// ImageResponse renders asynchronously. Its status alone cannot tell whether a PNG reached the end of the stream.
function observeImageBody(response: Response, finish: (outcome: string, bytes: number) => void): Response {
  const reader = response.body!.getReader();
  let bytes = 0;
  let ended = false;
  function end(outcome: string) {
    if (!ended) { ended = true; finish(outcome, bytes); }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (ended) return;
        if (chunk.done) {
          end('success');
          reader.releaseLock();
          controller.close();
        } else {
          bytes += chunk.value.byteLength;
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        if (!ended) {
          end('body');
          reader.releaseLock();
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      end('cancelled');
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  return new Response(body, response);
}

export function observeApiRoute<R extends Request, Args extends unknown[]>(endpoint: string,
  handler: (request: R, ...args: Args) => Promise<Response>) {
  return async (request: R, ...args: Args): Promise<Response> => {
    if (!httpHealthEnabled()) return handler(request, ...args);
    const requestId = crypto.randomUUID();
    const started = performance.now();
    function emit(status: number | null, outcome: string, appError?: string, bytes?: number) {
      emitHttpHealth({ direction: 'inbound', dependency: 'self', endpoint, method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        status, outcome: request.signal.aborted ? 'cancelled' : outcome, appError, bytes, requestId,
        durationMs: Math.max(0, Math.round(performance.now() - started)) });
    }
    return withHealthContext({ requestId }, async () => {
      let response: Response;
      try { response = await handler(request, ...args); }
      catch (error) { emit(null, 'exception'); throw error; }
      if (endpoint === 'og' && request.method !== 'HEAD' && response.ok && response.body) {
        return observeImageBody(response, (outcome, bytes) => emit(response.status, outcome, undefined, bytes));
      }
      emit(response.status, response.status >= 400 ? 'http_error' : 'success', responseErrors.get(response));
      return response;
    });
  };
}
