import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { notify } from '../services/notification.service.js';

// Shapes an asset into a PUBLIC-SAFE payload. This endpoint has no auth, so it
// deliberately omits sensitive figures (purchase cost, vendor). Contact details
// of the custodian are included but the FRONTEND only reveals them to signed-in
// viewers — anonymous scanners see name + role only.
function publicShape(asset) {
  const current = asset.assignments && asset.assignments[0];
  const emp = current?.employee;
  return {
    id: asset.id,
    code: asset.serialNumber,
    name: asset.name,
    type: asset.type,
    status: asset.status,
    model: asset.model,
    manufacturer: asset.manufacturer,
    location: asset.location,
    imageUrl: asset.imageUrl || null,
    condition: current?.conditionOut || null,
    inServiceSince: asset.purchaseDate || asset.warrantyStart || null,
    warrantyStart: asset.warrantyStart,
    warrantyEnd: asset.warrantyEnd,
    company: asset.company ? { name: asset.company.name, shortName: asset.company.shortName || asset.company.name, logoUrl: asset.company.logoUrl || null } : null,
    category: asset.category ? { name: asset.category.name, icon: asset.category.icon } : null,
    assignedTo: emp
      ? {
          name: `${emp.firstName} ${emp.lastName}`.trim(),
          role: emp.jobTitle || null,
          department: emp.department?.name || null,
          email: emp.email || null,
          phone: emp.phone || null,
          avatarUrl: emp.avatarUrl || null,
          since: current.assignedAt,
          handoverNo: current.handover?.documentNo || null,
        }
      : null,
    history: (asset.history || []).map((h) => ({ action: h.action, details: h.details, at: h.createdAt })),
  };
}

const lookupInclude = {
  company: { select: { name: true, shortName: true, logoUrl: true } },
  category: { select: { name: true, icon: true } },
  history: { orderBy: { createdAt: 'desc' }, take: 8 },
  assignments: {
    where: { returnedAt: null },
    include: {
      employee: { select: { firstName: true, lastName: true, jobTitle: true, email: true, phone: true, avatarUrl: true, department: { select: { name: true } } } },
      handover: { select: { documentNo: true } },
    },
    orderBy: { assignedAt: 'desc' },
    take: 1,
  },
};

// Resolve an asset by its code (serialNumber) OR its id — tolerant of case and
// surrounding whitespace so any asset's QR/link resolves, whatever its serial
// format. This is why the public page now works for every asset, not just seeds.
async function resolveAsset(raw) {
  const key = String(raw || '').trim();
  if (!key) return null;

  // 1) exact serial match (fast path, uses the unique index)
  let asset = await prisma.asset.findUnique({ where: { serialNumber: key }, include: lookupInclude });
  if (asset) return asset;

  // 2) treat it as an id
  asset = await prisma.asset.findUnique({ where: { id: key }, include: lookupInclude });
  if (asset) return asset;

  // 3) case-insensitive serial match (last resort)
  asset = await prisma.asset.findFirst({
    where: { serialNumber: { equals: key, mode: 'insensitive' } },
    include: lookupInclude,
  });
  return asset;
}

// GET /api/public/assets/:code — no auth. Works for ANY asset.
export const getPublicAsset = asyncHandler(async (req, res) => {
  const asset = await resolveAsset(req.params.code);
  if (!asset) throw ApiError.notFound('No asset found for that code');
  res.json({ success: true, data: publicShape(asset) });
});

// POST /api/public/assets/:code/report — no auth. Public issue report → ticket.
export const reportPublicIssue = asyncHandler(async (req, res) => {
  const { description, reporterName, reporterContact, priority } = req.body;

  const found = await resolveAsset(req.params.code);
  if (!found) throw ApiError.notFound('No asset found for that code');
  const asset = { id: found.id, name: found.name, serialNumber: found.serialNumber };

  const count = await prisma.ticket.count();
  const ticketNo = `TKT-${String(count + 1).padStart(5, '0')}`;
  const who = reporterName ? `${reporterName}${reporterContact ? ` (${reporterContact})` : ''}` : 'an anonymous QR scan';

  const owner = await prisma.user.findFirst({
    where: { role: { in: ['ICT_ADMIN', 'SUPER_ADMIN'] }, isActive: true },
    orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  if (!owner) throw ApiError.badRequest('No ICT administrator is available to receive this report');

  const ticket = await prisma.ticket.create({
    data: {
      ticketNo,
      subject: `[QR report] ${asset.name} (${asset.serialNumber})`,
      description: `Reported via public QR scan by ${who}:\n\n${(description || '').trim() || 'No description provided.'}`,
      category: 'COMPUTER',
      priority: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(priority) ? priority : 'MEDIUM',
      status: 'OPEN', requesterId: owner.id, assetId: asset.id,
    },
  });

  await logActivity({ userId: owner.id, action: 'CREATE', entity: 'Ticket', entityId: ticket.id, metadata: { source: 'public-qr', asset: asset.serialNumber } });

  const staff = await prisma.user.findMany({
    where: { role: { in: ['ICT_TECHNICIAN', 'ICT_ADMIN', 'SUPER_ADMIN'] }, isActive: true },
    select: { id: true },
  });
  await Promise.all(staff.map((s) =>
    notify({
      userId: s.id, type: 'TICKET',
      title: 'Public QR issue report',
      message: `${asset.name} (${asset.serialNumber}) was reported via a public QR scan.`,
      link: `/tickets/${ticket.id}`, email: false,
    })
  ));

  res.status(201).json({ success: true, data: { ticketNo: ticket.ticketNo }, message: 'Your report has been sent to ICT.' });
});
