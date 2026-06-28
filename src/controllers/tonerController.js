import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { runTonerCheck } from '../services/reminder.service.js';

const DAY = 24 * 60 * 60 * 1000;

// Derives live depletion fields for a toner record.
export function computeToner(t) {
  const used = Math.max(0, (t.currentPageCount ?? 0) - (t.installedAtPageCount ?? 0));
  const remaining = Math.max(0, t.expectedYield - used);
  const remainingPct = t.expectedYield > 0 ? Math.round((remaining / t.expectedYield) * 100) : 0;
  let estimatedDepletionDate = t.estimatedDepletionDate;
  if (t.avgDailyPages > 0 && remaining > 0) {
    estimatedDepletionDate = new Date(Date.now() + (remaining / t.avgDailyPages) * DAY);
  }
  const isLow = remainingPct <= (t.lowThresholdPct ?? 15);
  return { ...t, pagesUsed: used, pagesRemaining: remaining, remainingPct, estimatedDepletionDate, isLow };
}

// GET /api/printers — printers with computed toner state
export const listPrinters = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const printers = await prisma.printer.findMany({
    where: search ? { modelName: { contains: search, mode: 'insensitive' } } : undefined,
    include: { asset: { select: { id: true, serialNumber: true, name: true, location: true } }, toners: true },
    orderBy: { id: 'asc' },
  });
  const data = printers.map((p) => ({
    ...p,
    toners: p.toners.filter((t) => !t.replacedAt).map(computeToner),
  }));
  res.json({ success: true, data });
});

// GET /api/printers/:id — full detail incl. replaced toner history
export const getPrinter = asyncHandler(async (req, res) => {
  const printer = await prisma.printer.findUnique({
    where: { id: req.params.id },
    include: { asset: true, toners: { orderBy: { installedDate: 'desc' } } },
  });
  if (!printer) throw ApiError.notFound('Printer not found');
  res.json({
    success: true,
    data: {
      ...printer,
      activeToners: printer.toners.filter((t) => !t.replacedAt).map(computeToner),
      tonerHistory: printer.toners.filter((t) => t.replacedAt).map(computeToner),
    },
  });
});

// POST /api/printers/:id/toners — install a new toner
export const installToner = asyncHandler(async (req, res) => {
  const printer = await prisma.printer.findUnique({ where: { id: req.params.id } });
  if (!printer) throw ApiError.notFound('Printer not found');

  const { partNumber, color, expectedYield, installedAtPageCount, currentPageCount, avgDailyPages, lowThresholdPct } = req.body;
  const toner = await prisma.toner.create({
    data: {
      printerId: printer.id,
      partNumber,
      color: color || 'BLACK',
      expectedYield: Number(expectedYield) || 0,
      installedAtPageCount: Number(installedAtPageCount) || 0,
      currentPageCount: Number(currentPageCount ?? installedAtPageCount) || 0,
      avgDailyPages: avgDailyPages ? Number(avgDailyPages) : null,
      lowThresholdPct: lowThresholdPct ? Number(lowThresholdPct) : 15,
    },
  });
  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'Toner', entityId: toner.id });
  res.status(201).json({ success: true, data: computeToner(toner) });
});

// PATCH /api/toners/:id — update page count (and recompute depletion)
export const updateToner = asyncHandler(async (req, res) => {
  const existing = await prisma.toner.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Toner not found');

  const data = {};
  for (const k of ['currentPageCount', 'avgDailyPages', 'lowThresholdPct', 'expectedYield']) {
    if (req.body[k] !== undefined) data[k] = Number(req.body[k]);
  }
  const toner = await prisma.toner.update({ where: { id: req.params.id }, data });
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'Toner', entityId: toner.id });
  res.json({ success: true, data: computeToner(toner) });
});

// POST /api/toners/:id/replace — mark replaced, optionally install successor
export const replaceToner = asyncHandler(async (req, res) => {
  const existing = await prisma.toner.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Toner not found');

  await prisma.toner.update({ where: { id: req.params.id }, data: { replacedAt: new Date(), isDepleted: true } });

  let replacement = null;
  if (req.body.installNew) {
    replacement = await prisma.toner.create({
      data: {
        printerId: existing.printerId,
        partNumber: req.body.partNumber || existing.partNumber,
        color: existing.color,
        expectedYield: Number(req.body.expectedYield) || existing.expectedYield,
        installedAtPageCount: Number(req.body.currentPageCount) || existing.currentPageCount,
        currentPageCount: Number(req.body.currentPageCount) || existing.currentPageCount,
        avgDailyPages: existing.avgDailyPages,
        lowThresholdPct: existing.lowThresholdPct,
      },
    });
  }
  await logActivity({ userId: req.user.id, action: 'REPLACE', entity: 'Toner', entityId: req.params.id });
  res.json({ success: true, data: { replaced: req.params.id, replacement: replacement ? computeToner(replacement) : null } });
});

// POST /api/printers/run-check — recompute + fire low-toner alerts on demand
export const triggerTonerCheck = asyncHandler(async (_req, res) => {
  const result = await runTonerCheck();
  res.json({ success: true, data: result });
});
