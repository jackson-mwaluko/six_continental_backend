import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { hashPassword } from '../utils/password.js';

const ROLES = ['EMPLOYEE', 'DEPARTMENT_MANAGER', 'ICT_TECHNICIAN', 'ICT_ADMIN', 'SUPER_ADMIN'];

// Fields safe to return to the client — never exposes passwordHash.
const SAFE_SELECT = {
  id: true, email: true, firstName: true, lastName: true, role: true,
  jobTitle: true, phone: true, isActive: true, lastLoginAt: true, createdAt: true,
  departmentId: true, department: { select: { id: true, name: true } },
};

// GET /api/users — list with optional search + role filter (no secrets)
export const listUsers = asyncHandler(async (req, res) => {
  const { search, role } = req.query;
  const users = await prisma.user.findMany({
    where: {
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
  await logActivity({ userId: req.user.id, action: 'UPDATE', entity: 'User', entityId: user.id });
  res.json({ success: true, data: user });
});

export { ROLES };
