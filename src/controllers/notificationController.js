import { bus } from '../services/eventBus.js';
import { verifyAccessToken } from '../utils/jwt.js';

// GET /api/notifications/stream?token=...
// Server-Sent Events stream that pushes new notifications in real time.
// EventSource can't send Authorization headers, so the access token is
// passed as a query param and verified here.
export function streamNotifications(req, res) {
  let userId;
  try {
    const decoded = verifyAccessToken(req.query.token || '');
    userId = decoded.sub;
  } catch {
    res.status(401).end();
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const onNotify = (n) => res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`);
  bus.on(`notification:${userId}`, onNotify);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(`notification:${userId}`, onNotify);
    res.end();
  });
}

export default { streamNotifications };
