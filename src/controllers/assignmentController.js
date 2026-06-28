import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { notify } from '../services/notification.service.js';

// POST /api/assignments  — assign an asset to an employee (+ handover record)
export const assignAsset = asyncHandler(async (req, res) => {
  const { assetId, employeeId, conditionOut, notes } = req.body;

  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) throw ApiError.notFound('Asset not found');
  if (asset.status === 'ASSIGNED') throw ApiError.conflict('Asset is already assigned');

  const count = await prisma.handover.count();
  const documentNo = `HND-${String(count + 1).padStart(5, '0')}`;

  const assignment = await prisma.$transaction(async (tx) => {
    const a = await tx.assetAssignment.create({
      data: {
        assetId, employeeId, issuedById: req.user.id, conditionOut, notes,
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
