import ExcelJS from 'exceljs';
import prisma from '../config/prisma.js';

/*
 * Branded list-export helper. Produces a nicely formatted single-sheet workbook
 * from an array of columns + rows, with the company name in a title band, a
 * styled header row, zebra striping, auto-fit-ish widths, and a frozen header.
 */
export async function buildListWorkbook({ title, columns, rows, companyName }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = companyName || 'IOMS';
  wb.created = new Date();

  const ws = wb.addWorksheet(title.slice(0, 28) || 'Export', {
    views: [{ state: 'frozen', ySplit: 3 }],
    properties: { defaultRowHeight: 18 },
  });

  const lastCol = String.fromCharCode(64 + columns.length);

  // Title band
  ws.mergeCells(`A1:${lastCol}1`);
  const t = ws.getCell('A1');
  t.value = `${companyName || 'IOMS'} — ${title}`;
  t.font = { bold: true, size: 15, color: { argb: 'FF4F46E5' } };
  ws.getRow(1).height = 24;

  ws.mergeCells(`A2:${lastCol}2`);
  const sub = ws.getCell('A2');
  sub.value = `Exported ${new Date().toLocaleString()}  ·  ${rows.length} record${rows.length === 1 ? '' : 's'}`;
  sub.font = { italic: true, size: 10, color: { argb: 'FF64748B' } };

  // Header row (row 3)
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width || 20 }));
  const headerRow = ws.getRow(3);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });
  headerRow.height = 22;

  // Data rows
  rows.forEach((r, idx) => {
    const row = ws.addRow(columns.map((c) => r[c.key] ?? ''));
    if (idx % 2 === 0) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FD' } }; });
    row.alignment = { vertical: 'middle' };
  });

  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } };
  return wb;
}

export async function firstCompanyName() {
  const c = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { name: true } });
  return c?.name || 'IOMS';
}

// Small helper for controllers to stream a workbook as a download.
export async function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}
