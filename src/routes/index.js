import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize, minRole } from '../middleware/rbac.js';
import { validateZod } from '../middleware/validate.js';
import * as V from '../validators/schemas.js';
import { crudController } from '../controllers/crudFactory.js';

import * as auth from '../controllers/authController.js';
import * as tickets from '../controllers/ticketController.js';
import * as assets from '../controllers/assetController.js';
import * as assignments from '../controllers/assignmentController.js';
import * as settings from '../controllers/settingsController.js';
import * as dashboard from '../controllers/dashboardController.js';
import * as toner from '../controllers/tonerController.js';
import * as inventory from '../controllers/inventoryController.js';
import * as maintenance from '../controllers/maintenanceController.js';
import * as knowledge from '../controllers/knowledgeController.js';
import * as projects from '../controllers/projectController.js';
import * as reports from '../controllers/reportController.js';
import * as attachments from '../controllers/attachmentController.js';
import * as users from '../controllers/userController.js';
import * as notifications from '../controllers/notificationController.js';
import * as assetRequests from '../controllers/assetRequestController.js';
import * as documents from '../controllers/documentController.js';
import * as notes from '../controllers/notesController.js';
import * as profile from '../controllers/profileController.js';
import * as search from '../controllers/searchController.js';
import * as publicAsset from '../controllers/publicController.js';
import * as companies from '../controllers/companyController.js';
import * as assetCategories from '../controllers/assetCategoryController.js';
import * as files from '../controllers/filesController.js';

const router = Router();

/* Public (NO AUTH) — QR-scannable asset details + issue reporting.
   Mounted first and deliberately without any auth middleware so anyone with
   the link/QR can view. Only exposes non-sensitive fields (see publicController). */
const publicRouter = Router();
publicRouter.get('/assets/:code', publicAsset.getPublicAsset);
publicRouter.post('/assets/:code/report', validateZod(V.publicReportSchema), publicAsset.reportPublicIssue);
// Serials may contain slashes — this catch-all keeps them resolvable.
publicRouter.get('/assets-by-code/*', (req, res, next) => { req.params.code = req.params[0]; publicAsset.getPublicAsset(req, res, next); });
router.use('/public', publicRouter);

/* Auth */
const authRouter = Router();
authRouter.post('/login', validateZod(V.loginSchema), auth.login);
authRouter.post('/refresh', auth.refresh);
authRouter.post('/logout', auth.logout);
authRouter.post('/forgot-password', validateZod(V.forgotPasswordSchema), auth.forgotPassword);
authRouter.post('/reset-password', validateZod(V.resetPasswordSchema), auth.resetPassword);
authRouter.get('/me', authenticate, auth.me);
authRouter.post('/register', authenticate, authorize('SUPER_ADMIN', 'ICT_ADMIN'), validateZod(V.registerSchema), auth.register);
router.use('/auth', authRouter);

/* Dashboard */
const dashRouter = Router();
dashRouter.use(authenticate);
dashRouter.get('/stats', dashboard.dashboardStats);
dashRouter.get('/me', dashboard.myDashboard);
dashRouter.get('/recent', dashboard.recentActivity);
router.use('/dashboard', dashRouter);

/* ICT Document Portal — staff only */
const docRouter = Router();
docRouter.use(authenticate, minRole('ICT_TECHNICIAN'));
docRouter.get('/', documents.listDocuments);
docRouter.get('/file/:filename', documents.downloadDocument);
docRouter.post('/', documents.uploadDoc.single('file'), documents.uploadDocument);
docRouter.patch('/:id', documents.updateDocument);
docRouter.delete('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), documents.deleteDocument);
router.use('/documents', docRouter);

/* Companies (group of companies) — list for dropdowns, admin-managed */
const companyRouter = Router();
companyRouter.use(authenticate);
companyRouter.get('/', companies.listCompanies);
companyRouter.post('/', minRole('ICT_ADMIN'), validateZod(V.createCompanySchema), companies.createCompany);
companyRouter.post('/:id/logo', minRole('ICT_ADMIN'), companies.uploadLogo.single('logo'), companies.setCompanyLogo);
companyRouter.patch('/:id', minRole('ICT_ADMIN'), validateZod(V.updateCompanySchema), companies.updateCompany);
companyRouter.delete('/:id', minRole('ICT_ADMIN'), companies.deleteCompany);
router.use('/companies', companyRouter);

/* Asset categories (Chair, Cabinet, Table, Electronics…) — list for all, admin-managed */
const categoryRouter = Router();
categoryRouter.use(authenticate);
categoryRouter.get('/', assetCategories.listCategories);
categoryRouter.post('/', minRole('ICT_ADMIN'), validateZod(V.createCategorySchema), assetCategories.createCategory);
categoryRouter.patch('/:id', minRole('ICT_ADMIN'), validateZod(V.updateCategorySchema), assetCategories.updateCategory);
categoryRouter.delete('/:id', minRole('ICT_ADMIN'), assetCategories.deleteCategory);
router.use('/asset-categories', categoryRouter);

/* Global search — open to every signed-in user, results scoped per-role in the controller */
router.get('/search', authenticate, search.globalSearch);

/* My Profile — every signed-in user manages their own */
const profileRouter = Router();
// Public: profile photos are non-sensitive and filenames are unguessable
// (userId + timestamp), so plain <img> tags can load them without auth headers.
profileRouter.get('/avatar/:filename', profile.getAvatarFile);
profileRouter.use(authenticate);
profileRouter.get('/', profile.getProfile);
profileRouter.patch('/', validateZod(V.updateProfileSchema), profile.updateProfile);
profileRouter.post('/change-password', validateZod(V.changePasswordSchema), profile.changePassword);
profileRouter.patch('/notifications', validateZod(V.notificationPrefsSchema), profile.updateNotificationPrefs);
profileRouter.post('/test-email', profile.sendTestEmail);
profileRouter.post('/avatar', profile.uploadAvatar.single('avatar'), profile.setAvatar);
profileRouter.delete('/avatar', profile.removeAvatar);
router.use('/profile', profileRouter);

/* Personal notes / to-dos — every signed-in user, strictly scoped to self */
const notesRouter = Router();
notesRouter.use(authenticate);
notesRouter.get('/', notes.listNotes);
notesRouter.post('/', validateZod(V.createNoteSchema), notes.createNote);
notesRouter.patch('/:id', validateZod(V.updateNoteSchema), notes.updateNote);
notesRouter.delete('/:id', notes.deleteNote);
notesRouter.post('/:id/attachments', attachments.upload.single('file'), attachments.uploadNoteAttachment);
router.use('/notes', notesRouter);

/* Asset requests */
const reqRouter = Router();
reqRouter.use(authenticate);
reqRouter.get('/', assetRequests.listRequests);
reqRouter.post('/', validateZod(V.createRequestSchema), assetRequests.createRequest);
reqRouter.post('/:id/cancel', assetRequests.cancelRequest);
reqRouter.post('/:id/approve', minRole('ICT_ADMIN'), validateZod(V.requestDecisionSchema), assetRequests.approveRequest);
reqRouter.post('/:id/reject', minRole('ICT_ADMIN'), validateZod(V.requestDecisionSchema), assetRequests.rejectRequest);
router.use('/asset-requests', reqRouter);

/* Tickets */
const ticketRouter = Router();
ticketRouter.use(authenticate);
ticketRouter.get('/', tickets.listTickets);
ticketRouter.get('/my-queue', minRole('ICT_TECHNICIAN'), tickets.myQueue);
ticketRouter.post('/', validateZod(V.createTicketSchema), tickets.createTicket);
ticketRouter.get('/:id', tickets.getTicket);
ticketRouter.patch('/:id', minRole('ICT_TECHNICIAN'), tickets.updateTicket);
ticketRouter.post('/:id/comments', validateZod(V.commentSchema), tickets.addComment);
ticketRouter.post('/:id/attachments', attachments.upload.single('file'), attachments.uploadTicketAttachment);
ticketRouter.delete('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), tickets.deleteTicket);
router.use('/tickets', ticketRouter);

/* Assets */
const assetRouter = Router();
// Public: local-fallback file serving for asset images (no auth); when Supabase
// is configured these render straight from Supabase and this isn't hit.
assetRouter.use(authenticate);
assetRouter.get('/', assets.listAssets);
assetRouter.get('/export.xlsx', assets.exportAssets);
assetRouter.get('/:id', assets.getAsset);
assetRouter.post('/', minRole('ICT_TECHNICIAN'), validateZod(V.createAssetSchema), assets.createAsset);
assetRouter.post('/import', minRole('ICT_ADMIN'), assets.importAssets);
assetRouter.post('/:id/image', minRole('ICT_TECHNICIAN'), assets.uploadAssetImage.single('image'), assets.setAssetImage);
assetRouter.patch('/:id', minRole('ICT_TECHNICIAN'), validateZod(V.updateAssetSchema), assets.updateAsset);
assetRouter.delete('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), assets.deleteAsset);
router.use('/assets', assetRouter);

/* Files — public serving of locally-stored uploads (fallback when Supabase is off) */
router.get('/files/:bucket/:filename', files.serveLocalFile);

/* Assignments */
const assignRouter = Router();
assignRouter.use(authenticate);
assignRouter.get('/', minRole('ICT_TECHNICIAN'), assignments.listAssignments);
assignRouter.get('/assignable-users', minRole('ICT_TECHNICIAN'), assignments.assignableUsers);
// Detail is open to any authenticated user — the controller enforces that
// non-staff may only view their own assignment.
assignRouter.get('/:id', assignments.getAssignment);
assignRouter.post('/', minRole('ICT_TECHNICIAN'), validateZod(V.createAssignmentSchema), assignments.assignAsset);
assignRouter.post('/:id/return', minRole('ICT_TECHNICIAN'), assignments.returnAsset);
assignRouter.post('/:id/transfer', minRole('ICT_TECHNICIAN'), assignments.transferAsset);
router.use('/assignments', assignRouter);

/* Settings — assignment capacity (read: any authed; write: super admin) */
const settingsRouter = Router();
settingsRouter.use(authenticate);
settingsRouter.get('/', settings.listSettings);
settingsRouter.patch('/assignment', authorize('SUPER_ADMIN'), settings.updateAssignmentSettings);
router.use('/settings', settingsRouter);

/* Printers & Toner */
const printerRouter = Router();
printerRouter.use(authenticate);
printerRouter.get('/', toner.listPrinters);
printerRouter.get('/unregistered', minRole('ICT_TECHNICIAN'), toner.listUnregisteredAssets);
printerRouter.post('/', minRole('ICT_TECHNICIAN'), toner.registerPrinter);
printerRouter.post('/run-check', minRole('ICT_TECHNICIAN'), toner.triggerTonerCheck);
printerRouter.get('/:id', toner.getPrinter);
printerRouter.post('/:id/toners', minRole('ICT_TECHNICIAN'), toner.installToner);
router.use('/printers', printerRouter);

const tonerRouter = Router();
tonerRouter.use(authenticate, minRole('ICT_TECHNICIAN'));
tonerRouter.patch('/:id', toner.updateToner);
tonerRouter.post('/:id/replace', toner.replaceToner);
router.use('/toners', tonerRouter);

/* Inventory */
const invRouter = Router();
invRouter.use(authenticate);
invRouter.get('/', inventory.listInventory);
invRouter.post('/run-check', minRole('ICT_TECHNICIAN'), inventory.triggerStockCheck);
invRouter.get('/:id', inventory.getInventoryItem);
invRouter.post('/', minRole('ICT_TECHNICIAN'), inventory.createInventoryItem);
invRouter.post('/:id/movements', minRole('ICT_TECHNICIAN'), validateZod(V.stockMovementSchema), inventory.recordMovement);
invRouter.patch('/:id', minRole('ICT_TECHNICIAN'), inventory.updateInventoryItem);
invRouter.delete('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), inventory.deleteInventoryItem);
router.use('/inventory', invRouter);

/* Maintenance */
const maintRouter = Router();
maintRouter.use(authenticate);
maintRouter.get('/', maintenance.listMaintenance);
maintRouter.post('/run-check', minRole('ICT_TECHNICIAN'), maintenance.triggerMaintenanceCheck);
maintRouter.get('/:id', maintenance.getMaintenance);
maintRouter.post('/', minRole('ICT_TECHNICIAN'), validateZod(V.createMaintenanceSchema), maintenance.createMaintenance);
maintRouter.patch('/:id', minRole('ICT_TECHNICIAN'), maintenance.updateMaintenance);
maintRouter.post('/:id/complete', minRole('ICT_TECHNICIAN'), maintenance.completeMaintenance);
maintRouter.delete('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), maintenance.deleteMaintenance);
router.use('/maintenance', maintRouter);

/* Knowledge Base */
const kbRouter = Router();
kbRouter.use(authenticate);
kbRouter.get('/', knowledge.listArticles);
kbRouter.get('/:id', knowledge.getArticle);
kbRouter.post('/', minRole('ICT_TECHNICIAN'), validateZod(V.createArticleSchema), knowledge.createArticle);
kbRouter.patch('/:id', minRole('ICT_TECHNICIAN'), knowledge.updateArticle);
kbRouter.delete('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), knowledge.deleteArticle);
router.use('/knowledge', kbRouter);

/* Projects */
const projRouter = Router();
projRouter.use(authenticate);
projRouter.get('/', projects.listProjects);
projRouter.get('/:id', projects.getProject);
projRouter.post('/', minRole('ICT_TECHNICIAN'), validateZod(V.createProjectSchema), projects.createProject);
projRouter.post('/:id/tasks', minRole('ICT_TECHNICIAN'), validateZod(V.createTaskSchema), projects.addTask);
projRouter.post('/:id/milestones', minRole('ICT_TECHNICIAN'), projects.addMilestone);
projRouter.delete('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), projects.deleteProject);
router.use('/projects', projRouter);

const taskRouter = Router();
taskRouter.use(authenticate, minRole('ICT_TECHNICIAN'));
taskRouter.patch('/:id', projects.updateTask);
taskRouter.delete('/:id', projects.deleteTask);
router.use('/tasks', taskRouter);

const milestoneRouter = Router();
milestoneRouter.use(authenticate, minRole('ICT_TECHNICIAN'));
milestoneRouter.patch('/:id', projects.updateMilestone);
router.use('/milestones', milestoneRouter);

/* Reports */
const reportRouter = Router();
reportRouter.use(authenticate);
reportRouter.get('/monthly', reports.monthlyReport);
reportRouter.get('/export.pdf', reports.exportPdf);
reportRouter.get('/export.xlsx', reports.exportExcel);
router.use('/reports', reportRouter);

/* Attachments */
const attachRouter = Router();
attachRouter.get('/:filename', authenticate, attachments.downloadAttachment);
attachRouter.delete('/:id', authenticate, attachments.deleteAttachment);
router.use('/attachments', attachRouter);

const handoverRouter = Router();
handoverRouter.use(authenticate, minRole('ICT_TECHNICIAN'));
handoverRouter.post('/:id/attachments', attachments.upload.single('file'), attachments.uploadHandoverAttachment);
router.use('/handovers', handoverRouter);

/* Generic CRUD (remaining standard modules) */
const crudModules = [
  { path: 'subscriptions', model: 'subscription', searchFields: ['name', 'provider'], include: { vendor: true } },
  { path: 'stock-movements', model: 'stockMovement', searchFields: ['reason'], include: { item: true } },
  { path: 'vendors', model: 'vendor', searchFields: ['name', 'email'], include: { contacts: true, contracts: true } },
  { path: 'contracts', model: 'contract', searchFields: ['title', 'contractNo'], include: { vendor: true } },
  { path: 'audits', model: 'audit', searchFields: ['title'], include: { conductedBy: true } },
  { path: 'departments', model: 'department', searchFields: ['name', 'code'] },
];
for (const m of crudModules) {
  const c = crudController(m.model, { searchFields: m.searchFields, include: m.include, entity: m.path });
  const r = Router();
  r.use(authenticate);
  r.get('/', c.list);
  r.get('/:id', c.get);
  r.post('/', minRole('ICT_TECHNICIAN'), c.create);
  r.patch('/:id', minRole('ICT_TECHNICIAN'), c.update);
  r.delete('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), c.remove);
  router.use(`/${m.path}`, r);
}

/* Users */
const userRouter = Router();
userRouter.use(authenticate);
// Any authenticated user can list users (needed by assignment / task pickers); writes are admin-only.
userRouter.get('/', users.listUsers);
userRouter.get('/export.xlsx', users.exportUsers);
userRouter.post('/import', authorize('SUPER_ADMIN', 'ICT_ADMIN'), users.importUsers);
userRouter.get('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), users.getUser);
userRouter.patch('/:id', authorize('SUPER_ADMIN', 'ICT_ADMIN'), validateZod(V.updateUserSchema), users.updateUser);
router.use('/users', userRouter);

/* Notifications */
const notifCrud = crudController('notification', { entity: 'notifications' });
const notifRouter = Router();
// SSE stream authenticates via query token (EventSource can't set headers).
notifRouter.get('/stream', notifications.streamNotifications);
notifRouter.use(authenticate);
notifRouter.get('/', (req, res, next) => { req.query.userId = req.user.id; return notifCrud.list(req, res, next); });
notifRouter.patch('/:id', notifCrud.update);
router.use('/notifications', notifRouter);

/* Activity log */
const activityCrud = crudController('activityLog', { searchFields: ['action', 'entity'], include: { user: { select: { firstName: true, lastName: true } } }, entity: 'activity' });
const activityRouter = Router();
activityRouter.use(authenticate, minRole('DEPARTMENT_MANAGER'));
activityRouter.get('/', activityCrud.list);
router.use('/activity', activityRouter);

export default router;
