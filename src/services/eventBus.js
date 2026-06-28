import { EventEmitter } from 'events';

// Lightweight in-process pub/sub used to push notifications to SSE clients.
// For multi-instance deployments, replace with Redis pub/sub.
export const bus = new EventEmitter();
bus.setMaxListeners(0); // many SSE subscribers

export default bus;
