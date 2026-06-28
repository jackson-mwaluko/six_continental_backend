import logger from './logger.js';

let Sentry = null;

// Initializes Sentry only when SENTRY_DSN is configured. Safe no-op otherwise.
export async function initSentry(app) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  try {
    const mod = await import('@sentry/node');
    Sentry = mod;
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE || 0.1),
    });
    logger.info('Sentry error tracking enabled');
    return Sentry;
  } catch (e) {
    logger.warn({ err: e.message }, 'Sentry init skipped');
    return null;
  }
}

export function captureException(err) {
  if (Sentry) Sentry.captureException(err);
}
