import prisma from '../config/prisma.js';
import { sendEmail } from './email.service.js';
import logger from '../config/logger.js';

// Does the actual send and flags the notification as emailed.
async function processEmail({ notificationId, to, subject, html, text }) {
  await sendEmail({ to, subject, html, text });
  if (notificationId) {
    await prisma.notification.update({ where: { id: notificationId }, data: { emailSent: true } }).catch(() => {});
  }
}

let queue = null;
let useRedis = false;

// Try to stand up a BullMQ queue + worker when REDIS_URL is configured.
async function initQueue() {
  if (queue !== null || !process.env.REDIS_URL) return;
  try {
    const { Queue, Worker } = await import('bullmq');
    const connection = { url: process.env.REDIS_URL };
    queue = new Queue('emails', { connection });
    new Worker('emails', async (job) => processEmail(job.data), { connection });
    useRedis = true;
    logger.info('Email queue running on BullMQ/Redis');
  } catch (e) {
    logger.warn({ err: e.message }, 'BullMQ unavailable — using inline email sending');
    queue = null;
    useRedis = false;
  }
}
initQueue();

// Inline fallback: send asynchronously with a few retries, never blocking the request.
async function inlineSend(data, attempt = 1) {
  try {
    await processEmail(data);
  } catch (e) {
    if (attempt < 3) {
      const delay = 1000 * 2 ** (attempt - 1);
      setTimeout(() => inlineSend(data, attempt + 1), delay);
    } else {
      logger.error({ err: e.message, to: data.to }, 'Email failed after retries');
    }
  }
}

// Public API: queue an email without blocking the caller.
export async function enqueueEmail(data) {
  if (useRedis && queue) {
    try {
      await queue.add('send', data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true });
      return;
    } catch (e) {
      logger.warn({ err: e.message }, 'Queue add failed — sending inline');
    }
  }
  inlineSend(data);
}

export default { enqueueEmail };
