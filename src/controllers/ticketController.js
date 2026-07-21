import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { applySla } from '../services/sla.service.js';
import { notify } from '../services/notification.service.js';
import { ROLE_RANK } from '../middleware/rbac.js';

const ticketInclude = {
  requester: { select: { id: true, firstName: true, lastName: true, email: true } },
  assignee: { select: { id: true, firstName: true, lastName: true, email: true } },
  asset: { select: { id: true, serialNumber: true, name: true } },
  slaPolicy: true,
  _count: { select: { comments: true, attachments: true } },
};

const genTicketNo = async () => {
  const count = await prisma.ticket.count();
  return `IOMS-${String(count + 1).padStart(6, '0')}`;
};

// GET /api/tickets  — list with filtering, search, pagination
export const listTickets = asyncHandler(async (req, res) => {
  const { status, priority, category, assigneeId, search, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    ...(status && { status }),
    ...(priority && { priority }),
    ...(category && { category }),
    ...(assigneeId && { assigneeId }),
    ...(search && {
      OR: [
        { subject: { contains: search, mode: 'insensitive' } },
        { ticketNo: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  // Employees only see their own tickets.
  // Non-staff (employees, department managers) only ever see their own tickets.
  if (ROLE_RANK[req.user.role] < ROLE_RANK.ICT_TECHNICIAN) where.requesterId = req.user.id;

  const [items, total] = await Promise.all([
    prisma.ticket.findMany({
      where, include: ticketInclude, orderBy: { createdAt: 'desc' },
      skip, take: Number(limit),
    }),
    prisma.ticket.count({ where }),
  ]);

  res.json({ success: true, data: items, meta: { total, page: Number(page), limit: Number(limit) } });
});

// GET /api/tickets/my-queue — tickets assigned to the current staff member,
// with quick counts. This powers the technician "My Queue" page.
export const myQueue = asyncHandler(async (req, res) => {
  const assigneeId = req.user.id;
  const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_USER'];

  const [open, resolvedToday, all] = await Promise.all([
    prisma.ticket.findMany({
      where: { assigneeId, status: { in: OPEN_STATUSES } },
      include: ticketInclude,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.ticket.count({
      where: { assigneeId, status: { in: ['RESOLVED', 'CLOSED'] }, updatedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
    }),
    prisma.ticket.count({ where: { assigneeId } }),
  ]);

  // Small breakdown by status for the header cards.
  const byStatus = open.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
  const overdue = open.filter((t) => t.slaBreached || (t.resolutionDueAt && new Date(t.resolutionDueAt) < new Date())).length;

  res.json({
    success: true,
    data: open,
    meta: { openCount: open.length, resolvedToday, total: all, byStatus, overdue },
  });
});

// GET /api/tickets/:id
export const getTicket = asyncHandler(async (req, res) => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: req.params.id },
    include: {
      ...ticketInclude,
      comments: { include: { author: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'asc' } },
      history: { include: { actor: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } },
      attachments: true,
    },
  });
  if (!ticket) throw ApiError.notFound('Ticket not found');
  // Non-staff may only view their own tickets.
  if (ROLE_RANK[req.user.role] < ROLE_RANK.ICT_TECHNICIAN && ticket.requesterId !== req.user.id) {
    throw ApiError.notFound('Ticket not found');
  }
  res.json({ success: true, data: ticket });
});

// POST /api/tickets
export const createTicket = asyncHandler(async (req, res) => {
  const { subject, description, category, priority, assetId } = req.body;
  const ticketNo = await genTicketNo();
  const sla = await applySla(priority || 'MEDIUM');

  const ticket = await prisma.ticket.create({
    data: {
      ticketNo, subject, description, category,
      priority: priority || 'MEDIUM',
      requesterId: req.user.id,
      assetId: assetId || null,
      ...sla,
      history: { create: { actorId: req.user.id, field: 'status', oldValue: null, newValue: 'OPEN' } },
    },
    include: ticketInclude,
  });

  await logActivity({ userId: req.user.id, action: 'CREATE', entity: 'Ticket', entityId: ticket.id });

  // Alert the ICT team so a new ticket gets picked up.
  const staff = await prisma.user.findMany({
    where: { isActive: true, role: { in: ['SUPER_ADMIN', 'ICT_ADMIN', 'ICT_TECHNICIAN'] }, NOT: { id: req.user.id } },
    select: { id: true },
  });
  await Promise.all(staff.map((s) => notify({
    userId: s.id, type: 'TICKET',
    title: `New ticket: ${ticket.ticketNo}`,
    message: `${ticket.subject} (${ticket.priority})`,
    link: `/tickets/${ticket.id}`, email: false,
  })));

  res.status(201).json({ success: true, data: ticket });
});

// PATCH /api/tickets/:id  — update fields & track history
export const updateTicket = asyncHandler(async (req, res) => {
  const existing = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Ticket not found');

  const { status, priority, assigneeId, category, subject, description } = req.body;
  const historyRows = [];
  const data = {};

  // Only ICT_ADMIN+ may unassign a ticket (clear the assignee) or reassign it
  // away from the current owner. Technicians can pick up / progress tickets but
  // not drop or hand off someone else's — this keeps accountability intact.
  const isAdmin = ROLE_RANK[req.user.role] >= ROLE_RANK.ICT_ADMIN;
  if (assigneeId !== undefined && !isAdmin) {
    const clearing = !assigneeId; // null or empty string
    const reassigningAway = existing.assigneeId && assigneeId && assigneeId !== existing.assigneeId;
    if (clearing || reassigningAway) {
      throw ApiError.forbidden('Only an ICT Admin or Super Admin can unassign or reassign a ticket.');
    }
  }

  const track = (field, oldVal, newVal) => {
    if (newVal !== undefined && String(newVal) !== String(oldVal ?? '')) {
      data[field] = newVal;
      historyRows.push({ actorId: req.user.id, field, oldValue: String(oldVal ?? ''), newValue: String(newVal) });
    }
  };

  track('status', existing.status, status);
  track('priority', existing.priority, priority);
  track('assigneeId', existing.assigneeId, assigneeId);
  track('category', existing.category, category);
  track('subject', existing.subject, subject);
  track('description', existing.description, description);

  // Workflow side effects
  if (status === 'ASSIGNED' && assigneeId) data.assigneeId = assigneeId;
  if (status === 'RESOLVED') data.resolvedAt = new Date();
  if (status === 'CLOSED') data.closedAt = new Date();
  if (assigneeId && existing.status === 'OPEN' && !status) data.status = 'ASSIGNED';

  const ticket = await prisma.ticket.update({
    where: { id: req.params.id },
    data: { ...data, history: { create: historyRows } },
    include: ticketInclude,
  });

  // Notify the new assignee
  if (data.assigneeId && data.assigneeId !== existing.assigneeId) {
    await notify({
      userId: data.assigneeId, type: 'TICKET',
      title: `Ticket ${ticket.ticketNo} assigned to you`,
      message: ticket.subject, link: `/tickets/${ticket.id}`, email: true,
    });
  }

  // Keep the requester in the loop when the status changes.
  if (data.status && data.status !== existing.status && ticket.requesterId !== req.user.id) {
    const pretty = data.status.replace(/_/g, ' ').toLowerCase();
    await notify({
      userId: ticket.requesterId, type: 'TICKET',
      title: `Ticket ${ticket.ticketNo} is now ${pretty}`,
      message: ticket.subject,
      link: `/tickets/${ticket.id}`,
      email: ['RESOLVED', 'CLOSED'].includes(data.status),
    });
  }

  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'Ticket', entityId: ticket.id, metadata: data });
  res.json({ success: true, data: ticket });
});

// POST /api/tickets/:id/comments
export const addComment = asyncHandler(async (req, res) => {
  const { body, isInternal } = req.body;
  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!ticket) throw ApiError.notFound('Ticket not found');

  const comment = await prisma.ticketComment.create({
    data: { ticketId: ticket.id, authorId: req.user.id, body, isInternal: !!isInternal },
    include: { author: { select: { id: true, firstName: true, lastName: true } } },
  });

  // Mark first response for SLA if this is staff replying.
  if (!ticket.firstRespondedAt && req.user.role !== 'EMPLOYEE') {
    await prisma.ticket.update({ where: { id: ticket.id }, data: { firstRespondedAt: new Date() } });
  }

  // Notify the other party about the new reply.
  const isStaffAuthor = req.user.role !== 'EMPLOYEE' && req.user.role !== 'DEPARTMENT_MANAGER';
  const recipients = new Set();
  if (isInternal) {
    // Internal notes: only loop in the assignee (not the requester).
    if (ticket.assigneeId && ticket.assigneeId !== req.user.id) recipients.add(ticket.assigneeId);
  } else if (isStaffAuthor) {
    // Staff replied → tell the requester.
    if (ticket.requesterId !== req.user.id) recipients.add(ticket.requesterId);
  } else {
    // Requester replied → tell the assignee (or the ICT team if unassigned).
    if (ticket.assigneeId) recipients.add(ticket.assigneeId);
    else {
      const staff = await prisma.user.findMany({
        where: { isActive: true, role: { in: ['SUPER_ADMIN', 'ICT_ADMIN', 'ICT_TECHNICIAN'] } }, select: { id: true },
      });
      staff.forEach((s) => recipients.add(s.id));
    }
  }
  await Promise.all([...recipients].map((userId) => notify({
    userId, type: 'TICKET',
    title: `New reply on ${ticket.ticketNo}`,
    message: `${req.user.firstName || 'Someone'} commented: ${body.slice(0, 80)}${body.length > 80 ? '…' : ''}`,
    link: `/tickets/${ticket.id}`, email: false,
  })));

  res.status(201).json({ success: true, data: comment });
});

// DELETE /api/tickets/:id
export const deleteTicket = asyncHandler(async (req, res) => {
  await prisma.ticket.delete({ where: { id: req.params.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'Ticket', entityId: req.params.id });
  res.json({ success: true, message: 'Ticket deleted' });
});
