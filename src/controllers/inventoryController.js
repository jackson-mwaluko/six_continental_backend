import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { runStockCheck } from '../services/reminder.service.js';

// GET /api/inventory — items with a low-stock flag
export const listInventory = asyncHandler(async (req, res) => {
  const { search, lowOnly } = req.query;
  const items = await prisma.inventoryItem.findMany({
    where: search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }] }
      : undefined,
    orderBy: { name: 'asc' },
  });
  let data = items.map((i) => ({ ...i, isLow: i.quantity <= i.reorderLevel }));
  if (lowOnly === 'true') data = data.filter((i) => i.isLow);
  res.json({ success: true, data });
});

// GET /api/inventory/:id — item with recent movements
export const getInventoryItem = asyncHandler(async (req, res) => {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: req.params.id },
    include: { movements: { orderBy: { createdAt: 'desc' }, take: 50 } },
  });
  if (!item) throw ApiError.notFound('Item not found');
  res.json({ success: true, data: { ...item, isLow: item.quantity <= item.reorderLevel } });
});

// POST /api/inventory — create item
export const createInventoryItem = asyncHandler(async (req, res) => {
  const { sku, name, category, unit, quantity, reorderLevel, unitCost, location } = req.body;
  const item = await prisma.inventoryItem.create({
    data: {
      sku, name, category: category || 'CONSUMABLE', unit: unit || 'pcs',
      quantity: Number(quantity) || 0, reorderLevel: Number(reorderLevel) || 5,
      unitCost: unitCost ? Number(unitCost) : null, location: location || null,
    },
  });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'InventoryItem', entityId: item.id });
  res.status(201).json({ success: true, data: item });
});

// POST /api/inventory/:id/movements — record an in/out/adjustment, update quantity
export const recordMovement = asyncHandler(async (req, res) => {
  const { type, quantity, reason, reference } = req.body;
  const item = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw ApiError.notFound('Item not found');

  const qty = Number(quantity);
  if (!qty || qty <= 0) throw ApiError.badRequest('Quantity must be a positive number');

  let newQty = item.quantity;
  if (type === 'IN') newQty += qty;
  else if (type === 'OUT') newQty -= qty;
  else if (type === 'ADJUSTMENT') newQty = qty; // set absolute level
  else throw ApiError.badRequest('type must be IN, OUT, or ADJUSTMENT');

  if (newQty < 0) throw ApiError.badRequest('Insufficient stock for this movement');

  const result = await prisma.$transaction(async (tx) => {
    const movement = await tx.stockMovement.create({
      data: { itemId: item.id, type, quantity: qty, reason, reference, performedBy: req.user.id },
    });
    const updated = await tx.inventoryItem.update({ where: { id: item.id }, data: { quantity: newQty } });
    return { movement, item: { ...updated, isLow: updated.quantity <= updated.reorderLevel } };
  });

  await logActivity({ userId: req.user.id, action: type, entity: 'StockMovement', entityId: result.movement.id, metadata: { itemId: item.id, qty } });
  res.status(201).json({ success: true, data: result });
});

// PATCH /api/inventory/:id — edit item details (not quantity; use movements for that)
export const updateInventoryItem = asyncHandler(async (req, res) => {
  const existing = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Item not found');

  const data = {};
  for (const k of ['sku', 'name', 'category', 'unit', 'location']) if (req.body[k] !== undefined) data[k] = req.body[k];
  if (req.body.reorderLevel !== undefined) data.reorderLevel = Number(req.body.reorderLevel);
  if (req.body.unitCost !== undefined) data.unitCost = req.body.unitCost ? Number(req.body.unitCost) : null;

  const item = await prisma.inventoryItem.update({ where: { id: req.params.id }, data });
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'InventoryItem', entityId: item.id });
  res.json({ success: true, data: { ...item, isLow: item.quantity <= item.reorderLevel } });
});

// DELETE /api/inventory/:id
export const deleteInventoryItem = asyncHandler(async (req, res) => {
  const existing = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Item not found');
  await prisma.stockMovement.deleteMany({ where: { itemId: req.params.id } });
  await prisma.inventoryItem.delete({ where: { id: req.params.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'InventoryItem', entityId: req.params.id, metadata: { name: existing.name } });
  res.json({ success: true, message: 'Item deleted' });
});

// POST /api/inventory/run-check — fire low-stock alerts on demand
export const triggerStockCheck = asyncHandler(async (_req, res) => {
  const result = await runStockCheck();
  res.json({ success: true, data: result });
});
