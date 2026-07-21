import multer from 'multer';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { storeFile, deleteFile, keyFromUrl } from '../services/storage.service.js';

export const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file.originalname)) cb(null, true);
    else cb(new ApiError(400, 'Logo must be PNG, JPG, GIF, WEBP, or SVG'));
  },
});

// POST /api/companies/:id/logo — upload/replace the company logo (field: "logo")
export const setCompanyLogo = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No logo uploaded');
  const existing = await prisma.company.findUnique({ where: { id: req.params.id }, select: { logoUrl: true, logoKey: true } });
  if (!existing) throw ApiError.notFound('Company not found');

  const { url, key } = await storeFile({
    mediaType: 'company-logo', buffer: req.file.buffer,
    originalName: req.file.originalname, mimeType: req.file.mimetype,
  });
  const company = await prisma.company.update({ where: { id: req.params.id }, data: { logoUrl: url, logoKey: key } });
  if (existing.logoUrl) await deleteFile(existing.logoKey || keyFromUrl(existing.logoUrl));
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'Company', entityId: company.id, metadata: { logo: true } });
  res.status(201).json({ success: true, data: company });
});

// GET /api/companies — any authenticated user (needed to populate dropdowns).
export const listCompanies = asyncHandler(async (_req, res) => {
  const companies = await prisma.company.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { users: true, assets: true } } },
  });
  res.json({ success: true, data: companies });
});

// POST /api/companies — ICT_ADMIN+
export const createCompany = asyncHandler(async (req, res) => {
  const { name, shortName, code } = req.body;
  const exists = await prisma.company.findFirst({ where: { name: name.trim() } });
  if (exists) throw ApiError.conflict('A company with that name already exists');

  const company = await prisma.company.create({
    data: { name: name.trim(), shortName: shortName?.trim() || null, code: code?.trim() || null },
  });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'Company', entityId: company.id, metadata: { name: company.name } });
  res.status(201).json({ success: true, data: company });
});

// PATCH /api/companies/:id — ICT_ADMIN+
export const updateCompany = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!company) throw ApiError.notFound('Company not found');

  const data = {};
  if (req.body.name !== undefined) {
    const clash = await prisma.company.findFirst({ where: { name: req.body.name.trim(), NOT: { id: company.id } } });
    if (clash) throw ApiError.conflict('Another company already uses that name');
    data.name = req.body.name.trim();
  }
  if (req.body.shortName !== undefined) data.shortName = req.body.shortName?.trim() || null;
  if (req.body.code !== undefined) data.code = req.body.code?.trim() || null;

  const updated = await prisma.company.update({ where: { id: company.id }, data });
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'Company', entityId: company.id });
  res.json({ success: true, data: updated });
});

// DELETE /api/companies/:id — ICT_ADMIN+ (only if nothing is linked)
export const deleteCompany = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { users: true, assets: true } } },
  });
  if (!company) throw ApiError.notFound('Company not found');
  if (company._count.users > 0 || company._count.assets > 0) {
    throw ApiError.badRequest('Cannot delete a company that still has users or assets assigned to it');
  }
  await prisma.company.delete({ where: { id: company.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'Company', entityId: company.id, metadata: { name: company.name } });
  res.json({ success: true, message: 'Company deleted' });
});
