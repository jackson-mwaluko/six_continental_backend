import prisma from '../config/prisma.js';
import { notify } from './notification.service.js';

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (a, b) => Math.round((a - b) / DAY);

// Who should receive operational alerts (ICT admins + technicians).
async function ictRecipients() {
  return prisma.user.findMany({
    where: { isActive: true, role: { in: ['SUPER_ADMIN', 'ICT_ADMIN', 'ICT_TECHNICIAN'] } },
    select: { id: true },
  });
}

// Avoid spamming: only notify once per (user, type, link) per day.
async function notifyOnce({ userId, type, title, message, link, email }) {
  const since = new Date(Date.now() - DAY);
  const existing = await prisma.notification.findFirst({
    where: { userId, type, link, createdAt: { gte: since } },
  });
  if (existing) return null;
  return notify({ userId, type, title, message, link, email });
}

// ── Toner: recompute remaining %, depletion date, and raise low-toner alerts ──
export async function runTonerCheck() {
  const toners = await prisma.toner.findMany({
    where: { replacedAt: null },
    include: { printer: { include: { asset: true } } },
  });

  const recipients = await ictRecipients();

  for (const t of toners) {
    const used = Math.max(0, t.currentPageCount - t.installedAtPageCount);
    const remaining = Math.max(0, t.expectedYield - used);
    const remainingPct = t.expectedYield > 0 ? Math.round((remaining / t.expectedYield) * 100) : 0;

    let estimatedDepletionDate = null;
    if (t.avgDailyPages && t.avgDailyPages > 0 && remaining > 0) {
      estimatedDepletionDate = new Date(Date.now() + (remaining / t.avgDailyPages) * DAY);
    }
    const isDepleted = remaining <= 0;

    await prisma.toner.update({
      where: { id: t.id },
      data: { estimatedDepletionDate, isDepleted },
    });

    if (remainingPct <= t.lowThresholdPct || isDepleted) {
      const printerName = t.printer?.asset?.name || t.printer?.modelName || 'printer';
      for (const r of recipients) {
        await notifyOnce({
          userId: r.id, type: 'LOW_TONER',
          title: `Low toner: ${printerName}`,
          message: `${t.color} toner (${t.partNumber}) is at ~${remainingPct}%${estimatedDepletionDate ? `, est. depletion ${estimatedDepletionDate.toLocaleDateString()}` : ''}.`,
          link: `/printers`, email: true,
        });
      }
    }
  }
  return { checked: toners.length };
}

// ── Inventory: raise low-stock alerts when quantity <= reorder level ──
export async function runStockCheck() {
  const items = await prisma.inventoryItem.findMany();
  const low = items.filter((i) => i.quantity <= i.reorderLevel);
  const recipients = await ictRecipients();

  for (const item of low) {
    for (const r of recipients) {
      await notifyOnce({
        userId: r.id, type: 'LOW_STOCK',
        title: `Low stock: ${item.name}`,
        message: `${item.name} (${item.sku}) is at ${item.quantity} ${item.unit} — reorder level is ${item.reorderLevel}.`,
        link: `/inventory`, email: true,
      });
    }
  }
  return { lowCount: low.length };
}

// ── Subscriptions: update status from dates + send renewal reminders ──
export async function runSubscriptionCheck() {
  const subs = await prisma.subscription.findMany({ where: { status: { not: 'CANCELLED' } } });
  const recipients = await ictRecipients();
  const now = new Date();

  for (const s of subs) {
    const target = s.expiryDate || s.renewalDate;
    if (!target) continue;
    const daysLeft = daysBetween(new Date(target), now);

    let status = 'ACTIVE';
    if (daysLeft < 0) status = 'EXPIRED';
    else if (daysLeft <= s.reminderDaysBefore) status = 'EXPIRING_SOON';

    if (status !== s.status) {
      await prisma.subscription.update({ where: { id: s.id }, data: { status } });
    }

    if (status === 'EXPIRING_SOON' || status === 'EXPIRED') {
      for (const r of recipients) {
        await notifyOnce({
          userId: r.id, type: 'SUBSCRIPTION_RENEWAL',
          title: status === 'EXPIRED' ? `Expired: ${s.name}` : `Renewal due: ${s.name}`,
          message: `${s.name} (${s.provider || s.type}) ${daysLeft < 0 ? `expired ${-daysLeft} day(s) ago` : `renews in ${daysLeft} day(s)`}.`,
          link: `/subscriptions`, email: true,
        });
      }
    }
  }
  return { checked: subs.length };
}

// ── Maintenance: flag overdue tasks and send upcoming reminders ──
export async function runMaintenanceCheck() {
  const now = new Date();
  const recipients = await ictRecipients();

  // Mark scheduled-but-past tasks as overdue.
  const overdue = await prisma.maintenance.findMany({
    where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] }, scheduledDate: { lt: now } },
    include: { assignee: true },
  });
  for (const m of overdue) {
    await prisma.maintenance.update({ where: { id: m.id }, data: { status: 'OVERDUE' } });
    const targets = m.assigneeId ? [{ id: m.assigneeId }] : recipients;
    for (const r of targets) {
      await notifyOnce({
        userId: r.id, type: 'MAINTENANCE',
        title: `Overdue maintenance: ${m.title}`,
        message: `Scheduled for ${new Date(m.scheduledDate).toLocaleDateString()} and not yet completed.`,
        link: `/maintenance`, email: true,
      });
    }
  }

  // Remind about tasks due within 3 days.
  const soon = await prisma.maintenance.findMany({
    where: { status: 'SCHEDULED', scheduledDate: { gte: now, lte: new Date(now.getTime() + 3 * DAY) } },
  });
  for (const m of soon) {
    const targets = m.assigneeId ? [{ id: m.assigneeId }] : recipients;
    for (const r of targets) {
      await notifyOnce({
        userId: r.id, type: 'MAINTENANCE',
        title: `Upcoming maintenance: ${m.title}`,
        message: `Due ${new Date(m.scheduledDate).toLocaleDateString()}.`,
        link: `/maintenance`, email: false,
      });
    }
  }
  return { overdue: overdue.length, upcoming: soon.length };
}

// Run every check once (used by the scheduler and the manual trigger endpoint).
// ── Personal notes: fire a reminder notification at the scheduled time ──
export async function runNoteReminders() {
  const now = new Date();
  const due = await prisma.note.findMany({
    where: { reminderAt: { lte: now }, reminderSent: false, isDone: false },
  });

  for (const n of due) {
    await notify({
      userId: n.userId, type: 'REMINDER',
      title: n.type === 'TODO' ? `To-do reminder: ${n.title}` : `Note reminder: ${n.title}`,
      message: n.body ? n.body.slice(0, 140) : 'You set a reminder for this.',
      link: '/notes', email: true,
    });
    await prisma.note.update({ where: { id: n.id }, data: { reminderSent: true } });
  }
  return { reminded: due.length };
}

// ── Tickets: detect SLA breaches, flag, escalate priority, and notify ──
const ESCALATE = { LOW: 'MEDIUM', MEDIUM: 'HIGH', HIGH: 'CRITICAL', CRITICAL: 'CRITICAL' };

export async function runSlaCheck() {
  const now = new Date();
  const recipients = await ictRecipients();

  const breached = await prisma.ticket.findMany({
    where: {
      status: { notIn: ['RESOLVED', 'CLOSED'] },
      slaBreached: false,
      resolutionDueAt: { lt: now },
    },
    include: { assignee: true },
  });

  for (const t of breached) {
    const escalated = ESCALATE[t.priority] || t.priority;
    await prisma.ticket.update({
      where: { id: t.id },
      data: { slaBreached: true, priority: escalated },
    });

    const targets = t.assigneeId ? [{ id: t.assigneeId }, ...recipients] : recipients;
    const seen = new Set();
    for (const r of targets) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      await notifyOnce({
        userId: r.id, type: 'SLA_BREACH',
        title: `SLA breached: ${t.number || t.title}`,
        message: `Ticket "${t.title}" passed its resolution deadline${escalated !== t.priority ? ` — escalated to ${escalated}` : ''}.`,
        link: `/tickets/${t.id}`, email: true,
      });
    }
  }
  return { breached: breached.length };
}

export async function runAllChecks() {
  const [toner, stock, subs, maint, sla] = await Promise.all([
    runTonerCheck(), runStockCheck(), runSubscriptionCheck(), runMaintenanceCheck(), runSlaCheck(),
  ]);
  return { toner, stock, subs, maint, sla, ranAt: new Date().toISOString() };
}
