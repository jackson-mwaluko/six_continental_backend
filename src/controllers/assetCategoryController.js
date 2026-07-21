import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';

// GET /api/asset-categories — any authenticated user (for dropdowns/filters)
export const listCategories = asyncHandler(async (_req, res) => {
  const categories = await prisma.assetCategory.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { assets: true } } },
  });
  res.json({ success: true, data: categories });
});

// POST /api/asset-categories — ICT_ADMIN+
export const createCategory = asyncHandler(async (req, res) => {
  const { name, icon } = req.body;
  const exists = await prisma.assetCategory.findFirst({ where: { name: name.trim() } });
  if (exists) throw ApiError.conflict('That category already exists');
  const category = await prisma.assetCategory.create({ data: { name: name.trim(), icon: icon?.trim() || null } });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'AssetCategory', entityId: category.id, metadata: { name: category.name } });
  res.status(201).json({ success: true, data: category });
});

// PATCH /api/asset-categories/:id — ICT_ADMIN+
export const updateCategory = asyncHandler(async (req, res) => {
  const category = await prisma.assetCategory.findUnique({ where: { id: req.params.id } });
  if (!category) throw ApiError.notFound('Category not found');
  const data = {};
  if (req.body.name !== undefined) {
    const clash = await prisma.assetCategory.findFirst({ where: { name: req.body.name.trim(), NOT: { id: category.id } } });
    if (clash) throw ApiError.conflict('Another category already uses that name');
    data.name = req.body.name.trim();
  }
  if (req.body.icon !== undefined) data.icon = req.body.icon?.trim() || null;
  const updated = await prisma.assetCategory.update({ where: { id: category.id }, data });
  res.json({ success: true, data: updated });
});

// DELETE /api/asset-categories/:id — ICT_ADMIN+ (only if unused)
export const deleteCategory = asyncHandler(async (req, res) => {
  const category = await prisma.assetCategory.findUnique({
    where: { id: req.params.id }, include: { _count: { select: { assets: true } } },
  });
  if (!category) throw ApiError.notFound('Category not found');
  if (category._count.assets > 0) throw ApiError.badRequest('Cannot delete a category that still has assets. Reassign those assets first.');
  await prisma.assetCategory.delete({ where: { id: category.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'AssetCategory', entityId: category.id, metadata: { name: category.name } });
  res.json({ success: true, message: 'Category deleted' });
});
