import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { ROLE_RANK } from '../middleware/rbac.js';

const assetInclude = {
  vendor: { select: { id: true, name: true } },
  assignments: {
    where: { status: 'ACTIVE' },
    include: { employee: { select: { id: true, firstName: true, lastName: true } } },
  },
};

// GET /api/assets
export const listAssets = asyncHandler(async (req, res) => {
  const { type, status, search, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const isStaff = ROLE_RANK[req.user.role] >= ROLE_RANK.ICT_TECHNICIAN;

  const where = {
    ...(type && { type }),
    // Non-staff can only ever see free (in-stock) assets — never who has what.
    ...(isStaff ? (status && { status }) : { status: 'IN_STOCK' }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
        { manufacturer: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  // Staff see vendor + current assignee; everyone else gets a lean, anonymised list.
  const include = isStaff ? assetInclude : { vendor: { select: { id: true, name: true } } };

  const [items, total] = await Promise.all([
    prisma.asset.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip, take: Number(limit) }),
    prisma.asset.count({ where }),
  ]);

  res.json({ success: true, data: items, meta: { total, page: Number(page), limit: Number(limit) } });
});

// GET /api/assets/:id
export const getAsset = asyncHandler(async (req, res) => {
  const asset = await prisma.asset.findUnique({
    where: { id: req.params.id },
    include: {
      ...assetInclude,
      history: { orderBy: { createdAt: 'desc' }, take: 50 },
      assignments: {
        include: { employee: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { assignedAt: 'desc' },
      },
      printer: { include: { toners: true } },
    },
  });
  if (!asset) throw ApiError.notFound('Asset not found');
  res.json({ success: true, data: asset });
});

// POST /api/assets
export const createAsset = asyncHandler(async (req, res) => {
  const data = req.body;
  const asset = await prisma.asset.create({
    data: {
      ...data,
      purchaseCost: data.purchaseCost ? Number(data.purchaseCost) : null,
      history: { create: { action: 'CREATED', details: `Asset ${data.serialNumber} registered`, performedBy: req.user.id } },
    },
    include: assetInclude,
  });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'Asset', entityId: asset.id, metadata: { serialNumber: asset.serialNumber, name: asset.name } });
  res.status(201).json({ success: true, data: asset });
});

// Fields an editor may change, and which ones are worth an audit-trail history entry.
const EDITABLE_FIELDS = ['serialNumber', 'name', 'type', 'status', 'model', 'manufacturer', 'specifications', 'location', 'purchaseCost', 'warrantyStart', 'warrantyEnd', 'vendorId'];
const TRACKED_FIELDS = ['serialNumber', 'status', 'name', 'type', 'location'];

// PATCH /api/assets/:id — update any detail (incl. serial number) with a full change log.
export const updateAsset = asyncHandler(async (req, res) => {
  const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Asset not found');

  const data = {};
  for (const k of EDITABLE_FIELDS) if (req.body[k] !== undefined) data[k] = req.body[k];
  if (data.purchaseCost !== undefined) data.purchaseCost = data.purchaseCost ? Number(data.purchaseCost) : null;
  if (data.serialNumber !== undefined) {
    data.serialNumber = String(data.serialNumber).trim();
    if (!data.serialNumber) throw ApiError.badRequest('Serial number / code cannot be empty');
  }

  // Build a diff of what actually changed for the audit trail.
  const changes = {};
  const historyEntries = [];
  for (const k of Object.keys(data)) {
    const before = existing[k] == null ? null : String(existing[k]);
    const after = data[k] == null ? null : String(data[k]);
    if (before !== after) {
      changes[k] = { from: before, to: after };
      if (TRACKED_FIELDS.includes(k)) {
        historyEntries.push({
          action: k === 'status' ? 'STATUS_CHANGE' : k === 'serialNumber' ? 'SERIAL_CHANGE' : 'UPDATE',
          details: `${k}: ${before ?? '—'} → ${after ?? '—'}`,
          performedBy: req.user.id,
        });
      }
    }
  }

  // Guard the unique serial number for a friendlier error than a raw DB clash.
  if (changes.serialNumber) {
    const clash = await prisma.asset.findFirst({ where: { serialNumber: data.serialNumber, NOT: { id: existing.id } } });
    if (clash) throw ApiError.conflict('Another asset already uses that serial number / code');
  }

  const asset = await prisma.asset.update({
    where: { id: req.params.id },
    data: { ...data, ...(historyEntries.length && { history: { create: historyEntries } }) },
    include: assetInclude,
  });

  await logActivity({
    userId: req.user.id, action: 'UPDATE', entity: 'Asset', entityId: asset.id,
    metadata: { changes, serialNumber: asset.serialNumber },
  });
  res.json({ success: true, data: asset });
});

// DELETE /api/assets/:id
export const deleteAsset = asyncHandler(async (req, res) => {
  await prisma.asset.delete({ where: { id: req.params.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'Asset', entityId: req.params.id });
  res.json({ success: true, message: 'Asset deleted' });
});

const ASSET_TYPES = ['LAPTOP', 'DESKTOP', 'PRINTER', 'ROUTER', 'SWITCH', 'UPS', 'MOBILE_PHONE', 'CCTV_DEVICE', 'OTHER'];

// POST /api/assets/import — bulk-create assets from parsed CSV rows.
// Body: { rows: [{ serialNumber, name, type, status?, model?, manufacturer?, location? }] }
// Skips rows missing required fields or duplicating an existing serial number; reports a per-row summary.
export const importAssets = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw ApiError.badRequest('No rows to import');
  if (rows.length > 1000) throw ApiError.badRequest('Import is limited to 1000 rows at a time');

  const existing = new Set((await prisma.asset.findMany({ select: { serialNumber: true } })).map((a) => a.serialNumber));
  const created = [];
  const skipped = [];

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const serialNumber = (r.serialNumber || r.serial || r.code || '').trim();
    const name = (r.name || '').trim();
    const type = (r.type || '').trim().toUpperCase();

    if (!serialNumber || !name || !type) { skipped.push({ row: i + 2, reason: 'Missing serialNumber, name, or type' }); continue; }
    if (!ASSET_TYPES.includes(type)) { skipped.push({ row: i + 2, reason: `Invalid type "${type}"` }); continue; }
    if (existing.has(serialNumber)) { skipped.push({ row: i + 2, reason: `Duplicate serial number "${serialNumber}"` }); continue; }

    existing.add(serialNumber);
    created.push({
      serialNumber, name, type,
      status: (r.status || 'IN_STOCK').trim().toUpperCase(),
      model: r.model?.trim() || null,
      manufacturer: r.manufacturer?.trim() || null,
      location: r.location?.trim() || null,
    });
  }

  let inserted = 0;
  if (created.length) {
    const result = await prisma.asset.createMany({ data: created, skipDuplicates: true });
    inserted = result.count;
  }
  await logActivity({ userId: req.user.id, action: 'IMPORT', entity: 'Asset', metadata: { inserted, skipped: skipped.length } });
  res.status(201).json({ success: true, data: { inserted, skippedCount: skipped.length, skipped } });
});
