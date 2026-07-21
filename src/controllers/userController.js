import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { companyScopeWhere } from '../utils/companyScope.js';
import { buildListWorkbook, firstCompanyName, sendWorkbook } from '../utils/exporter.js';
import { hashPassword } from '../utils/password.js';
import { notify } from '../services/notification.service.js';

const ROLES = ['EMPLOYEE', 'DEPARTMENT_MANAGER', 'ICT_TECHNICIAN', 'ICT_ADMIN', 'SUPER_ADMIN'];

// Fields safe to return to the client — never exposes passwordHash.
const SAFE_SELECT = {
  id: true, email: true, firstName: true, lastName: true, role: true, avatarUrl: true,
  jobTitle: true, phone: true, isActive: true, lastLoginAt: true, createdAt: true,
  departmentId: true, department: { select: { id: true, name: true } },
  companyId: true, company: { select: { id: true, name: true, shortName: true } },
  allCompanies: true, companies: { select: { id: true, name: true, shortName: true } },
};

// GET /api/users — list with optional search + role filter (no secrets)
export const listUsers = asyncHandler(async (req, res) => {
  const { search, role } = req.query;
  // Scope: an admin sees users whose primary company is one they can access.
  // All-companies / super admin see everyone (including users with no company).
  const scope = await companyScopeWhere(req.user, 'companyId');
  const users = await prisma.user.findMany({
    where: {
      ...scope,
      ...(role && { role }),
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
    },
    select: SAFE_SELECT,
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: users });
});

// GET /api/users/export.xlsx — branded Excel of (scoped) users
export const exportUsers = asyncHandler(async (req, res) => {
  const scope = await companyScopeWhere(req.user, 'companyId');
  const users = await prisma.user.findMany({ where: scope, select: SAFE_SELECT, orderBy: { createdAt: 'desc' } });
  const rows = users.map((u) => ({
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    role: u.role,
    jobTitle: u.jobTitle || '',
    phone: u.phone || '',
    department: u.department?.name || '',
    company: u.company?.name || '',
    access: u.allCompanies ? 'All companies' : (u.companies?.length ? `${u.companies.length} companies` : 'Primary only'),
    status: u.isActive ? 'Active' : 'Disabled',
  }));
  const columns = [
    { header: 'First Name', key: 'firstName', width: 16 },
    { header: 'Last Name', key: 'lastName', width: 16 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Role', key: 'role', width: 18 },
    { header: 'Job Title', key: 'jobTitle', width: 20 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Department', key: 'department', width: 18 },
    { header: 'Company', key: 'company', width: 22 },
    { header: 'Access', key: 'access', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
  ];
  const wb = await buildListWorkbook({ title: 'Users', columns, rows, companyName: await firstCompanyName() });
  await sendWorkbook(res, wb, `ioms-users-${Date.now()}.xlsx`);
});

// POST /api/users/import — bulk-create users from parsed CSV rows.
// Body: { rows: [{ firstName, lastName, email, role?, jobTitle?, phone? }] }
// A temporary password is set; users reset it via "forgot password".
export const importUsers = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw ApiError.badRequest('No rows to import');
  if (rows.length > 500) throw ApiError.badRequest('Import is limited to 500 rows at a time');

  const ROLES = ['EMPLOYEE', 'DEPARTMENT_MANAGER', 'ICT_TECHNICIAN', 'ICT_ADMIN', 'SUPER_ADMIN'];
  const existing = new Set((await prisma.user.findMany({ select: { email: true } })).map((u) => u.email.toLowerCase()));
  const skipped = [];
  const toCreate = [];

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const email = (r.email || '').trim().toLowerCase();
    const firstName = (r.firstName || r.firstname || r['first name'] || '').trim();
    const lastName = (r.lastName || r.lastname || r['last name'] || '').trim();
    if (!email || !firstName || !lastName) { skipped.push({ row: i + 2, reason: 'Missing email, firstName, or lastName' }); continue; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { skipped.push({ row: i + 2, reason: `Invalid email "${email}"` }); continue; }
    if (existing.has(email)) { skipped.push({ row: i + 2, reason: `Duplicate email "${email}"` }); continue; }
    let role = (r.role || 'EMPLOYEE').trim().toUpperCase().replace(/\s+/g, '_');
    if (!ROLES.includes(role)) role = 'EMPLOYEE';
    existing.add(email);
    toCreate.push({
      email, firstName, lastName, role,
      jobTitle: r.jobTitle?.trim() || r['job title']?.trim() || null,
      phone: r.phone?.trim() || null,
      passwordHash: await hashPassword(`Temp-${Math.random().toString(36).slice(2, 10)}!`),
    });
  }

  let inserted = 0;
  if (toCreate.length) {
    const result = await prisma.user.createMany({ data: toCreate, skipDuplicates: true });
    inserted = result.count;
  }
  await logActivity({ userId: req.user.id, action: 'IMPORT', entity: 'User', metadata: { inserted, skipped: skipped.length } });
  res.status(201).json({ success: true, data: { inserted, skippedCount: skipped.length, skipped }, message: `${inserted} user(s) imported. They can set a password via "Forgot password".` });
});

// GET /api/users/:id
export const getUser = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: SAFE_SELECT });
  if (!user) throw ApiError.notFound('User not found');
  res.json({ success: true, data: user });
});

// PATCH /api/users/:id — update profile, role, department, status, or password
export const updateUser = asyncHandler(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw ApiError.notFound('User not found');

  const isSelf = req.user.id === target.id;
  const data = {};

  // Editable profile fields.
  for (const k of ['firstName', 'lastName', 'jobTitle', 'phone']) {
    if (req.body[k] !== undefined) data[k] = req.body[k];
  }
  if (req.body.departmentId !== undefined) data.departmentId = req.body.departmentId || null;
  if (req.body.companyId !== undefined) data.companyId = req.body.companyId || null;
  if (req.body.allCompanies !== undefined) data.allCompanies = !!req.body.allCompanies;
  // Company access set (M2M) — `set` replaces the whole list.
  if (req.body.companyIds !== undefined) {
    data.companies = { set: (req.body.companyIds || []).map((id) => ({ id })) };
  }

  // Email — admins can change their own or anyone else's. Must stay unique.
  let emailChanged = false;
  if (req.body.email !== undefined && req.body.email !== target.email) {
    const newEmail = String(req.body.email).trim().toLowerCase();
    const clash = await prisma.user.findFirst({ where: { email: newEmail, NOT: { id: target.id } } });
    if (clash) throw ApiError.conflict('That email is already in use by another account');
    data.email = newEmail;
    emailChanged = true;
  }

  // Role change — validate and guard against self-demotion / lockout.
  if (req.body.role !== undefined && req.body.role !== target.role) {
    if (!ROLES.includes(req.body.role)) throw ApiError.badRequest('Invalid role');
    if (isSelf) throw ApiError.badRequest('You cannot change your own role');
    if (target.role === 'SUPER_ADMIN') {
      const admins = await prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
      if (admins <= 1) throw ApiError.badRequest('Cannot demote the last active Super Admin');
    }
    data.role = req.body.role;
  }

  // Active/inactive — guard against self-deactivation / removing last admin.
  if (req.body.isActive !== undefined && req.body.isActive !== target.isActive) {
    if (isSelf && req.body.isActive === false) throw ApiError.badRequest('You cannot deactivate your own account');
    if (target.role === 'SUPER_ADMIN' && req.body.isActive === false) {
      const admins = await prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
      if (admins <= 1) throw ApiError.badRequest('Cannot deactivate the last active Super Admin');
    }
    data.isActive = req.body.isActive;
  }

  // Optional password reset.
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw ApiError.badRequest('Password must be at least 8 characters');
    data.passwordHash = await hashPassword(req.body.password);
  }

  const user = await prisma.user.update({ where: { id: req.params.id }, data, select: SAFE_SELECT });
  await logActivity({
    userId: req.user.id, action: 'UPDATE', entity: 'User', entityId: user.id,
    metadata: emailChanged ? { emailChanged: true, from: target.email, to: user.email } : undefined,
  });

  if (emailChanged) {
    await notify({
      userId: user.id, type: 'SYSTEM',
      title: 'Your account email was updated',
      message: `Your sign-in email is now ${user.email}. If you didn't expect this, contact ICT immediately.`,
      email: true,
    });
  }

  res.json({ success: true, data: user });
});

export { ROLES };
