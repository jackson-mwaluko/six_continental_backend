import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import { companyScopeWhere } from '../utils/companyScope.js';

const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);

// Brand palette (matches the frontend theme)
const BRAND = { primary: '#4f46e5', primaryLight: '#818cf8', ink: '#0f1729', muted: '#5b6478', faint: '#9aa6c0', line: '#e6e8f0', accent: '#f472b6' };

// Gathers the figures used by both the JSON summary and the exports.
async function gatherReport(user) {
  const monthStart = startOfMonth();
  const scope = user ? await companyScopeWhere(user, 'companyId') : {};
  const [
    ticketsByStatus, ticketsByPriority, ticketsByCategory, assetsByType, assetsByCategory,
    newTicketsThisMonth, resolvedThisMonth, totalAssets, assignedAssets,
    expiringSubs, overdueMaintenance, lowStockItems, companies,
  ] = await Promise.all([
    prisma.ticket.groupBy({ by: ['status'], _count: true }),
    prisma.ticket.groupBy({ by: ['priority'], _count: true }),
    prisma.ticket.groupBy({ by: ['category'], _count: true }),
    prisma.asset.groupBy({ by: ['type'], _count: true, where: scope }),
    prisma.asset.groupBy({ by: ['categoryId'], _count: true, where: scope }),
    prisma.ticket.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.ticket.count({ where: { resolvedAt: { gte: monthStart } } }),
    prisma.asset.count({ where: scope }),
    prisma.asset.count({ where: { ...scope, status: 'ASSIGNED' } }),
    prisma.subscription.count({ where: { status: { in: ['EXPIRING_SOON', 'EXPIRED'] } } }),
    prisma.maintenance.count({ where: { status: 'OVERDUE' } }),
    prisma.inventoryItem.findMany(),
    prisma.company.findMany({ select: { id: true, name: true } }),
  ]);

  const g = (rows, key) => rows.map((r) => ({ name: r[key], value: r._count?._all ?? r._count }));
  const lowStock = lowStockItems.filter((i) => i.quantity <= i.reorderLevel);
  const catMap = Object.fromEntries((await prisma.assetCategory.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));

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
      assetsByCategory: assetsByCategory.map((r) => ({ name: catMap[r.categoryId] || 'Uncategorised', value: r._count?._all ?? r._count })),
    },
    companyCount: companies.length,
  };
}

// Fetch a branding company (the first, or a requested one) for the report header.
async function getBrandCompany(companyId) {
  if (companyId) return prisma.company.findUnique({ where: { id: companyId } });
  return prisma.company.findFirst({ orderBy: { createdAt: 'asc' } });
}

// Turn a possibly-remote logo URL into a buffer PDFKit/ExcelJS can embed.
async function fetchLogoBuffer(url) {
  if (!url) return null;
  try {
    if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    // Local path like /api/files/company-logo/xxx
    const fs = await import('fs');
    const path = await import('path');
    const m = url.match(/\/files\/([^/]+)\/([^/?#]+)/);
    if (!m) return null;
    const p = path.join(process.env.UPLOAD_DIR || 'uploads', m[1], m[2]);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch { /* ignore */ }
  return null;
}

// GET /api/reports/monthly — JSON summary for the UI
export const monthlyReport = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await gatherReport(req.user) });
});

// GET /api/reports/export.pdf — branded, downloadable PDF
export const exportPdf = asyncHandler(async (req, res) => {
  const report = await gatherReport(req.user);
  const company = await getBrandCompany(req.query.companyId);
  const logo = company ? await fetchLogoBuffer(company.logoUrl) : null;

  const doc = new PDFDocument({ margin: 0, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ioms-report-${Date.now()}.pdf"`);
  doc.pipe(res);

  const PAGE_W = doc.page.width;
  const M = 50; // content margin
  const CW = PAGE_W - M * 2;

  // ── Header band ──
  doc.rect(0, 0, PAGE_W, 120).fill(BRAND.primary);
  doc.rect(0, 116, PAGE_W, 4).fill(BRAND.accent);
  let headerTextX = M;
  if (logo) {
    try { doc.image(logo, M, 30, { fit: [58, 58] }); headerTextX = M + 74; } catch { /* skip bad image */ }
  }
  doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text(company?.name || 'Six Continental Group', headerTextX, 34, { width: CW - (headerTextX - M) });
  doc.fontSize(12).font('Helvetica').fillColor('#e0e7ff').text('ICT Operations Report', headerTextX, 64);
  doc.fontSize(9).fillColor('#c7d2fe').text(`${report.period}  ·  Generated ${new Date().toLocaleString()}`, headerTextX, 84);

  let y = 150;

  // ── Summary stat tiles ──
  doc.fillColor(BRAND.ink).fontSize(14).font('Helvetica-Bold').text('At a glance', M, y);
  y += 26;
  const s = report.summary;
  const tiles = [
    ['New tickets', s.newTicketsThisMonth, BRAND.primary],
    ['Resolved', s.resolvedThisMonth, '#10b981'],
    ['Total assets', s.totalAssets, '#3b82f6'],
    ['Assigned', s.assignedAssets, '#6366f1'],
    ['Expiring licenses', s.expiringSubs, '#f59e0b'],
    ['Overdue maint.', s.overdueMaintenance, '#ef4444'],
    ['Low stock', s.lowStock, '#f472b6'],
    ['Companies', report.companyCount, '#0ea5e9'],
  ];
  const cols = 4;
  const gap = 12;
  const tileW = (CW - gap * (cols - 1)) / cols;
  const tileH = 62;
  tiles.forEach((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const tx = M + col * (tileW + gap);
    const ty = y + row * (tileH + gap);
    doc.roundedRect(tx, ty, tileW, tileH, 8).fillAndStroke('#f8f9fd', BRAND.line);
    doc.rect(tx, ty, 4, tileH).fill(t[2]);
    doc.fillColor(BRAND.ink).fontSize(20).font('Helvetica-Bold').text(String(t[1]), tx + 12, ty + 12);
    doc.fillColor(BRAND.muted).fontSize(8.5).font('Helvetica').text(t[0].toUpperCase(), tx + 12, ty + 40, { width: tileW - 16 });
  });
  y += Math.ceil(tiles.length / cols) * (tileH + gap) + 14;

  // ── Breakdown tables ──
  const table = (title, rows) => {
    if (y > 720) { doc.addPage(); y = 50; }
    doc.fillColor(BRAND.ink).fontSize(13).font('Helvetica-Bold').text(title, M, y);
    y += 22;
    const total = rows.reduce((a, r) => a + (r.value || 0), 0) || 1;
    if (!rows.length) { doc.fillColor(BRAND.faint).fontSize(10).font('Helvetica').text('No data', M, y); y += 20; return; }
    rows.forEach((r, idx) => {
      if (y > 780) { doc.addPage(); y = 50; }
      const rowY = y + idx * 22;
      if (idx % 2 === 0) doc.rect(M, rowY - 3, CW, 22).fill('#f8f9fd');
      const name = String(r.name).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      doc.fillColor(BRAND.ink).fontSize(10).font('Helvetica').text(name, M + 8, rowY);
      // mini bar
      const barMax = 160;
      const barW = Math.max(2, (r.value / total) * barMax);
      doc.roundedRect(M + CW - barMax - 50, rowY + 2, barMax, 8, 4).fill('#eceef4');
      doc.roundedRect(M + CW - barMax - 50, rowY + 2, barW, 8, 4).fill(BRAND.primaryLight);
      doc.fillColor(BRAND.ink).fontSize(10).font('Helvetica-Bold').text(String(r.value), M + CW - 40, rowY, { width: 40, align: 'right' });
    });
    y += rows.length * 22 + 18;
  };
  table('Tickets by Status', report.breakdowns.ticketsByStatus);
  table('Tickets by Priority', report.breakdowns.ticketsByPriority);
  table('Tickets by Category', report.breakdowns.ticketsByCategory);
  table('Assets by Type', report.breakdowns.assetsByType);
  table('Assets by Category', report.breakdowns.assetsByCategory);

  // ── Footer on every page ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    doc.fillColor(BRAND.faint).fontSize(8).font('Helvetica')
      .text(`${company?.name || 'IOMS'}  ·  Confidential  ·  Page ${i + 1} of ${range.count}`, M, 812, { width: CW, align: 'center' });
  }

  doc.end();
});

// GET /api/reports/export.xlsx — branded, downloadable Excel workbook
export const exportExcel = asyncHandler(async (req, res) => {
  const report = await gatherReport(req.user);
  const company = await getBrandCompany(req.query.companyId);
  const wb = new ExcelJS.Workbook();
  wb.creator = company?.name || 'IOMS';
  wb.created = new Date();

  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  const TITLE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0FB' } };
  const styleHeaderRow = (row) => {
    row.eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    });
    row.height = 22;
  };

  // ── Summary sheet ──
  const summary = wb.addWorksheet('Summary', { properties: { defaultRowHeight: 18 } });
  summary.mergeCells('A1:B1');
  const titleCell = summary.getCell('A1');
  titleCell.value = `${company?.name || 'IOMS'} — ICT Operations Report`;
  titleCell.font = { bold: true, size: 16, color: { argb: 'FF4F46E5' } };
  summary.getRow(1).height = 26;
  summary.mergeCells('A2:B2');
  summary.getCell('A2').value = `${report.period}  ·  Generated ${new Date().toLocaleString()}`;
  summary.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
  summary.addRow([]);

  summary.columns = [{ key: 'metric', width: 34 }, { key: 'value', width: 18 }];
  const hRow = summary.addRow(['Metric', 'Value']);
  styleHeaderRow(hRow);
  const s = report.summary;
  const summaryRows = [
    ['New tickets this month', s.newTicketsThisMonth],
    ['Resolved this month', s.resolvedThisMonth],
    ['Total assets', s.totalAssets],
    ['Assigned assets', s.assignedAssets],
    ['Expiring/expired licenses', s.expiringSubs],
    ['Overdue maintenance', s.overdueMaintenance],
    ['Low-stock items', s.lowStock],
  ];
  summaryRows.forEach((r, i) => {
    const row = summary.addRow(r);
    if (i % 2 === 0) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FD' } }; });
    row.getCell(2).font = { bold: true };
  });

  const addBreakdown = (name, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [{ header: 'Category', key: 'name', width: 30 }, { header: 'Count', key: 'value', width: 14 }];
    styleHeaderRow(ws.getRow(1));
    rows.forEach((r, i) => {
      const row = ws.addRow({ name: String(r.name).replace(/_/g, ' '), value: r.value });
      if (i % 2 === 0) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FD' } }; });
    });
    // total row
    const totalRow = ws.addRow({ name: 'Total', value: rows.reduce((a, r) => a + (r.value || 0), 0) });
    totalRow.eachCell((c) => { c.font = { bold: true }; c.fill = TITLE_FILL; });
  };
  addBreakdown('Tickets by Status', report.breakdowns.ticketsByStatus);
  addBreakdown('Tickets by Priority', report.breakdowns.ticketsByPriority);
  addBreakdown('Tickets by Category', report.breakdowns.ticketsByCategory);
  addBreakdown('Assets by Type', report.breakdowns.assetsByType);
  addBreakdown('Assets by Category', report.breakdowns.assetsByCategory);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ioms-report-${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
