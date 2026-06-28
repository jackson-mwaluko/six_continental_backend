import { env } from './config/env.js';
import app from './app.js';
import prisma from './config/prisma.js';
import logger from './config/logger.js';
import { initSentry, captureException } from './config/sentry.js';
import { startScheduler } from './services/scheduler.js';

await initSentry(app);

const server = app.listen(env.port, () => {
  logger.info(`IOMS API running → http://localhost:${env.port} (${env.nodeEnv})`);
  startScheduler();
});

// Surface unexpected failures to logs + Sentry instead of dying silently.
process.on('unhandledRejection', (err) => { logger.error({ err }, 'unhandledRejection'); captureException(err); });
process.on('uncaughtException', (err) => { logger.error({ err }, 'uncaughtException'); captureException(err); });

const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Force-exit if connections linger.
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
