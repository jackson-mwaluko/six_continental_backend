import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const signAccessToken = (payload) =>
  jwt.sign(payload, env.jwt.accessSecret, { expiresIn: env.jwt.accessExpires });

export const signRefreshToken = (payload) =>
  jwt.sign(payload, env.jwt.refreshSecret, { expiresIn: env.jwt.refreshExpires });

export const verifyAccessToken = (token) =>
  jwt.verify(token, env.jwt.accessSecret);

export const verifyRefreshToken = (token) =>
  jwt.verify(token, env.jwt.refreshSecret);

// Short-lived, single-purpose token for password resets.
export const signResetToken = (payload) =>
  jwt.sign({ ...payload, kind: 'reset' }, env.jwt.accessSecret, { expiresIn: '30m' });

export const verifyResetToken = (token) => {
  const decoded = jwt.verify(token, env.jwt.accessSecret);
  if (decoded.kind !== 'reset') throw new Error('Invalid token kind');
  return decoded;
};
