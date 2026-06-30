import { dataService } from '@/server/data/service';
import { formatSse } from '@/server/data/sse';

export const dynamic = 'force-dynamic';

const PUSH_INTERVAL_MS = 15_000;

export async function GET() {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval>;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        if (closed) return;
        try {
          const matches = await dataService.getMatches();
          if (!closed) controller.enqueue(encoder.encode(formatSse('matches', matches)));
        } catch (err) {
          if (!closed) controller.enqueue(
            encoder.encode(formatSse('error', { message: String(err) })),
          );
        }
      };
      await push();
      timer = setInterval(push, PUSH_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
