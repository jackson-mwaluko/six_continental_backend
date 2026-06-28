import { z } from 'zod';

const ROLES = ['EMPLOYEE', 'DEPARTMENT_MANAGER', 'ICT_TECHNICIAN', 'ICT_ADMIN', 'SUPER_ADMIN'];

export const id = z.string().min(1);

// ── Auth ──────────────────────────────────────────────
export const loginSchema = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1, 'Password is required'),
  }),
};

export const registerSchema = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    firstName: z.string().min(1).max(60),
    lastName: z.string().min(1).max(60),
    role: z.enum(ROLES).optional(),
    departmentId: z.string().optional(),
    jobTitle: z.string().max(120).optional(),
    phone: z.string().max(40).optional(),
  }),
};

export const forgotPasswordSchema = { body: z.object({ email: z.string().email() }) };
export const resetPasswordSchema = {
  body: z.object({ token: z.string().min(10), password: z.string().min(8, 'Password must be at least 8 characters') }),
};

// ── Users ─────────────────────────────────────────────
export const updateUserSchema = {
  body: z.object({
    firstName: z.string().min(1).max(60).optional(),
    lastName: z.string().min(1).max(60).optional(),
    role: z.enum(ROLES).optional(),
    departmentId: z.string().nullable().optional(),
    jobTitle: z.string().max(120).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(8).optional(),
  }),
};

// ── Tickets ───────────────────────────────────────────
export const createTicketSchema = {
  body: z.object({
    subject: z.string().min(3).max(200),  
    description: z.string().min(1),
    category: z.string().optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    assigneeId: z.string().optional(),
    assetId: z.string().optional(),
  }),
};

export const commentSchema = { body: z.object({ body: z.string().min(1, 'Comment cannot be empty') }) };

// ── Inventory ─────────────────────────────────────────
export const stockMovementSchema = {
  body: z.object({
    type: z.enum(['IN', 'OUT', 'ADJUSTMENT']),
    quantity: z.coerce.number().positive('Quantity must be positive'),
    reason: z.string().max(200).optional(),
    reference: z.string().max(120).optional(),
  }),
};

// ── Maintenance ───────────────────────────────────────
export const createMaintenanceSchema = {
  body: z.object({
    title: z.string().min(3).max(200),
    description: z.string().optional(),
    assetId: z.string().optional(),
    assigneeId: z.string().optional(),
    frequency: z.enum(['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL']).optional(),
    scheduledDate: z.string().min(1, 'Scheduled date is required'),
  }),
};

// ── Projects ──────────────────────────────────────────
export const createProjectSchema = {
  body: z.object({
    name: z.string().min(2).max(160),
    code: z.string().max(40).optional(),
    description: z.string().optional(),
    status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    leadId: z.string().optional(),
  }),
};

export const createTaskSchema = {
  body: z.object({
    title: z.string().min(1).max(200),
    description: z.string().optional(),
    assigneeId: z.string().optional(),
    dueDate: z.string().optional(),
  }),
};

// ── Knowledge ─────────────────────────────────────────
export const createArticleSchema = {
  body: z.object({
    title: z.string().min(3).max(200),
    body: z.string().min(1),
    category: z.string().max(80).optional(),
    tags: z.union([z.array(z.string()), z.string()]).optional(),
  }),
};

// ── Assets ────────────────────────────────────────────
const ASSET_TYPES = ['LAPTOP', 'DESKTOP', 'PRINTER', 'ROUTER', 'SWITCH', 'UPS', 'MOBILE_PHONE', 'CCTV_DEVICE', 'OTHER'];
const ASSET_STATUS = ['IN_STOCK', 'ASSIGNED', 'IN_REPAIR', 'RETIRED', 'DISPOSED', 'LOST'];

export const createAssetSchema = {
  body: z.object({
    serialNumber: z.string().min(1, 'Serial number / code is required').max(120),
    name: z.string().min(1).max(160),
    type: z.enum(ASSET_TYPES),
    status: z.enum(ASSET_STATUS).optional(),
    model: z.string().max(120).optional(),
    manufacturer: z.string().max(120).optional(),
    location: z.string().max(120).optional(),
    purchaseCost: z.union([z.string(), z.number()]).optional(),
  }).passthrough(),
};

export const updateAssetSchema = {
  body: z.object({
    serialNumber: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(160).optional(),
    type: z.enum(ASSET_TYPES).optional(),
    status: z.enum(ASSET_STATUS).optional(),
    model: z.string().max(120).nullable().optional(),
    manufacturer: z.string().max(120).nullable().optional(),
    location: z.string().max(120).nullable().optional(),
    purchaseCost: z.union([z.string(), z.number(), z.null()]).optional(),
  }).passthrough(),
};

// ── Asset requests ────────────────────────────────────
export const createRequestSchema = {
  body: z.object({
    assetId: z.string().min(1, 'Choose an asset to request'),
    reason: z.string().max(500).optional(),
  }),
};
export const requestDecisionSchema = {
  body: z.object({ comment: z.string().max(500).optional() }),
};

// ── Common pagination ─────────────────────────────────
export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  search: z.string().optional(),
}).passthrough();
