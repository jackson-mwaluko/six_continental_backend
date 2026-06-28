import multer from 'multer';
import fs from 'fs';
import path from 'path';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const DOC_DIR = path.join(UPLOAD_DIR, 'documents');
const MAX_MB = Number(process.env.MAX_DOC_SIZE_MB) || 50;

fs.mkdirSync(DOC_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOC_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`);
  },
});

// Broader allow-list than ticket attachments — includes presentation formats.
export const uploadDoc = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(pptx?|pdf|docx?|xlsx?|key|txt|csv|png|jpe?g|gif|webp|zip|mp4|mov)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new ApiError(400, 'Unsupported file type for the portal'));
  },
});

const CATEGORIES = ['PRESENTATION', 'MEETING_NOTES', 'POLICY', 'TEMPLATE', 'REPORT', 'DIAGRAM', 'OTHER'];

// GET /api/documents — searchable, filterable library
export const listDocuments = asyncHandler(async (req, res) => {
  const { search, category } = req.query;
  const where = {
    ...(category && { category }),
    ...(search && {
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { fileName: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };
  const documents = await prisma.document.findMany({
    where, include: { uploadedBy: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const counts = await prisma.document.groupBy({ by: ['category'], _count: true });
  res.json({ success: true, data: documents, meta: { categories: CATEGORIES, counts: counts.map((c) => ({ category: c.category, count: c._count })) } });
});

// POST /api/documents — upload a file with metadata (field name: "file")
export const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  const { title, description, category } = req.body;
  if (!title || !title.trim()) {
    fs.unlink(req.file.path, () => {});
    throw ApiError.badRequest('A title is required');
  }
  const cat = CATEGORIES.includes(category) ? category : 'OTHER';

  const doc = await prisma.document.create({
    data: {
      title: title.trim(), description: description?.trim() || null, category: cat,
      fileName: req.file.originalname,
      fileUrl: `/api/documents/file/${req.file.filename}`,
      mimeType: req.file.mimetype, sizeBytes: req.file.size,
      uploadedById: req.user.id,
    },
    include: { uploadedBy: { select: { firstName: true, lastName: true } } },
  });
  await logActivity({ userId: req.user.id, action: 'UPLOAD', entity: 'Document', entityId: doc.id, metadata: { title: doc.title } });
  res.status(201).json({ success: true, data: doc });
});

// PATCH /api/documents/:id — edit metadata
export const updateDocument = asyncHandler(async (req, res) => {
  const existing = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Document not found');
  const data = {};
  if (req.body.title !== undefined) data.title = req.body.title;
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.category !== undefined && CATEGORIES.includes(req.body.category)) data.category = req.body.category;
  const doc = await prisma.document.update({
    where: { id: req.params.id }, data,
    include: { uploadedBy: { select: { firstName: true, lastName: true } } },
  });
  res.json({ success: true, data: doc });
});

// GET /api/documents/file/:filename — stream the file (inline so it can preview)
export const downloadDocument = asyncHandler(async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DOC_DIR, filename);
  if (!fs.existsSync(filePath)) throw ApiError.notFound('File not found');
  res.sendFile(path.resolve(filePath));
});

// DELETE /api/documents/:id — remove record + file
export const deleteDocument = asyncHandler(async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) throw ApiError.notFound('Document not found');
  const filePath = path.join(DOC_DIR, doc.fileUrl.split('/').pop());
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await prisma.document.delete({ where: { id: req.params.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'Document', entityId: req.params.id, metadata: { title: doc.title } });
  res.json({ success: true, message: 'Document deleted' });
});
