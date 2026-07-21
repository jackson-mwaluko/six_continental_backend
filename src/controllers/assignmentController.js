import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { notify } from '../services/notification.service.js';
import { ROLE_RANK } from '../middleware/rbac.js';
import { getMaxAssignments } from './settingsController.js';

const detailInclude = {
  asset: { select: { id: true, serialNumber: true, name: true, type: true, model: true } },
  employee: { select: { id: true, firstName: true, lastName: true } },
  issuedBy: { select: { id: true, firstName: true, lastName: true } },
  handover: { include: { attachments: true } },
};

// GET /api/assignments/:id — staff can view any; the assigned employee can view their own.
// GET /api/assignments/assignable-users — users with their active-assignment
// count and the capacity, so the assign dialog can show occupancy (e.g. 3/5).
export const assignableUsers = asyncHandler(async (_req, res) => {
  const max = await getMaxAssignments();
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: {
      id: true, firstName: true, lastName: true, email: true, role: true,
      jobTitle: true, avatarUrl: true,
      department: { select: { name: true } },
      _count: { select: { assignmentsReceived: { where: { status: "ACTIVE" } } } },
    },
    orderBy: [{ firstName: 'asc' }],
  });
  const data = users.map((u) => {
    const count = u._count.assignmentsReceived;
    return {
      id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email,
      role: u.role, jobTitle: u.jobTitle, avatarUrl: u.avatarUrl,
      department: u.department, activeCount: count, maxCount: max, isFull: count >= max,
    };
  });
  res.json({ success: true, data, meta: { maxPerUser: max } });
});

export const getAssignment = asyncHandler(async (req, res) => {
  const assignment = await prisma.assetAssignment.findUnique({ where: { id: req.params.id }, include: detailInclude });
  if (!assignment) throw ApiError.notFound('Assignment not found');

  const isStaff = ROLE_RANK[req.user.role] >= ROLE_RANK.ICT_TECHNICIAN;
  if (!isStaff && assignment.employeeId !== req.user.id) throw ApiError.notFound('Assignment not found');

  res.json({ success: true, data: assignment });
});

// POST /api/assignments  — assign an asset to an employee (+ handover record)
export const assignAsset = asyncHandler(async (req, res) => {
  const { assetId, employeeId, conditionOut, notes, assignedAt, overrideCapacity } = req.body;

  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) throw ApiError.notFound('Asset not found');
  if (asset.status === 'ASSIGNED') throw ApiError.conflict('Asset is already assigned');

  // Capacity guard: block assigning to someone already at the max, unless a
  // super admin explicitly overrides (checkbox in the dialog).
  const max = await getMaxAssignments();
  const activeCount = await prisma.assetAssignment.count({ where: { employeeId, status: 'ACTIVE' } });
  if (activeCount >= max) {
    const canOverride = req.user.role === 'SUPER_ADMIN' && overrideCapacity;
    if (!canOverride) {
      throw ApiError.badRequest(`This person already holds ${activeCount} of ${max} allowed assets (full). A Super Admin can override the limit.`);
    }
  }

  const count = await prisma.handover.count();
  const documentNo = `HND-${String(count + 1).padStart(5, '0')}`;

  const assignment = await prisma.$transaction(async (tx) => {
    const a = await tx.assetAssignment.create({
      data: {
        assetId, employeeId, issuedById: req.user.id, conditionOut, notes,
        ...(assignedAt && { assignedAt: new Date(assignedAt) }),
        handover: { create: { documentNo } },
      },
      include: { employee: { select: { id: true, firstName: true, lastName: true } }, asset: true, handover: true },
    });
    await tx.asset.update({ where: { id: assetId }, data: { status: 'ASSIGNED' } });
    await tx.assetHistory.create({
      data: { assetId, action: 'ASSIGNED', details: `Assigned (doc ${documentNo})`, performedBy: req.user.id },
    });
    return a;
  });

  await notify({
    userId: employeeId, type: 'ASSET',
    title: `Asset assigned: ${asset.name}`,
    message: `${asset.name} (${asset.serialNumber}) has been assigned to you. Handover ${assignment.handover.documentNo}.`,
    link: `/assignments/${assignment.id}`, email: true,
  });

  await logActivity({ userId: req.user.id, action: 'ASSIGN', entity: 'AssetAssignment', entityId: assignment.id });
  res.status(201).json({ success: true, data: assignment });
});

// POST /api/assignments/:id/return
export const returnAsset = asyncHandler(async (req, res) => {
  const { conditionIn, notes } = req.body;
  const assignment = await prisma.assetAssignment.findUnique({ where: { id: req.params.id } });
  if (!assignment) throw ApiError.notFound('Assignment not found');
  if (assignment.status !== 'ACTIVE') throw ApiError.badRequest('Assignment is not active');

  const updated = await prisma.$transaction(async (tx) => {
    const a = await tx.assetAssignment.update({
      where: { id: req.params.id },
      data: { status: 'RETURNED', returnedAt: new Date(), conditionIn, notes },
    });
    await tx.asset.update({ where: { id: assignment.assetId }, data: { status: 'IN_STOCK' } });
    await tx.assetHistory.create({
      data: { assetId: assignment.assetId, action: 'RETURNED', details: conditionIn || 'Returned', performedBy: req.user.id },
    });
    return a;
  });

  await logActivity({ userId: req.user.id, action: 'RETURN', entity: 'AssetAssignment', entityId: updated.id });
  res.json({ success: true, data: updated });
});

// POST /api/assignments/:id/transfer  — return current + reassign to a new employee
export const transferAsset = asyncHandler(async (req, res) => {
  const { newEmployeeId, conditionIn, notes } = req.body;
  const current = await prisma.assetAssignment.findUnique({ where: { id: req.params.id } });
  if (!current) throw ApiError.notFound('Assignment not found');
  if (current.status !== 'ACTIVE') throw ApiError.badRequest('Assignment is not active');

  const count = await prisma.handover.count();
  const documentNo = `HND-${String(count + 1).padStart(5, '0')}`;

  const result = await prisma.$transaction(async (tx) => {
    await tx.assetAssignment.update({
      where: { id: req.params.id },
      data: { status: 'TRANSFERRED', returnedAt: new Date(), conditionIn },
    });
    const a = await tx.assetAssignment.create({
      data: {
        assetId: current.assetId, employeeId: newEmployeeId, issuedById: req.user.id, notes,
        handover: { create: { documentNo } },
      },
      include: { employee: { select: { id: true, firstName: true, lastName: true } }, handover: true },
    });
    await tx.assetHistory.create({
      data: { assetId: current.assetId, action: 'TRANSFERRED', details: `Transferred (doc ${documentNo})`, performedBy: req.user.id },
    });
    return a;
  });

  await logActivity({ userId: req.user.id, action: 'TRANSFER', entity: 'AssetAssignment', entityId: result.id });
  res.json({ success: true, data: result });
});

// GET /api/assignments
export const listAssignments = asyncHandler(async (req, res) => {
  const { status, employeeId, assetId } = req.query;
  const items = await prisma.assetAssignment.findMany({
    where: { ...(status && { status }), ...(employeeId && { employeeId }), ...(assetId && { assetId }) },
    include: {
      asset: { select: { id: true, serialNumber: true, name: true, type: true } },
      employee: { select: { id: true, firstName: true, lastName: true } },
      issuedBy: { select: { id: true, firstName: true, lastName: true } },
      handover: true,
    },
    orderBy: { assignedAt: 'desc' },
  });
  res.json({ success: true, data: items });
});
