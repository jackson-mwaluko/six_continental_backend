import multer from 'multer';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { logActivity } from '../utils/activity.js';
import { storeFile, deleteFile, keyFromUrl } from '../services/storage.service.js';

export const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(png|jpe?g|gif|webp)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new ApiError(400, 'Avatar must be an image (PNG, JPG, GIF, or WEBP)'));
  },
});

const shape = (u) => ({
  id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName,
  role: u.role, jobTitle: u.jobTitle, phone: u.phone, avatarUrl: u.avatarUrl,
  isActive: u.isActive, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
  notifyInApp: u.notifyInApp, notifyEmail: u.notifyEmail,
  department: u.department ? { id: u.department.id, name: u.department.name } : null,
  company: u.company ? { id: u.company.id, name: u.company.name, shortName: u.company.shortName } : null,
});

// PATCH /api/profile/notifications — turn in-app and/or email alerts on or off
export const updateNotificationPrefs = asyncHandler(async (req, res) => {
  const data = {};
  if (req.body.notifyInApp !== undefined) data.notifyInApp = !!req.body.notifyInApp;
  if (req.body.notifyEmail !== undefined) data.notifyEmail = !!req.body.notifyEmail;

  const user = await prisma.user.update({ where: { id: req.user.id }, data, include: { department: true, company: true } });
  res.json({ success: true, data: shape(user) });
});

// POST /api/profile/test-email — send yourself a test message to confirm SMTP works.
// Bypasses the email preference since this is an explicit, one-off manual action.
export const sendTestEmail = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true, firstName: true } });
  const { sendEmail } = await import('../services/email.service.js');
  const result = await sendEmail({
    to: user.email,
    subject: 'IOMS test email',
    html: `<p>Hi ${user.firstName},</p><p>This is a test message from your IOMS notification settings — if you're reading this, email delivery is working correctly.</p>`,
    text: 'This is a test message from your IOMS notification settings — email delivery is working correctly.',
  });
  if (result?.skipped) {
    return res.json({ success: true, message: 'SMTP is not configured on the server yet, so no email was actually sent (check the backend .env).' });
  }
  res.json({ success: true, message: `Test email sent to ${user.email}.` });
});

// GET /api/profile — the signed-in user's own full profile
export const getProfile = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { department: true, company: true } });
  if (!user) throw ApiError.notFound('User not found');
  res.json({ success: true, data: shape(user) });
});

// PATCH /api/profile — update own editable fields (not role, email, department, or status)
export const updateProfile = asyncHandler(async (req, res) => {
  const data = {};
  for (const k of ['firstName', 'lastName', 'jobTitle', 'phone']) {
    if (req.body[k] !== undefined) data[k] = req.body[k]?.trim() || null;
  }
  if (data.firstName === null || data.firstName === '') delete data.firstName;
  if (data.lastName === null || data.lastName === '') delete data.lastName;

  const user = await prisma.user.update({ where: { id: req.user.id }, data, include: { department: true, company: true } });
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'User', entityId: user.id, metadata: { self: true } });
  res.json({ success: true, data: shape(user) });
});

// POST /api/profile/change-password — self-service, no admin needed
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) throw ApiError.notFound('User not found');

  const ok = await comparePassword(currentPassword, user.passwordHash);
  if (!ok) throw ApiError.badRequest('Current password is incorrect');

  const same = await comparePassword(newPassword, user.passwordHash);
  if (same) throw ApiError.badRequest('New password must be different from your current password');

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });

  // Log out other sessions/devices for safety, but keep this one signed in.
  const currentToken = req.cookies?.refreshToken;
  await prisma.refreshToken.updateMany({
    where: { userId: user.id, NOT: { token: currentToken || '__none__' } },
    data: { revoked: true },
  });

  await logActivity({ userId: user.id, action: 'CHANGE_PASSWORD', entity: 'User', entityId: user.id, metadata: { self: true } });
  res.json({ success: true, message: 'Password updated. Your other sessions have been signed out.' });
});

// POST /api/profile/avatar — upload/replace the profile photo (field name: "avatar")
export const setAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No image uploaded');

  const existing = await prisma.user.findUnique({ where: { id: req.user.id }, select: { avatarUrl: true, avatarKey: true } });
  const { url, key } = await storeFile({
    mediaType: 'user-avatar', buffer: req.file.buffer,
    originalName: req.file.originalname, mimeType: req.file.mimetype,
  });
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { avatarUrl: url, avatarKey: key },
    include: { department: true, company: true },
  });

  if (existing?.avatarUrl) await deleteFile(existing.avatarKey || keyFromUrl(existing.avatarUrl));

  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'User', entityId: user.id, metadata: { avatar: true } });
  res.status(201).json({ success: true, data: shape(user) });
});

// DELETE /api/profile/avatar — revert to initials
export const removeAvatar = asyncHandler(async (req, res) => {
  const existing = await prisma.user.findUnique({ where: { id: req.user.id }, select: { avatarUrl: true, avatarKey: true } });
  if (existing?.avatarUrl) await deleteFile(existing.avatarKey || keyFromUrl(existing.avatarUrl));
  const user = await prisma.user.update({ where: { id: req.user.id }, data: { avatarUrl: null, avatarKey: null }, include: { department: true, company: true } });
  res.json({ success: true, data: shape(user) });
});

// GET /api/profile/avatar/:filename — serve a profile photo (any authenticated user, e.g. to show teammates' avatars)
// GET /api/profile/avatar/:filename — legacy avatar serving (pre-Supabase files).
// New avatars use the storage service (Supabase URL or /api/files/...). Kept so
// any avatar saved before the migration still renders.
export const getAvatarFile = asyncHandler(async (req, res) => {
  const fsMod = await import('fs');
  const pathMod = await import('path');
  const filename = pathMod.basename(req.params.filename);
  const candidates = [
    pathMod.join(process.env.UPLOAD_DIR || 'uploads', 'avatars', filename),
    pathMod.join(process.env.UPLOAD_DIR || 'uploads', 'user-avatar', filename),
  ];
  const hit = candidates.find((p) => fsMod.existsSync(p));
  if (!hit) throw ApiError.notFound('Image not found');
  res.sendFile(pathMod.resolve(hit));
});
