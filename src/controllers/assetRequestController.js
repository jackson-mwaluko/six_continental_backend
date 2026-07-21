import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { notify } from '../services/notification.service.js';
import { ROLE_RANK } from '../middleware/rbac.js';

const requestInclude = {
  asset: { select: { id: true, serialNumber: true, name: true, type: true, status: true } },
  requester: { select: { id: true, firstName: true, lastName: true, email: true } },
  reviewer: { select: { id: true, firstName: true, lastName: true } },
};

async function ictRecipients() {
  return prisma.user.findMany({
    where: { isActive: true, role: { in: ['SUPER_ADMIN', 'ICT_ADMIN', 'ICT_TECHNICIAN'] } },
    select: { id: true },
  });
}

// GET /api/asset-requests — own requests for employees, all (filterable) for ICT staff
export const listRequests = asyncHandler(async (req, res) => {
  const isStaff = ROLE_RANK[req.user.role] >= ROLE_RANK.ICT_TECHNICIAN;
  const { status, scope } = req.query;

  const where = {
    ...(status && { status }),
    // Employees only ever see their own; staff see all unless they ask for "mine".
    ...((!isStaff || scope === 'mine') && { requesterId: req.user.id }),
  };

  const requests = await prisma.assetRequest.findMany({
    where, include: requestInclude, orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: requests });
});

// POST /api/asset-requests — request a specific free asset
export const createRequest = asyncHandler(async (req, res) => {
  const { assetId, reason } = req.body;
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) throw ApiError.notFound('Asset not found');
  if (asset.status !== 'IN_STOCK') throw ApiError.conflict('That asset is no longer available to request');

  const dup = await prisma.assetRequest.findFirst({
    where: { assetId, requesterId: req.user.id, status: 'PENDING' },
  });
  if (dup) throw ApiError.conflict('You already have a pending request for this asset');

  const request = await prisma.assetRequest.create({
    data: { assetId, requesterId: req.user.id, reason: reason || null },
    include: requestInclude,
  });

  // Notify ICT staff that an approval is waiting.
  const staff = await ictRecipients();
  await Promise.all(staff.map((s) => notify({
    userId: s.id, type: 'ASSET',
    title: 'New asset request',
    message: `${request.requester.firstName} ${request.requester.lastName} requested ${asset.name} (${asset.serialNumber}).`,
    link: '/requests', email: false,
  })));

  await logActivity({ userId: req.user.id, action: 'REQUEST', entity: 'AssetRequest', entityId: request.id, metadata: { assetId } });
  res.status(201).json({ success: true, data: request });
});

// POST /api/asset-requests/:id/approve — approve and assign the asset to the requester
export const approveRequest = asyncHandler(async (req, res) => {
  const { comment } = req.body;
  const request = await prisma.assetRequest.findUnique({ where: { id: req.params.id }, include: { asset: true } });
  if (!request) throw ApiError.notFound('Request not found');
  if (request.status !== 'PENDING') throw ApiError.badRequest('This request has already been decided');
  if (!request.asset || request.asset.status !== 'IN_STOCK') {
    throw ApiError.conflict('The requested asset is no longer available — reject this request instead');
  }

  const count = await prisma.handover.count();
  const documentNo = `HND-${String(count + 1).padStart(5, '0')}`;

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.assetRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED', reviewerId: req.user.id, reviewComment: comment || null, decidedAt: new Date() },
      include: requestInclude,
    });
    const assignment = await tx.assetAssignment.create({
      data: {
        assetId: request.assetId, employeeId: request.requesterId, issuedById: req.user.id,
        conditionOut: 'Issued via approved request', handover: { create: { documentNo } },
      },
    });
    await tx.asset.update({ where: { id: request.assetId }, data: { status: 'ASSIGNED' } });
    await tx.assetHistory.create({
      data: { assetId: request.assetId, action: 'ASSIGNED', details: `Assigned via request (doc ${documentNo})`, performedBy: req.user.id },
    });
    return { request: updated, assignmentId: assignment.id };
  });

  await notify({
    userId: request.requesterId, type: 'ASSET',
    title: 'Asset request approved',
    message: `Your request for ${request.asset.name} (${request.asset.serialNumber}) was approved${comment ? `: "${comment}"` : '.'}`,
    link: '/requests', email: true,
  });
  await logActivity({ userId: req.user.id, action: 'APPROVE', entity: 'AssetRequest', entityId: request.id });
  res.json({ success: true, data: result.request });
});

// POST /api/asset-requests/:id/reject — reject with a required comment
export const rejectRequest = asyncHandler(async (req, res) => {
  const { comment } = req.body;
  if (!comment || !comment.trim()) throw ApiError.badRequest('Please include a reason when rejecting');

  const request = await prisma.assetRequest.findUnique({ where: { id: req.params.id }, include: { asset: true } });
  if (!request) throw ApiError.notFound('Request not found');
  if (request.status !== 'PENDING') throw ApiError.badRequest('This request has already been decided');

  const updated = await prisma.assetRequest.update({
    where: { id: request.id },
    data: { status: 'REJECTED', reviewerId: req.user.id, reviewComment: comment.trim(), decidedAt: new Date() },
    include: requestInclude,
  });

  await notify({
    userId: request.requesterId, type: 'ASSET',
    title: 'Asset request declined',
    message: `Your request for ${request.asset?.name || 'an asset'} was declined: "${comment.trim()}"`,
    link: '/requests', email: true,
  });
  await logActivity({ userId: req.user.id, action: 'REJECT', entity: 'AssetRequest', entityId: request.id });
  res.json({ success: true, data: updated });
});

// POST /api/asset-requests/:id/cancel — requester cancels their own pending request
export const cancelRequest = asyncHandler(async (req, res) => {
  const request = await prisma.assetRequest.findUnique({ where: { id: req.params.id } });
  if (!request) throw ApiError.notFound('Request not found');
  if (request.requesterId !== req.user.id) throw ApiError.forbidden('You can only cancel your own requests');
  if (request.status !== 'PENDING') throw ApiError.badRequest('Only pending requests can be cancelled');

  const updated = await prisma.assetRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' }, include: requestInclude });
  res.json({ success: true, data: updated });
});
