import multer from 'multer';
import fs from 'fs';
import path from 'path';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const MAX_MB = Number(process.env.MAX_FILE_SIZE_MB) || 10;

// Ensure the upload directory exists.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|txt|csv|zip)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new ApiError(400, 'Unsupported file type'));
  },
});

// Known file signatures (magic bytes). Used to verify the bytes match the
// claimed type, defeating renamed-extension uploads.
const SIGNATURES = [
  { ext: /\.(png)$/i, bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: /\.(jpe?g)$/i, bytes: [0xff, 0xd8, 0xff] },
  { ext: /\.(gif)$/i, bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: /\.(pdf)$/i, bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: /\.(zip|docx|xlsx)$/i, bytes: [0x50, 0x4b] }, // Office docs are zip containers
];

// Verifies the saved file's leading bytes; deletes + rejects on mismatch.
// Plain-text formats (txt/csv/webp) are allowed through without a signature.
function verifyMagic(filePath, originalName) {
  const rule = SIGNATURES.find((s) => s.ext.test(originalName));
  if (!rule) return;
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(rule.bytes.length);
  fs.readSync(fd, buf, 0, rule.bytes.length, 0);
  fs.closeSync(fd);
  const ok = rule.bytes.every((b, i) => buf[i] === b);
  if (!ok) {
    fs.unlinkSync(filePath);
    throw ApiError.badRequest('File content does not match its extension');
  }
}

// POST /api/tickets/:id/attachments   (field name: "file")
export const uploadTicketAttachment = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  verifyMagic(req.file.path, req.file.originalname);
  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!ticket) throw ApiError.notFound('Ticket not found');

  const attachment = await prisma.attachment.create({
    data: {
      fileName: req.file.originalname,
      fileUrl: `/api/attachments/${req.file.filename}`,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      ticketId: ticket.id,
    },
  });
  await logActivity({ userId: req.user.id, action: 'UPLOAD', entity: 'Attachment', entityId: attachment.id });
  res.status(201).json({ success: true, data: attachment });
});

// POST /api/handovers/:id/attachments
export const uploadHandoverAttachment = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  verifyMagic(req.file.path, req.file.originalname);
  const handover = await prisma.handover.findUnique({ where: { id: req.params.id } });
  if (!handover) throw ApiError.notFound('Handover not found');

  const attachment = await prisma.attachment.create({
    data: {
      fileName: req.file.originalname,
      fileUrl: `/api/attachments/${req.file.filename}`,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      handoverId: handover.id,
    },
  });
  res.status(201).json({ success: true, data: attachment });
});

// GET /api/attachments/:filename — stream a stored file
export const downloadAttachment = asyncHandler(async (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) throw ApiError.notFound('File not found');
  res.sendFile(path.resolve(filePath));
});

// DELETE /api/attachments/:id — remove record + file
export const deleteAttachment = asyncHandler(async (req, res) => {
  const att = await prisma.attachment.findUnique({ where: { id: req.params.id } });
  if (!att) throw ApiError.notFound('Attachment not found');
  const filename = att.fileUrl.split('/').pop();
  const filePath = path.join(UPLOAD_DIR, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await prisma.attachment.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Attachment deleted' });
});
