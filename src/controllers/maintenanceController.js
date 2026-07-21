import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { runMaintenanceCheck } from '../services/reminder.service.js';
import { notify } from '../services/notification.service.js';

// Adds one recurrence interval to a date.
function addInterval(date, frequency) {
  const d = new Date(date);
  switch (frequency) {
    case 'DAILY': d.setDate(d.getDate() + 1); break;
    case 'WEEKLY': d.setDate(d.getDate() + 7); break;
    case 'MONTHLY': d.setMonth(d.getMonth() + 1); break;
    case 'QUARTERLY': d.setMonth(d.getMonth() + 3); break;
    case 'SEMI_ANNUAL': d.setMonth(d.getMonth() + 6); break;
    case 'ANNUAL': d.setFullYear(d.getFullYear() + 1); break;
    default: return null; // ONE_TIME
  }
  return d;
}

const include = {
  asset: { select: { id: true, serialNumber: true, name: true } },
  assignee: { select: { id: true, firstName: true, lastName: true } },
};

// GET /api/maintenance — list with optional status filter
export const listMaintenance = asyncHandler(async (req, res) => {
  const { status, search, page, limit } = req.query;
  const where = {
    ...(status && { status }),
    ...(search && { title: { contains: search, mode: 'insensitive' } }),
  };
  const take = limit ? Number(limit) : undefined;
  const skip = page && limit ? (Number(page) - 1) * Number(limit) : undefined;

  const [items, total] = await Promise.all([
    prisma.maintenance.findMany({ where, include, skip, take, orderBy: { scheduledDate: 'asc' } }),
    prisma.maintenance.count({ where }),
  ]);
  res.json({ success: true, data: items, meta: { total, page: page ? Number(page) : 1 } });
});

// GET /api/maintenance/:id
export const getMaintenance = asyncHandler(async (req, res) => {
  const item = await prisma.maintenance.findUnique({
    where: { id: req.params.id },
    include: { ...include, logs: { orderBy: { performedAt: 'desc' } } },
  });
  if (!item) throw ApiError.notFound('Maintenance task not found');
  res.json({ success: true, data: item });
});

// POST /api/maintenance — schedule a task
export const createMaintenance = asyncHandler(async (req, res) => {
  const { title, description, assetId, assigneeId, frequency, scheduledDate } = req.body;
  const next = frequency && frequency !== 'ONE_TIME' ? addInterval(scheduledDate, frequency) : null;

  const item = await prisma.maintenance.create({
    data: {
      title, description: description || null, assetId: assetId || null, assigneeId: assigneeId || null,
      frequency: frequency || 'ONE_TIME', scheduledDate: new Date(scheduledDate), nextDueDate: next,
    },
    include,
  });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'Maintenance', entityId: item.id });
  if (item.assigneeId && item.assigneeId !== req.user.id) {
    await notify({
      userId: item.assigneeId, type: 'MAINTENANCE',
      title: 'Maintenance assigned to you',
      message: `${item.title} · due ${new Date(item.scheduledDate).toLocaleDateString()}`,
      link: '/maintenance', email: false,
    });
  }
  res.status(201).json({ success: true, data: item });
});

// POST /api/maintenance/:id/complete — log completion & spawn next occurrence
export const completeMaintenance = asyncHandler(async (req, res) => {
  const item = await prisma.maintenance.findUnique({ where: { id: req.params.id } });
  if (!item) throw ApiError.notFound('Maintenance task not found');

  const { outcome, notes } = req.body;
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const completed = await tx.maintenance.update({
      where: { id: item.id },
      data: {
        status: 'COMPLETED', completedDate: now,
        logs: { create: { performedBy: req.user.id, outcome: outcome || 'Completed', notes } },
      },
      include,
    });

    // For recurring tasks, schedule the next occurrence automatically.
    let nextTask = null;
    if (item.frequency && item.frequency !== 'ONE_TIME') {
      const base = item.nextDueDate || addInterval(item.scheduledDate, item.frequency);
      const following = addInterval(base, item.frequency);
      nextTask = await tx.maintenance.create({
        data: {
          title: item.title, description: item.description, assetId: item.assetId, assigneeId: item.assigneeId,
          frequency: item.frequency, scheduledDate: base, nextDueDate: following, status: 'SCHEDULED',
        },
        include,
      });
    }
    return { completed, nextTask };
  });

  await logActivity({ userId: req.user.id, action: 'COMPLETE', entity: 'Maintenance', entityId: item.id });
  res.json({ success: true, data: result });
});

// PATCH /api/maintenance/:id — update fields
export const updateMaintenance = asyncHandler(async (req, res) => {
  const data = { ...req.body };
  if (data.scheduledDate) data.scheduledDate = new Date(data.scheduledDate);
  const item = await prisma.maintenance.update({ where: { id: req.params.id }, data, include });
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'Maintenance', entityId: item.id });
  res.json({ success: true, data: item });
});

// DELETE /api/maintenance/:id
export const deleteMaintenance = asyncHandler(async (req, res) => {
  const existing = await prisma.maintenance.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Maintenance task not found');
  await prisma.maintenanceLog.deleteMany({ where: { maintenanceId: req.params.id } });
  await prisma.maintenance.delete({ where: { id: req.params.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'Maintenance', entityId: req.params.id, metadata: { title: existing.title } });
  res.json({ success: true, message: 'Maintenance task deleted' });
});

// POST /api/maintenance/run-check — flag overdue + send reminders on demand
export const triggerMaintenanceCheck = asyncHandler(async (_req, res) => {
  const result = await runMaintenanceCheck();
  res.json({ success: true, data: result });
});
