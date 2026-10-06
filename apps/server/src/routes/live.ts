import type { FastifyInstance } from 'fastify';
import type { AppContext, LiveEvent } from '../context.ts';

/** WebSocket channel for live run progress and recorder events. Auth happens in the security hook. */
export function registerLiveRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/ws', { websocket: true }, (socket) => {
    const forward = (event: LiveEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };
    ctx.bus.on('event', forward);
    socket.send(JSON.stringify({ type: 'hello', serverStartedAt: ctx.startedAt.toISOString() }));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
      } catch {
        // ignore malformed client messages
      }
    });
    socket.on('close', () => ctx.bus.off('event', forward));
  });
}
