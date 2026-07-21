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
    companyId: z.string().optional(),
    companyIds: z.array(z.string()).optional(),
    allCompanies: z.boolean().optional(),
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
    email: z.string().email('Enter a valid email address').optional(),
    role: z.enum(ROLES).optional(),
    departmentId: z.string().nullable().optional(),
    companyId: z.string().nullable().optional(),
    companyIds: z.array(z.string()).optional(),
    allCompanies: z.boolean().optional(),
    jobTitle: z.string().max(120).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(8).optional(),
  }),
};

// ── Tickets ───────────────────────────────────────────
const TICKET_CATEGORIES = ['COMPUTER', 'PRINTER', 'NETWORK', 'INTERNET', 'SOFTWARE', 'EMAIL', 'CCTV', 'ERP'];

export const createTicketSchema = {
  body: z.object({
    subject: z.string().min(3, 'Subject must be at least 3 characters').max(200),
    description: z.string().min(1, 'Description is required'),
    category: z.enum(TICKET_CATEGORIES).optional(),
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
    type: z.enum(ASSET_TYPES).optional(),
    categoryId: z.string().nullable().optional(),
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

// ── Personal notes / to-dos ─────────────────────────────
export const createNoteSchema = {
  body: z.object({
    type: z.enum(['NOTE', 'TODO']).optional(),
    title: z.string().min(1, 'Title is required').max(200),
    body: z.string().max(5000).nullable().optional(),
    reminderAt: z.string().nullable().optional(),
    isPinned: z.boolean().optional(),
  }),
};
export const updateNoteSchema = {
  body: z.object({
    type: z.enum(['NOTE', 'TODO']).optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(5000).nullable().optional(),
    reminderAt: z.string().nullable().optional(),
    isPinned: z.boolean().optional(),
    isDone: z.boolean().optional(),
  }),
};

// ── Self-service profile ────────────────────────────────
export const updateProfileSchema = {
  body: z.object({
    firstName: z.string().min(1).max(60).optional(),
    lastName: z.string().min(1).max(60).optional(),
    jobTitle: z.string().max(120).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
  }),
};
export const changePasswordSchema = {
  body: z.object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(8, 'New password must be at least 8 characters'),
  }),
};
export const notificationPrefsSchema = {
  body: z.object({
    notifyInApp: z.boolean().optional(),
    notifyEmail: z.boolean().optional(),
  }),
};

// ── Assignments ───────────────────────────────────────
export const createAssignmentSchema = {
  body: z.object({
    assetId: z.string().min(1, 'Choose an asset'),
    employeeId: z.string().min(1, 'Choose an employee'),
    conditionOut: z.string().max(500).optional(),
    notes: z.string().max(500).optional(),
    assignedAt: z.string().refine((v) => !v || !Number.isNaN(Date.parse(v)), 'Invalid date').optional(),
    overrideCapacity: z.boolean().optional(),
  }),
};

// ── Companies (group of companies) ──────────────────────
export const createCompanySchema = {
  body: z.object({
    name: z.string().min(1, 'Company name is required').max(160),
    shortName: z.string().max(60).nullable().optional(),
    code: z.string().max(40).nullable().optional(),
  }),
};
export const updateCompanySchema = {
  body: z.object({
    name: z.string().min(1).max(160).optional(),
    shortName: z.string().max(60).nullable().optional(),
    code: z.string().max(40).nullable().optional(),
  }),
};

// ── Asset categories (Chair, Cabinet, Table, Electronics…) ─
export const createCategorySchema = {
  body: z.object({
    name: z.string().min(1, 'Category name is required').max(80),
    icon: z.string().max(40).nullable().optional(),
  }),
};
export const updateCategorySchema = {
  body: z.object({
    name: z.string().min(1).max(80).optional(),
    icon: z.string().max(40).nullable().optional(),
  }),
};

// ── Public (no-auth) QR issue report ────────────────────
export const publicReportSchema = {
  body: z.object({
    description: z.string().min(5, 'Please describe the issue').max(2000),
    reporterName: z.string().max(120).optional(),
    reporterContact: z.string().max(160).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  }),
};

// ── Common pagination ─────────────────────────────────
export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  search: z.string().optional(),
}).passthrough();
