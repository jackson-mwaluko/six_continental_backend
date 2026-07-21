import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!env.smtp.host) return null; // email disabled if not configured
  const secure = env.smtp.port === 465;
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure,
    // Microsoft 365 / Office 365 (and most modern providers) require STARTTLS
    // on port 587 rather than accepting a plaintext fallback.
    requireTLS: !secure,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
  return transporter;
}

export async function sendEmail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    // eslint-disable-next-line no-console
    console.log(`[email] (disabled) would send "${subject}" to ${to}`);
    return { skipped: true };
  }
  return t.sendMail({ from: env.smtp.from, to, subject, html, text });
}

export default { sendEmail };
