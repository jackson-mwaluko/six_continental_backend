import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';

// GET /api/dashboard/stats — aggregate metrics for the home dashboard.
export const dashboardStats = asyncHandler(async (_req, res) => {
  const [
    openTickets, inProgressTickets, resolvedToday, slaBreached,
    totalAssets, assignedAssets, inRepair,
    expiringSubs, overdueMaintenance, lowStock,
    ticketsByPriority, ticketsByCategory, ticketsByStatus,
    assetsByType, pendingRequests, recentRequests,
  ] = await Promise.all([
    prisma.ticket.count({ where: { status: 'OPEN' } }),
    prisma.ticket.count({ where: { status: 'IN_PROGRESS' } }),
    prisma.ticket.count({ where: { status: 'RESOLVED', resolvedAt: { gte: startOfToday() } } }),
    prisma.ticket.count({ where: { slaBreached: true, status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
    prisma.asset.count(),
    prisma.asset.count({ where: { status: 'ASSIGNED' } }),
    prisma.asset.count({ where: { status: 'IN_REPAIR' } }),
    prisma.subscription.count({ where: { status: { in: ['EXPIRING_SOON', 'EXPIRED'] } } }),
    prisma.maintenance.count({ where: { status: 'OVERDUE' } }),
    prisma.inventoryItem.count({ where: { quantity: { lte: prisma.inventoryItem.fields.reorderLevel } } }).catch(() => 0),
    prisma.ticket.groupBy({ by: ['priority'], _count: true }),
    prisma.ticket.groupBy({ by: ['category'], _count: true }),
    prisma.ticket.groupBy({ by: ['status'], _count: true }),
    prisma.asset.groupBy({ by: ['type'], _count: true }),
    prisma.assetRequest.count({ where: { status: 'PENDING' } }),
    prisma.assetRequest.findMany({
      where: { status: 'PENDING' },
      include: {
        asset: { select: { serialNumber: true, name: true } },
        requester: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 5,
    }),
  ]);

  res.json({
    success: true,
    data: {
      cards: {
        openTickets, inProgressTickets, resolvedToday, slaBreached,
        totalAssets, assignedAssets, inRepair,
        expiringSubs, overdueMaintenance, lowStock, pendingRequests,
      },
      charts: {
        ticketsByPriority: mapGroup(ticketsByPriority, 'priority'),
        ticketsByCategory: mapGroup(ticketsByCategory, 'category'),
        ticketsByStatus: mapGroup(ticketsByStatus, 'status'),
        assetsByType: mapGroup(assetsByType, 'type'),
      },
      recentRequests,
    },
  });
});

// GET /api/dashboard/me — personal view for non-staff users
export const myDashboard = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const [assignments, openTickets, resolvedTickets, requests] = await Promise.all([
    prisma.assetAssignment.findMany({
      where: { employeeId: userId, status: 'ACTIVE' },
      include: { asset: { select: { id: true, serialNumber: true, name: true, type: true } }, handover: { select: { documentNo: true } } },
      orderBy: { assignedAt: 'desc' },
    }),
    prisma.ticket.count({ where: { requesterId: userId, status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
    prisma.ticket.count({ where: { requesterId: userId, status: { in: ['RESOLVED', 'CLOSED'] } } }),
    prisma.assetRequest.findMany({
      where: { requesterId: userId },
      include: { asset: { select: { serialNumber: true, name: true } } },
      orderBy: { createdAt: 'desc' }, take: 5,
    }),
  ]);

const myTickets = await prisma.ticket.findMany({
    where: { requesterId: userId },
    select: { id: true, ticketNo: true, subject: true, status: true, priority: true, createdAt: true },
    //                         ^^^^^^^ use subject if that's the field name
    orderBy: { createdAt: 'desc' }, take: 5,
});

  res.json({
    success: true,
    data: {
      cards: {
        myAssets: assignments.length,
        openTickets,
        resolvedTickets,
        pendingRequests: requests.filter((r) => r.status === 'PENDING').length,
      },
      assignments,
      myTickets,
      requests,
    },
  });
});

// GET /api/dashboard/recent — recent activity feed
export const recentActivity = asyncHandler(async (_req, res) => {
  const logs = await prisma.activityLog.findMany({
    take: 15, orderBy: { createdAt: 'desc' },
    include: { user: { select: { firstName: true, lastName: true } } },
  });
  res.json({ success: true, data: logs });
});

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function mapGroup(rows, key) {
  return rows.map((r) => ({ name: r[key], value: r._count?._all ?? r._count }));
}
