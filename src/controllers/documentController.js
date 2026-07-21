import multer from 'multer';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { storeFile, deleteFile, keyFromUrl } from '../services/storage.service.js';

const MAX_MB = Number(process.env.MAX_DOC_SIZE_MB) || 50;

// Broader allow-list than ticket attachments — includes presentation formats.
// Memory storage; the storage service pushes to Supabase (or local disk).
export const uploadDoc = multer({
  storage: multer.memoryStorage(),
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
  if (!title || !title.trim()) throw ApiError.badRequest('A title is required');
  const cat = CATEGORIES.includes(category) ? category : 'OTHER';

  const isImg = /\.(png|jpe?g|gif|webp)$/i.test(req.file.originalname);
  const { url, key } = await storeFile({
    mediaType: isImg ? 'asset-image' : 'other-files',
    buffer: req.file.buffer, originalName: req.file.originalname, mimeType: req.file.mimetype,
  });

  const doc = await prisma.document.create({
    data: {
      title: title.trim(), description: description?.trim() || null, category: cat,
      fileName: req.file.originalname,
      fileUrl: url, storageKey: key,
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

// GET /api/documents/file/:filename — stream a locally-stored file. Supabase
// documents are served from their public URL directly (this isn't hit).
export const downloadDocument = asyncHandler(async (req, res) => {
  const fsMod = await import('fs');
  const pathMod = await import('path');
  const filename = pathMod.basename(req.params.filename);
  // Support both new (other-files/) and legacy (documents/) local layouts.
  const candidates = [
    pathMod.join(process.env.UPLOAD_DIR || 'uploads', 'other-files', filename),
    pathMod.join(process.env.UPLOAD_DIR || 'uploads', 'asset-image', filename),
    pathMod.join(process.env.UPLOAD_DIR || 'uploads', 'documents', filename),
  ];
  const hit = candidates.find((p) => fsMod.existsSync(p));
  if (!hit) throw ApiError.notFound('File not found');
  res.sendFile(pathMod.resolve(hit));
});

// DELETE /api/documents/:id — remove record + file
export const deleteDocument = asyncHandler(async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) throw ApiError.notFound('Document not found');
  await deleteFile(doc.storageKey || keyFromUrl(doc.fileUrl));
  await prisma.document.delete({ where: { id: req.params.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'Document', entityId: req.params.id, metadata: { title: doc.title } });
  res.json({ success: true, message: 'Document deleted' });
});
