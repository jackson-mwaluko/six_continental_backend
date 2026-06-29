import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken, signResetToken, verifyResetToken } from '../utils/jwt.js';
import { logActivity } from '../utils/activity.js';
import { isLocked, lockRemainingMs, recordFailure, clearAttempts } from '../utils/loginGuard.js';
import { sendEmail } from '../services/email.service.js';
import logger from '../config/logger.js';
import { env } from '../config/env.js';

const publicUser = (u) => ({
  id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName,
  role: u.role, jobTitle: u.jobTitle, avatarUrl: u.avatarUrl, departmentId: u.departmentId,
});

const issueTokens = async (user) => {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = signRefreshToken({ sub: user.id });
  const decoded = verifyRefreshToken(refreshToken);
  await prisma.refreshToken.create({
    data: { token: refreshToken, userId: user.id, expiresAt: new Date(decoded.exp * 1000) },
  });
  return { accessToken, refreshToken };
};

// POST /api/auth/register  (SUPER_ADMIN / ICT_ADMIN provision new users)
export const register = asyncHandler(async (req, res) => {
  const { email, password, firstName, lastName, role, departmentId, jobTitle, phone } = req.body;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw ApiError.conflict('A user with that email already exists');

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      firstName,
      lastName,
      role: role || 'EMPLOYEE',
      departmentId: departmentId || null,
      jobTitle: jobTitle || null,
      phone: phone || null,
    },
  });

  await logActivity({ userId: req.user?.id, action: 'CREATE', entity: 'User', entityId: user.id });
  res.status(201).json({ success: true, data: publicUser(user) });
});

// controllers/authController.js

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (isLocked(email)) {
    const mins = Math.ceil(lockRemainingMs(email) / 60000);
    throw new ApiError(429, `Account temporarily locked. Try again in ${mins} minute(s).`);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) { recordFailure(email); throw ApiError.unauthorized('Invalid credentials'); }

  const ok = await comparePassword(password, user.passwordHash);
  if (!ok) {
    const rec = recordFailure(email);
    if (rec.lockedUntil) logger.warn({ email }, 'Account locked after repeated failures');
    throw ApiError.unauthorized('Invalid credentials');
  }

  clearAttempts(email);
  const { accessToken, refreshToken } = await issueTokens(user);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  // --- UPDATE COOKIE SETTINGS ---
  const isProduction = env.nodeEnv === 'production';
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: true, // Always true for Render (HTTPS)
    sameSite: 'none', // CRITICAL: Must be 'none' for cross-domain
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });

  await logActivity({ userId: user.id, action: 'LOGIN', entity: 'Auth', ipAddress: req.ip });
  res.json({ success: true, data: { user: publicUser(user), accessToken } });
});

// POST /api/auth/refresh
export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) throw ApiError.unauthorized('Missing refresh token');

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid refresh token');
  }

  const stored = await prisma.refreshToken.findUnique({ where: { token } });
  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
    throw ApiError.unauthorized('Refresh token expired or revoked');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive) throw ApiError.unauthorized();

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  res.json({ success: true, data: { accessToken } });
});

export const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (token) {
    await prisma.refreshToken.updateMany({ where: { token }, data: { revoked: true } });
  }
  
  // --- CLEAR COOKIE WITH SAME SETTINGS ---
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    domain: '.onrender.com',
    path: '/'
  });
  
  res.json({ success: true, message: 'Logged out' });
});

// GET /api/auth/me
export const me = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { department: true },
  });
  res.json({ success: true, data: publicUser(user) });
});

// POST /api/auth/forgot-password — emails a reset link (always 200 to avoid user enumeration)
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });

  if (user && user.isActive) {
    const token = signResetToken({ sub: user.id });
    const link = `${env.clientUrl || 'http://localhost:5173'}/reset-password?token=${token}`;
    await sendEmail({
      to: user.email,
      subject: 'IOMS password reset',
      html: `<p>We received a request to reset your password.</p><p><a href="${link}">Reset your password</a> (valid for 30 minutes).</p><p>If you didn't request this, you can ignore this email.</p>`,
      text: `Reset your password (valid 30 min): ${link}`,
    });
    logger.info({ userId: user.id }, 'Password reset requested');
  }

  res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
});

// POST /api/auth/reset-password — consumes the token and sets a new password
export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  let payload;
  try { payload = verifyResetToken(token); }
  catch { throw ApiError.badRequest('This reset link is invalid or has expired.'); }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw ApiError.badRequest('This reset link is invalid or has expired.');

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
  // Revoke existing sessions for safety.
  await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } });
  clearAttempts(user.email);
  await logActivity({ userId: user.id, action: 'RESET_PASSWORD', entity: 'Auth', entityId: user.id });

  res.json({ success: true, message: 'Password updated. You can now sign in.' });
});
