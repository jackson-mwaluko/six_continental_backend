import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';

const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);

// Gathers the figures used by both the JSON summary and the exports.
async function gatherReport() {
  const monthStart = startOfMonth();
  const [
    ticketsByStatus, ticketsByPriority, ticketsByCategory, assetsByType,
    newTicketsThisMonth, resolvedThisMonth, totalAssets, assignedAssets,
    expiringSubs, overdueMaintenance, lowStockItems,
  ] = await Promise.all([
    prisma.ticket.groupBy({ by: ['status'], _count: true }),
    prisma.ticket.groupBy({ by: ['priority'], _count: true }),
    prisma.ticket.groupBy({ by: ['category'], _count: true }),
    prisma.asset.groupBy({ by: ['type'], _count: true }),
    prisma.ticket.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.ticket.count({ where: { resolvedAt: { gte: monthStart } } }),
    prisma.asset.count(),
    prisma.asset.count({ where: { status: 'ASSIGNED' } }),
    prisma.subscription.count({ where: { status: { in: ['EXPIRING_SOON', 'EXPIRED'] } } }),
    prisma.maintenance.count({ where: { status: 'OVERDUE' } }),
    prisma.inventoryItem.findMany(),
  ]);

  const g = (rows, key) => rows.map((r) => ({ name: r[key], value: r._count?._all ?? r._count }));
  const lowStock = lowStockItems.filter((i) => i.quantity <= i.reorderLevel);

  return {
    period: monthStart.toLocaleString('default', { month: 'long', year: 'numeric' }),
    summary: {
      newTicketsThisMonth, resolvedThisMonth, totalAssets, assignedAssets,
      expiringSubs, overdueMaintenance, lowStock: lowStock.length,
    },
    breakdowns: {
      ticketsByStatus: g(ticketsByStatus, 'status'),
      ticketsByPriority: g(ticketsByPriority, 'priority'),
      ticketsByCategory: g(ticketsByCategory, 'category'),
      assetsByType: g(assetsByType, 'type'),
    },
  };
}

// GET /api/reports/monthly — JSON summary for the UI
export const monthlyReport = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await gatherReport() });
});

// GET /api/reports/export.pdf — downloadable PDF
export const exportPdf = asyncHandler(async (_req, res) => {
  const report = await gatherReport();
  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ioms-report-${Date.now()}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).fillColor('#4338ca').text('IOMS Operational Report', { align: 'left' });
  doc.moveDown(0.2).fontSize(11).fillColor('#475569').text(`Period: ${report.period}`);
  doc.moveDown(0.2).fontSize(9).fillColor('#94a3b8').text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#0f172a').text('Summary');
  doc.moveDown(0.5).fontSize(10).fillColor('#334155');
  const s = report.summary;
  const lines = [
    `New tickets this month: ${s.newTicketsThisMonth}`,
    `Resolved this month: ${s.resolvedThisMonth}`,
    `Total assets: ${s.totalAssets}  (assigned: ${s.assignedAssets})`,
    `Expiring/expired licenses: ${s.expiringSubs}`,
    `Overdue maintenance: ${s.overdueMaintenance}`,
    `Low-stock items: ${s.lowStock}`,
  ];
  lines.forEach((l) => doc.text(`•  ${l}`));
  doc.moveDown(1);

  const section = (title, rows) => {
    doc.fontSize(13).fillColor('#0f172a').text(title);
    doc.moveDown(0.3).fontSize(10).fillColor('#334155');
    if (!rows.length) doc.text('  (no data)');
    rows.forEach((r) => doc.text(`   ${String(r.name).replace(/_/g, ' ')}:  ${r.value}`));
    doc.moveDown(0.8);
  };
  section('Tickets by Status', report.breakdowns.ticketsByStatus);
  section('Tickets by Priority', report.breakdowns.ticketsByPriority);
  section('Tickets by Category', report.breakdowns.ticketsByCategory);
  section('Assets by Type', report.breakdowns.assetsByType);

  doc.end();
});

// GET /api/reports/export.xlsx — downloadable Excel workbook
export const exportExcel = asyncHandler(async (_req, res) => {
  const report = await gatherReport();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IOMS';

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ header: 'Metric', key: 'metric', width: 32 }, { header: 'Value', key: 'value', width: 16 }];
  summary.getRow(1).font = { bold: true };
  const s = report.summary;
  [
    ['Period', report.period],
    ['New tickets this month', s.newTicketsThisMonth],
    ['Resolved this month', s.resolvedThisMonth],
    ['Total assets', s.totalAssets],
    ['Assigned assets', s.assignedAssets],
    ['Expiring/expired licenses', s.expiringSubs],
    ['Overdue maintenance', s.overdueMaintenance],
    ['Low-stock items', s.lowStock],
  ].forEach(([metric, value]) => summary.addRow({ metric, value }));

  const addBreakdown = (name, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [{ header: 'Category', key: 'name', width: 28 }, { header: 'Count', key: 'value', width: 12 }];
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow({ name: String(r.name).replace(/_/g, ' '), value: r.value }));
  };
  addBreakdown('Tickets by Status', report.breakdowns.ticketsByStatus);
  addBreakdown('Tickets by Priority', report.breakdowns.ticketsByPriority);
  addBreakdown('Tickets by Category', report.breakdowns.ticketsByCategory);
  addBreakdown('Assets by Type', report.breakdowns.assetsByType);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ioms-report-${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
