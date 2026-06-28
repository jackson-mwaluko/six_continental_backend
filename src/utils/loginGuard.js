// In-memory brute-force guard. Tracks failed logins per email and locks
// the account for a cooldown after too many failures.
// NOTE: for multi-instance deployments, back this with Redis.
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOCK_MS = Number(process.env.LOGIN_LOCK_MINUTES || 15) * 60 * 1000;

const attempts = new Map(); // email -> { count, lockedUntil }

export function isLocked(email) {
  const rec = attempts.get(email);
  if (!rec) return false;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) { attempts.delete(email); return false; }
  return false;
}

export function lockRemainingMs(email) {
  const rec = attempts.get(email);
  return rec?.lockedUntil ? Math.max(0, rec.lockedUntil - Date.now()) : 0;
}

export function recordFailure(email) {
  const rec = attempts.get(email) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedUntil = Date.now() + LOCK_MS;
  attempts.set(email, rec);
  return rec;
}

export function clearAttempts(email) {
  attempts.delete(email);
}
