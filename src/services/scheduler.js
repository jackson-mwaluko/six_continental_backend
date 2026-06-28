import cron from 'node-cron';
import logger from '../config/logger.js';
import {
  runAllChecks, runTonerCheck, runStockCheck, runSubscriptionCheck, runMaintenanceCheck, runSlaCheck,
} from './reminder.service.js';

// Registers background jobs. Called once at server start.
export function startScheduler() {
  // Daily 07:00 — full sweep of alerts and reminders.
  cron.schedule('0 7 * * *', async () => {
    try { logger.info({ result: await runAllChecks() }, 'daily checks complete'); }
    catch (e) { logger.error({ err: e.message }, 'daily checks failed'); }
  });

  // Hourly — keep toner depletion + subscription status fresh.
  cron.schedule('0 * * * *', async () => {
    try { await Promise.all([runTonerCheck(), runSubscriptionCheck()]); }
    catch (e) { logger.error({ err: e.message }, 'hourly checks failed'); }
  });

  // Every 15 min — SLA breach detection + escalation (time-sensitive).
  cron.schedule('*/15 * * * *', async () => {
    try { await runSlaCheck(); }
    catch (e) { logger.error({ err: e.message }, 'SLA check failed'); }
  });

  logger.info('Background jobs registered (daily 07:00, hourly, SLA every 15m)');
}

export { runAllChecks, runTonerCheck, runStockCheck, runSubscriptionCheck, runMaintenanceCheck, runSlaCheck };
