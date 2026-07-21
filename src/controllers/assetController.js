import multer from 'multer';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { ROLE_RANK } from '../middleware/rbac.js';
import { storeFile, deleteFile, keyFromUrl } from '../services/storage.service.js';
import { companyScopeWhere } from '../utils/companyScope.js';
import { buildListWorkbook, firstCompanyName, sendWorkbook } from '../utils/exporter.js';

const assetInclude = {
  vendor: { select: { id: true, name: true } },
  company: { select: { id: true, name: true, shortName: true, logoUrl: true } },
  category: { select: { id: true, name: true, icon: true } },
  assignments: {
    where: { status: 'ACTIVE' },
    include: { employee: { select: { id: true, firstName: true, lastName: true } } },
  },
};

// In-memory upload; the storage service decides Supabase vs local disk.
export const uploadAssetImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(png|jpe?g|gif|webp)$/i.test(file.originalname)) cb(null, true);
    else cb(new ApiError(400, 'Asset image must be PNG, JPG, GIF, or WEBP'));
  },
});

// POST /api/assets/:id/image — attach/replace an asset photo (field: "image")
export const setAssetImage = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No image uploaded');
  const existing = await prisma.asset.findUnique({ where: { id: req.params.id }, select: { imageUrl: true, imageKey: true } });
  if (!existing) throw ApiError.notFound('Asset not found');

  const { url, key } = await storeFile({
    mediaType: 'asset-image', buffer: req.file.buffer,
    originalName: req.file.originalname, mimeType: req.file.mimetype,
  });

  const asset = await prisma.asset.update({ where: { id: req.params.id }, data: { imageUrl: url, imageKey: key }, include: assetInclude });
  if (existing.imageUrl) await deleteFile(existing.imageKey || keyFromUrl(existing.imageUrl));
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'Asset', entityId: asset.id, metadata: { image: true } });
  res.status(201).json({ success: true, data: asset });
});



// GET /api/assets
export const listAssets = asyncHandler(async (req, res) => {
  const { type, categoryId, status, search, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const isStaff = ROLE_RANK[req.user.role] >= ROLE_RANK.ICT_TECHNICIAN;

  // Company scope: staff only see assets belonging to companies they can access
  // (all-companies / super admin see everything). Assets with no company set are
  // visible to all-access users and to anyone (they're unscoped).
  const scope = await companyScopeWhere(req.user, 'companyId');

  const where = {
    ...scope,
    ...(type && { type }),
    ...(categoryId && { categoryId }),
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
  const b = req.body;
  const data = {};
  for (const k of EDITABLE_FIELDS) if (b[k] !== undefined && b[k] !== '') data[k] = b[k];
  data.serialNumber = String(b.serialNumber || '').trim();
  data.name = String(b.name || '').trim();
  data.type = b.type;
  data.purchaseCost = b.purchaseCost ? Number(b.purchaseCost) : null;
  for (const d of DATE_FIELDS) if (data[d]) data[d] = new Date(data[d]);
  if (data.companyId === '') data.companyId = null;
  if (data.categoryId === '') data.categoryId = null;

  const asset = await prisma.asset.create({
    data: {
      ...data,
      history: { create: { action: 'CREATED', details: `Asset ${data.serialNumber} registered`, performedBy: req.user.id } },
    },
    include: assetInclude,
  });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'Asset', entityId: asset.id, metadata: { serialNumber: asset.serialNumber, name: asset.name } });
  res.status(201).json({ success: true, data: asset });
});

// Fields an editor may change, and which ones are worth an audit-trail history entry.
const EDITABLE_FIELDS = ['serialNumber', 'name', 'type', 'status', 'model', 'manufacturer', 'specifications', 'location', 'purchaseCost', 'purchaseDate', 'warrantyStart', 'warrantyEnd', 'vendorId', 'companyId', 'categoryId'];
const TRACKED_FIELDS = ['serialNumber', 'status', 'name', 'type', 'location', 'companyId'];
const DATE_FIELDS = ['purchaseDate', 'warrantyStart', 'warrantyEnd'];

// PATCH /api/assets/:id — update any detail (incl. serial number) with a full change log.
export const updateAsset = asyncHandler(async (req, res) => {
  const existing = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Asset not found');

  const data = {};
  for (const k of EDITABLE_FIELDS) if (req.body[k] !== undefined) data[k] = req.body[k];
  if (data.purchaseCost !== undefined) data.purchaseCost = data.purchaseCost ? Number(data.purchaseCost) : null;
  for (const d of DATE_FIELDS) if (data[d] !== undefined) data[d] = data[d] ? new Date(data[d]) : null;
  if (data.companyId === '') data.companyId = null;
  if (data.categoryId === '') data.categoryId = null;
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

// GET /api/assets/export.xlsx — branded Excel of all (scoped) assets
export const exportAssets = asyncHandler(async (req, res) => {
  const scope = await companyScopeWhere(req.user, 'companyId');
  const assets = await prisma.asset.findMany({
    where: scope,
    include: assetInclude,
    orderBy: { serialNumber: 'asc' },
  });
  const rows = assets.map((a) => ({
    serialNumber: a.serialNumber,
    name: a.name,
    type: a.type,
    category: a.category?.name || '',
    status: a.status,
    model: a.model || '',
    manufacturer: a.manufacturer || '',
    location: a.location || '',
    company: a.company?.name || '',
    assignedTo: a.assignments?.[0]?.employee ? `${a.assignments[0].employee.firstName} ${a.assignments[0].employee.lastName}` : '',
    purchaseDate: a.purchaseDate ? new Date(a.purchaseDate).toLocaleDateString() : '',
    warrantyEnd: a.warrantyEnd ? new Date(a.warrantyEnd).toLocaleDateString() : '',
  }));
  const columns = [
    { header: 'Serial / Code', key: 'serialNumber', width: 20 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Category', key: 'category', width: 16 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Model', key: 'model', width: 18 },
    { header: 'Manufacturer', key: 'manufacturer', width: 18 },
    { header: 'Location', key: 'location', width: 22 },
    { header: 'Company', key: 'company', width: 22 },
    { header: 'Assigned To', key: 'assignedTo', width: 22 },
    { header: 'In Service', key: 'purchaseDate', width: 14 },
    { header: 'Warranty Ends', key: 'warrantyEnd', width: 14 },
  ];
  const wb = await buildListWorkbook({ title: 'Assets', columns, rows, companyName: await firstCompanyName() });
  await sendWorkbook(res, wb, `ioms-assets-${Date.now()}.xlsx`);
});

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
