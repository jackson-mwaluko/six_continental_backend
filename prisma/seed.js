import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = (p) => bcrypt.hashSync(p, 12);

async function main() {
  console.log('Seeding IOMS database...');

  // ── Departments ──────────────────────────────────────────
  const ict = await prisma.department.upsert({
    where: { name: 'ICT' }, update: {}, create: { name: 'ICT', code: 'ICT' },
  });
  const finance = await prisma.department.upsert({
    where: { name: 'Finance' }, update: {}, create: { name: 'Finance', code: 'FIN' },
  });
  const hr = await prisma.department.upsert({
    where: { name: 'Human Resources' }, update: {}, create: { name: 'Human Resources', code: 'HR' },
  });

  // ── Users (one per role) ─────────────────────────────────
  const users = [
    { email: 'superadmin@ioms.local', firstName: 'Sam', lastName: 'Root', role: 'SUPER_ADMIN', departmentId: ict.id, jobTitle: 'System Owner' },
    { email: 'ictadmin@ioms.local', firstName: 'Aisha', lastName: 'Mwakalinga', role: 'ICT_ADMIN', departmentId: ict.id, jobTitle: 'ICT Administrator' },
    { email: 'tech@ioms.local', firstName: 'Juma', lastName: 'Kessy', role: 'ICT_TECHNICIAN', departmentId: ict.id, jobTitle: 'Support Technician' },
    { email: 'manager@ioms.local', firstName: 'Neema', lastName: 'Lyimo', role: 'DEPARTMENT_MANAGER', departmentId: finance.id, jobTitle: 'Finance Manager' },
    { email: 'employee@ioms.local', firstName: 'David', lastName: 'Massawe', role: 'EMPLOYEE', departmentId: hr.id, jobTitle: 'HR Officer' },
  ];

  const created = {};
  for (const u of users) {
    created[u.role] = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, passwordHash: hash('Password123!') },
    });
  }

  // ── SLA policies ─────────────────────────────────────────
  const slas = [
    { name: 'Critical SLA', priority: 'CRITICAL', firstResponseMins: 15, resolutionMins: 240 },
    { name: 'High SLA', priority: 'HIGH', firstResponseMins: 60, resolutionMins: 480 },
    { name: 'Medium SLA', priority: 'MEDIUM', firstResponseMins: 240, resolutionMins: 1440 },
    { name: 'Low SLA', priority: 'LOW', firstResponseMins: 480, resolutionMins: 2880 },
  ];
  for (const s of slas) {
    const exists = await prisma.slaPolicy.findFirst({ where: { priority: s.priority } });
    if (!exists) await prisma.slaPolicy.create({ data: s });
  }

  // ── Vendor ───────────────────────────────────────────────
  const vendor = await prisma.vendor.upsert({
    where: { name: 'TechSupply Ltd' },
    update: {},
    create: {
      name: 'TechSupply Ltd', category: 'Hardware', email: 'sales@techsupply.co.tz', phone: '+255 22 000 0000',
      contacts: { create: { name: 'Grace Mushi', title: 'Account Manager', email: 'grace@techsupply.co.tz', isPrimary: true } },
    },
  });

  // ── Assets ───────────────────────────────────────────────
  const assetSeed = [
    { name: 'Dell Latitude 5440', type: 'LAPTOP', serialNumber: 'DL5440-001', model: 'Latitude 5440', manufacturer: 'Dell', status: 'ASSIGNED' },
    { name: 'HP LaserJet M404', type: 'PRINTER', serialNumber: 'HPM404-001', model: 'LaserJet M404dn', manufacturer: 'HP', status: 'IN_STOCK' },
    { name: 'Cisco Catalyst 2960', type: 'SWITCH', serialNumber: 'CC2960-001', model: 'Catalyst 2960', manufacturer: 'Cisco', status: 'IN_STOCK' },
    { name: 'APC Smart-UPS 1500', type: 'UPS', serialNumber: 'APC1500-001', model: 'Smart-UPS 1500', manufacturer: 'APC', status: 'IN_STOCK' },
  ];
  const assetRecords = {};
  for (const a of assetSeed) {
    assetRecords[a.serialNumber] = await prisma.asset.upsert({
      where: { serialNumber: a.serialNumber },
      update: {},
      create: { ...a, vendorId: vendor.id, warrantyEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000) },
    });
  }

  // ── Printer + toner ──────────────────────────────────────
  const printerAsset = assetRecords['HPM404-001'];
  const printer = await prisma.printer.upsert({
    where: { assetId: printerAsset.id },
    update: {},
    create: { assetId: printerAsset.id, modelName: 'HP LaserJet M404dn', monthlyDutyCycle: 80000 },
  });
  const tonerExists = await prisma.toner.findFirst({ where: { printerId: printer.id } });
  if (!tonerExists) {
    await prisma.toner.create({
      data: { printerId: printer.id, partNumber: 'CF259A', color: 'BLACK', expectedYield: 3000, currentPageCount: 2550, avgDailyPages: 120, lowThresholdPct: 15 },
    });
  }

  // ── Subscriptions ────────────────────────────────────────
  const subs = [
    { name: 'Microsoft 365 Business', type: 'MICROSOFT_365', provider: 'Microsoft', seats: 50, cost: 1200, billingCycle: 'ANNUAL', renewalDate: daysFromNow(20), expiryDate: daysFromNow(20), status: 'EXPIRING_SOON' },
    { name: 'Company Domain', type: 'DOMAIN', provider: 'Namecheap', cost: 15, billingCycle: 'ANNUAL', renewalDate: daysFromNow(120), status: 'ACTIVE' },
    { name: 'Antivirus — Bitdefender', type: 'ANTIVIRUS', provider: 'Bitdefender', seats: 60, cost: 600, billingCycle: 'ANNUAL', renewalDate: daysFromNow(5), expiryDate: daysFromNow(5), status: 'EXPIRING_SOON' },
  ];
  for (const s of subs) {
    const exists = await prisma.subscription.findFirst({ where: { name: s.name } });
    if (!exists) await prisma.subscription.create({ data: { ...s, vendorId: vendor.id } });
  }

  // ── Inventory ────────────────────────────────────────────
  const inv = [
    { sku: 'CONS-RJ45-100', name: 'RJ45 Connectors (pack 100)', category: 'CONSUMABLE', quantity: 3, reorderLevel: 5 },
    { sku: 'CONS-HDMI-CBL', name: 'HDMI Cable 2m', category: 'CONSUMABLE', quantity: 25, reorderLevel: 10 },
    { sku: 'SPARE-RAM-8GB', name: 'DDR4 8GB RAM Module', category: 'SPARE_PART', quantity: 4, reorderLevel: 6 },
  ];
  for (const i of inv) {
    await prisma.inventoryItem.upsert({ where: { sku: i.sku }, update: {}, create: i });
  }

  // ── Tickets ──────────────────────────────────────────────
  const ticketSeed = [
    { subject: 'Cannot connect to office WiFi', category: 'NETWORK', priority: 'HIGH', status: 'OPEN', requesterId: created.EMPLOYEE.id },
    { subject: 'Printer on 2nd floor jamming', category: 'PRINTER', priority: 'MEDIUM', status: 'IN_PROGRESS', requesterId: created.DEPARTMENT_MANAGER.id, assigneeId: created.ICT_TECHNICIAN.id },
    { subject: 'ERP login failing for finance team', category: 'ERP', priority: 'CRITICAL', status: 'ASSIGNED', requesterId: created.DEPARTMENT_MANAGER.id, assigneeId: created.ICT_TECHNICIAN.id },
    { subject: 'Request Microsoft 365 license', category: 'SOFTWARE', priority: 'LOW', status: 'RESOLVED', requesterId: created.EMPLOYEE.id, assigneeId: created.ICT_TECHNICIAN.id, resolvedAt: new Date() },
  ];
  let n = await prisma.ticket.count();
  for (const t of ticketSeed) {
    const exists = await prisma.ticket.findFirst({ where: { subject: t.subject } });
    if (!exists) {
      n += 1;
      await prisma.ticket.create({
        data: {
          ...t, ticketNo: `IOMS-${String(n).padStart(6, '0')}`,
          description: `${t.subject}. Reported by user; details to follow.`,
          history: { create: { actorId: t.requesterId, field: 'status', newValue: 'OPEN' } },
        },
      });
    }
  }

  // ── Assignment for the laptop ────────────────────────────
  const laptop = assetRecords['DL5440-001'];
  const hasAssignment = await prisma.assetAssignment.findFirst({ where: { assetId: laptop.id, status: 'ACTIVE' } });
  if (!hasAssignment) {
    const cnt = await prisma.handover.count();
    await prisma.assetAssignment.create({
      data: {
        assetId: laptop.id, employeeId: created.EMPLOYEE.id, issuedById: created.ICT_TECHNICIAN.id,
        conditionOut: 'New, no defects', handover: { create: { documentNo: `HND-${String(cnt + 1).padStart(5, '0')}` } },
      },
    });
  }

  // ── Knowledge base ───────────────────────────────────────
  const kb = [
    { title: 'How to reset your domain password', slug: 'reset-domain-password', category: 'Accounts', tags: ['password', 'account'], body: 'Step-by-step guide to resetting your password via the self-service portal.' },
    { title: 'Connecting to office VPN', slug: 'connect-office-vpn', category: 'Network', tags: ['vpn', 'remote'], body: 'Instructions for configuring the corporate VPN client.' },
  ];
  for (const a of kb) {
    await prisma.knowledgeArticle.upsert({ where: { slug: a.slug }, update: {}, create: { ...a, authorId: created.ICT_ADMIN.id } });
  }

  // ── Project ──────────────────────────────────────────────
  const proj = await prisma.project.findFirst({ where: { name: 'Network Upgrade 2026' } });
  if (!proj) {
    await prisma.project.create({
      data: {
        name: 'Network Upgrade 2026', code: 'NET-2026', status: 'ACTIVE', progress: 35, leadId: created.ICT_ADMIN.id,
        milestones: { create: [{ title: 'Site survey complete', completed: true }, { title: 'Switch rollout' }] },
        tasks: { create: [
          { title: 'Audit existing cabling', status: 'DONE', assigneeId: created.ICT_TECHNICIAN.id },
          { title: 'Procure managed switches', status: 'IN_PROGRESS', assigneeId: created.ICT_TECHNICIAN.id },
        ] },
      },
    });
  }

  console.log('Seed complete.');
  console.log('Login with any of: superadmin@ioms.local / ictadmin@ioms.local / tech@ioms.local / manager@ioms.local / employee@ioms.local');
  console.log('Password for all: Password123!');
}

function daysFromNow(d) { return new Date(Date.now() + d * 24 * 3600 * 1000); }

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
