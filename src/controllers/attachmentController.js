import multer from 'multer';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import { notify } from '../services/notification.service.js';
import ApiError from '../utils/ApiError.js';
import { logActivity } from '../utils/activity.js';
import { ROLE_RANK } from '../middleware/rbac.js';
import { storeFile, deleteFile, keyFromUrl } from '../services/storage.service.js';

const MAX_MB = Number(process.env.MAX_FILE_SIZE_MB) || 25;

// Memory storage; the storage service pushes to Supabase or local disk.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new ApiError(400, 'Unsupported file type'));
  },
});

// Magic-byte signatures — verify bytes match the claimed extension (defeats
// renamed-extension uploads). Runs against the in-memory buffer.
const SIGNATURES = [
  { ext: /\.(png)$/i, bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: /\.(jpe?g)$/i, bytes: [0xff, 0xd8, 0xff] },
  { ext: /\.(gif)$/i, bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: /\.(pdf)$/i, bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: /\.(zip|docx|xlsx|pptx)$/i, bytes: [0x50, 0x4b] },
];
function verifyMagicBuffer(buffer, originalName) {
  const rule = SIGNATURES.find((s) => s.ext.test(originalName));
  if (!rule) return; // txt/csv/webp allowed through without signature
  const ok = rule.bytes.every((b, i) => buffer[i] === b);
  if (!ok) throw ApiError.badRequest('File content does not match its extension');
}

const isImage = (name) => /\.(png|jpe?g|gif|webp)$/i.test(name || '');

// Store the buffer in the right bucket for its context + type.
async function persist(file, ctx) {
  verifyMagicBuffer(file.buffer, file.originalname);
  const mediaType =
    ctx === 'ticket' ? (isImage(file.originalname) ? 'ticket-image' : 'ticket-document')
    : ctx === 'handover' ? 'asset-document'
    : ctx === 'note' ? (isImage(file.originalname) ? 'asset-image' : 'other-files')
    : 'other-files';
  return storeFile({ mediaType, buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype });
}

// POST /api/tickets/:id/attachments   (field name: "file")
export const uploadTicketAttachment = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!ticket) throw ApiError.notFound('Ticket not found');
  const { url, key } = await persist(req.file, 'ticket');

  const attachment = await prisma.attachment.create({
    data: { fileName: req.file.originalname, fileUrl: url, storageKey: key, mimeType: req.file.mimetype, sizeBytes: req.file.size, ticketId: ticket.id },
  });
  await logActivity({ userId: req.user.id, action: 'UPLOAD', entity: 'Attachment', entityId: attachment.id });
  res.status(201).json({ success: true, data: attachment });
});

// POST /api/handovers/:id/attachments — optional file on an asset handover
export const uploadHandoverAttachment = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  const handover = await prisma.handover.findUnique({
    where: { id: req.params.id },
    include: { assignment: { include: { asset: { select: { name: true, serialNumber: true } } } } },
  });
  if (!handover) throw ApiError.notFound('Handover not found');
  const { url, key } = await persist(req.file, 'handover');

  const attachment = await prisma.attachment.create({
    data: { fileName: req.file.originalname, fileUrl: url, storageKey: key, mimeType: req.file.mimetype, sizeBytes: req.file.size, handoverId: handover.id },
  });
  await logActivity({ userId: req.user.id, action: 'UPLOAD', entity: 'Attachment', entityId: attachment.id, metadata: { handoverId: handover.id } });

  if (handover.assignment && handover.assignment.employeeId !== req.user.id) {
    await notify({
      userId: handover.assignment.employeeId, type: 'ASSET',
      title: 'A document was added to your device',
      message: `${req.file.originalname} was attached to ${handover.assignment.asset?.name || 'your device'} (${handover.assignment.asset?.serialNumber || ''}).`,
      link: `/assignments/${handover.assignment.id}`, email: false,
    });
  }
  res.status(201).json({ success: true, data: attachment });
});

// POST /api/notes/:id/attachments — optional file on a personal note (owner only)
export const uploadNoteAttachment = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  const note = await prisma.note.findUnique({ where: { id: req.params.id } });
  if (!note || note.userId !== req.user.id) throw ApiError.notFound('Note not found');
  const { url, key } = await persist(req.file, 'note');

  const attachment = await prisma.attachment.create({
    data: { fileName: req.file.originalname, fileUrl: url, storageKey: key, mimeType: req.file.mimetype, sizeBytes: req.file.size, noteId: note.id },
  });
  res.status(201).json({ success: true, data: attachment });
});

// GET /api/attachments/:filename — resolve a stored file (ownership-checked).
// With Supabase, redirects to the public URL; locally, streams from disk.
export const downloadAttachment = asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  const isStaff = ROLE_RANK[req.user.role] >= ROLE_RANK.ICT_TECHNICIAN;

  const attachment = await prisma.attachment.findFirst({
    where: { fileUrl: { endsWith: `/${filename}` } },
    include: {
      ticket: { select: { requesterId: true } },
      handover: { include: { assignment: { select: { employeeId: true } } } },
      note: { select: { userId: true } },
    },
  });
  if (!attachment) throw ApiError.notFound('File not found');

  if (attachment.noteId) {
    if (attachment.note?.userId !== req.user.id) throw ApiError.forbidden('You do not have access to this file');
  } else if (!isStaff) {
    const ownsTicket = attachment.ticket && attachment.ticket.requesterId === req.user.id;
    const ownsHandover = attachment.handover?.assignment && attachment.handover.assignment.employeeId === req.user.id;
    if (!ownsTicket && !ownsHandover) throw ApiError.forbidden('You do not have access to this file');
  }

  // Supabase URLs are absolute — send the client there. Local files stream.
  if (/^https?:\/\//i.test(attachment.fileUrl)) return res.redirect(attachment.fileUrl);

  const fsMod = await import('fs');
  const pathMod = await import('path');
  const key = keyFromUrl(attachment.fileUrl); // bucket/filename
  const safe = key ? key.split('/').map((s) => pathMod.basename(s)).join('/') : pathMod.basename(filename);
  const filePath = pathMod.join(process.env.UPLOAD_DIR || 'uploads', safe);
  if (!fsMod.existsSync(filePath)) throw ApiError.notFound('File not found');
  res.sendFile(pathMod.resolve(filePath));
});

// DELETE /api/attachments/:id — remove record + stored file.
// Note attachments: owner only. Handover: ICT_ADMIN+. Ticket: ICT_TECHNICIAN+.
export const deleteAttachment = asyncHandler(async (req, res) => {
  const att = await prisma.attachment.findUnique({ where: { id: req.params.id } });
  if (!att) throw ApiError.notFound('Attachment not found');

  if (att.noteId) {
    const note = await prisma.note.findUnique({ where: { id: att.noteId }, select: { userId: true } });
    if (note?.userId !== req.user.id) throw ApiError.forbidden('You can only remove attachments from your own notes');
  } else if (att.handoverId) {
    if (ROLE_RANK[req.user.role] < ROLE_RANK.ICT_ADMIN) throw ApiError.forbidden('Only an ICT Admin or Super Admin can remove an assignment document');
  } else if (att.ticketId) {
    if (ROLE_RANK[req.user.role] < ROLE_RANK.ICT_TECHNICIAN) throw ApiError.forbidden('Only ICT staff can remove ticket attachments');
  }

  await deleteFile(att.storageKey || keyFromUrl(att.fileUrl));
  await prisma.attachment.delete({ where: { id: req.params.id } });
  await logActivity({ userId: req.user.id, action: 'DELETE', entity: 'Attachment', entityId: req.params.id, metadata: { fileName: att.fileName } });
  res.json({ success: true, message: 'Attachment deleted' });
});
