import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';

const DEFAULTS = { 'assignment.maxPerUser': '5' };

export async function getSetting(key) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? DEFAULTS[key] ?? null;
}

export async function getMaxAssignments() {
  const v = Number(await getSetting('assignment.maxPerUser'));
  return Number.isFinite(v) && v > 0 ? v : 5;
}

// GET /api/settings — expose the settings the UI needs (any authenticated user)
export const listSettings = asyncHandler(async (_req, res) => {
  const maxPerUser = await getMaxAssignments();
  res.json({ success: true, data: { assignment: { maxPerUser } } });
});

// PATCH /api/settings/assignment — super admin only
export const updateAssignmentSettings = asyncHandler(async (req, res) => {
  const max = Number(req.body.maxPerUser);
  if (!Number.isFinite(max) || max < 1 || max > 999) throw ApiError.badRequest('maxPerUser must be between 1 and 999');
  await prisma.setting.upsert({
    where: { key: 'assignment.maxPerUser' },
    update: { value: String(Math.floor(max)) },
    create: { key: 'assignment.maxPerUser', value: String(Math.floor(max)) },
  });
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'Setting', entityId: 'assignment.maxPerUser', metadata: { maxPerUser: Math.floor(max) } });
  res.json({ success: true, data: { assignment: { maxPerUser: Math.floor(max) } } });
});
