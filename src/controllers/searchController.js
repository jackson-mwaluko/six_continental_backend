import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ROLE_RANK } from '../middleware/rbac.js';

const LIMIT = 5;

// GET /api/search?q=... — a single box, scoped to exactly what the viewer is
// otherwise allowed to see (mirrors the visibility rules used across the app).
export const globalSearch = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ success: true, data: {} });

  const isStaff = ROLE_RANK[req.user.role] >= ROLE_RANK.ICT_TECHNICIAN;
  const like = (field) => ({ [field]: { contains: q, mode: 'insensitive' } });

  const tasks = [];

  // Tickets — non-staff only ever see their own, matching the tickets list page.
  tasks.push(
    prisma.ticket.findMany({
      where: {
        ...(isStaff ? {} : { requesterId: req.user.id }),
        OR: [like('subject'), like('ticketNo')],
      },
      select: { id: true, ticketNo: true, subject: true, status: true, priority: true },
      orderBy: { createdAt: 'desc' }, take: LIMIT,
    }).then((rows) => ({ key: 'tickets', rows }))
  );

  // Assets — non-staff only ever see free (in-stock) devices, matching the Assets page.
  tasks.push(
    prisma.asset.findMany({
      where: {
        ...(isStaff ? {} : { status: 'IN_STOCK' }),
        OR: [like('name'), like('serialNumber'), like('model'), like('manufacturer')],
      },
      select: { id: true, serialNumber: true, name: true, type: true, status: true },
      orderBy: { createdAt: 'desc' }, take: LIMIT,
    }).then((rows) => ({ key: 'assets', rows }))
  );

  // Knowledge base — open to everyone, published articles only.
  tasks.push(
    prisma.knowledgeArticle.findMany({
      where: { isPublished: true, OR: [like('title'), like('category')] },
      select: { id: true, title: true, category: true },
      orderBy: { views: 'desc' }, take: LIMIT,
    }).then((rows) => ({ key: 'knowledge', rows }))
  );

  // Staff-only categories: internal operations, not relevant (or visible) to employees.
  if (isStaff) {
    tasks.push(
      prisma.project.findMany({
        where: { OR: [like('name'), like('code')] },
        select: { id: true, name: true, code: true, status: true },
        orderBy: { createdAt: 'desc' }, take: LIMIT,
      }).then((rows) => ({ key: 'projects', rows }))
    );
    tasks.push(
      prisma.document.findMany({
        where: { OR: [like('title'), like('fileName')] },
        select: { id: true, title: true, category: true },
        orderBy: { createdAt: 'desc' }, take: LIMIT,
      }).then((rows) => ({ key: 'documents', rows }))
    );
    tasks.push(
      prisma.user.findMany({
        where: { OR: [like('firstName'), like('lastName'), like('email')] },
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
        orderBy: { firstName: 'asc' }, take: LIMIT,
      }).then((rows) => ({ key: 'users', rows }))
    );
  }

  const settled = await Promise.all(tasks);
  const data = {};
  for (const { key, rows } of settled) {
    if (rows.length) data[key] = rows;
  }

  res.json({ success: true, data });
});
