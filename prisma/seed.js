import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = (p) => bcrypt.hashSync(p, 12);

async function main() {
  console.log('Seeding IOMS database...');

  // ── Asset categories (basics + office suggestions) ──
  const categorySeed = [
    { name: 'Laptop', icon: 'laptop' },
    { name: 'Desktop', icon: 'desktop' },
    { name: 'Chair', icon: 'chair' },
    { name: 'Table', icon: 'table' },
    { name: 'Cabinet', icon: 'cabinet' },
    { name: 'UPS', icon: 'ups' },
    { name: 'Printer', icon: 'printer' },
    { name: 'Router', icon: 'router' },
    { name: 'Switch', icon: 'switch' },
    { name: 'RJ45 / Cabling', icon: 'rj45' },
    { name: 'Mobile Phone', icon: 'mobile' },
    { name: 'CCTV', icon: 'cctv' },
    { name: 'Office Pool', icon: 'pool' },
    { name: 'Monitor', icon: 'desktop' },
    { name: 'Projector', icon: 'electronics' },
    { name: 'Scanner', icon: 'printer' },
    { name: 'Access Point', icon: 'network' },
    { name: 'Server', icon: 'network' },
    { name: 'Telephone', icon: 'mobile' },
    { name: 'Air Conditioner', icon: 'electronics' },
    { name: 'Shredder', icon: 'electronics' },
    { name: 'Other Furniture', icon: 'furniture' },
    { name: 'Other Electronics', icon: 'electronics' },
    { name: 'Other', icon: 'other' },
  ];
  const categoryRecords = {};
  for (const c of categorySeed) {
    categoryRecords[c.name] = await prisma.assetCategory.upsert({
      where: { name: c.name }, update: { icon: c.icon, isSystem: true }, create: { ...c, isSystem: true },
    });
  }

  // Default assignment capacity (super-admin editable in Settings).
  await prisma.setting.upsert({
    where: { key: 'assignment.maxPerUser' }, update: {}, create: { key: 'assignment.maxPerUser', value: '5' },
  });

  // ── Companies ────────────────────────────────────────────
  const companies = [
    { name: 'Six Continental Group', shortName: 'SCG', code: 'SCG' },
    { name: 'Salum Continental', shortName: 'SCL', code: 'SCL' },
    { name: 'SSN', shortName: 'SSN', code: 'SSN' },
  ];
  
  const companyRecords = {};
  for (const c of companies) {
    companyRecords[c.shortName] = await prisma.company.upsert({
      where: { name: c.name }, update: {}, create: c,
    });
  }

  // ── Departments ──────────────────────────────────────────
  const departments = [
    { name: 'Management', code: 'MGT' },
    { name: 'Operations', code: 'OPS' },
    { name: 'SHEQ', code: 'SHEQ' }, // Safety, Health, Environment, Quality
    { name: 'Commercial', code: 'COM' },
    { name: 'Compliance', code: 'CMP' },
    { name: 'Tax', code: 'TAX' },
    { name: 'Finance', code: 'FIN' },
    { name: 'ICT', code: 'ICT' },
    { name: 'Human Resources', code: 'HR' },
    { name: 'Legal', code: 'LEG' },
    { name: 'Procurement', code: 'PROC' },
    { name: 'Marketing', code: 'MKT' },
    { name: 'Sales', code: 'SAL' },
    { name: 'Engineering', code: 'ENG' },
    { name: 'Customer Service', code: 'CS' },
  ];
  
  const departmentRecords = {};
  for (const d of departments) {
    departmentRecords[d.code] = await prisma.department.upsert({
      where: { name: d.name }, update: {}, create: d,
    });
  }

  // ── Users (only the main ICT admin) ─────────────────────
  const ictAdmin = await prisma.user.upsert({
    where: { email: 'ict@sixcontinentalgroup.africa' },
    update: {},
    create: {
      email: 'ict@sixcontinentalgroup.africa',
      firstName: 'ICT',
      lastName: 'Administrator',
      role: 'SUPER_ADMIN',
      departmentId: departmentRecords.ICT.id,
      companyId: companyRecords.SCG.id,
      jobTitle: 'ICT Administrator',
      passwordHash: hash('12345678'),
      allCompanies: true, // Has access to all companies
    },
  });

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

  // ── Knowledge base ───────────────────────────────────────
  const kb = [
    { title: 'How to reset your domain password', slug: 'reset-domain-password', category: 'Accounts', tags: ['password', 'account'], body: 'Step-by-step guide to resetting your password via the self-service portal.' },
    { title: 'Connecting to office VPN', slug: 'connect-office-vpn', category: 'Network', tags: ['vpn', 'remote'], body: 'Instructions for configuring the corporate VPN client.' },
  ];
  for (const a of kb) {
    await prisma.knowledgeArticle.upsert({ 
      where: { slug: a.slug }, 
      update: {}, 
      create: { ...a, authorId: ictAdmin.id } 
    });
  }

  // ── Project ──────────────────────────────────────────────
  const proj = await prisma.project.findFirst({ where: { name: 'Network Upgrade 2026' } });
  if (!proj) {
    await prisma.project.create({
      data: {
        name: 'Network Upgrade 2026', 
        code: 'NET-2026', 
        status: 'ACTIVE', 
        progress: 35, 
        leadId: ictAdmin.id,
        milestones: { 
          create: [
            { title: 'Site survey complete', completed: true }, 
            { title: 'Switch rollout' }
          ] 
        },
        tasks: { 
          create: [
            { title: 'Audit existing cabling', status: 'DONE', assigneeId: ictAdmin.id },
            { title: 'Procure managed switches', status: 'IN_PROGRESS', assigneeId: ictAdmin.id },
          ] 
        },
      },
    });
  }

  console.log('✅ Seed complete.');
  console.log('📧 Login: ict@sixcontinentalgroup.africa');
  console.log('🔑 Password: 12345678');
  console.log('🏢 Companies: Six Continental Group, Salum Continental, SSN');
  console.log('📋 Departments: Management, Operations, SHEQ, Commercial, Compliance, Tax, Finance, ICT, HR, Legal, Procurement, Marketing, Sales, Engineering, Customer Service');
}

function daysFromNow(d) { return new Date(Date.now() + d * 24 * 3600 * 1000); }

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });