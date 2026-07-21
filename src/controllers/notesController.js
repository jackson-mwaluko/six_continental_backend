import fs from 'fs';
import path from 'path';
import prisma from '../config/prisma.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// Every route here is strictly scoped to the signed-in user — notes are
// private; there is no admin visibility into another user's notes or files.

// GET /api/notes — mine, optionally filtered by type/done, pinned first
export const listNotes = asyncHandler(async (req, res) => {
  const { type, isDone } = req.query;
  const notes = await prisma.note.findMany({
    where: {
      userId: req.user.id,
      ...(type && { type }),
      ...(isDone !== undefined && { isDone: isDone === 'true' }),
    },
    include: { attachments: true },
    orderBy: [{ isPinned: 'desc' }, { reminderAt: 'asc' }, { updatedAt: 'desc' }],
  });
  res.json({ success: true, data: notes });
});

// POST /api/notes
export const createNote = asyncHandler(async (req, res) => {
  const { type, title, body, reminderAt, isPinned } = req.body;
  const note = await prisma.note.create({
    data: {
      userId: req.user.id,
      type: type === 'TODO' ? 'TODO' : 'NOTE',
      title: title.trim(),
      body: body?.trim() || null,
      reminderAt: reminderAt ? new Date(reminderAt) : null,
      isPinned: !!isPinned,
    },
    include: { attachments: true },
  });
  res.status(201).json({ success: true, data: note });
});

// PATCH /api/notes/:id
export const updateNote = asyncHandler(async (req, res) => {
  const existing = await prisma.note.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.user.id) throw ApiError.notFound('Note not found');

  const data = {};
  for (const k of ['title', 'body', 'type', 'isPinned', 'isDone']) {
    if (req.body[k] !== undefined) data[k] = req.body[k];
  }
  if (req.body.reminderAt !== undefined) {
    data.reminderAt = req.body.reminderAt ? new Date(req.body.reminderAt) : null;
    // Changing the reminder time re-arms it so a new notification will fire.
    data.reminderSent = false;
  }
  if (data.title) data.title = data.title.trim();

  const note = await prisma.note.update({ where: { id: req.params.id }, data, include: { attachments: true } });
  res.json({ success: true, data: note });
});

// DELETE /api/notes/:id — also removes any attached files from disk
export const deleteNote = asyncHandler(async (req, res) => {
  const existing = await prisma.note.findUnique({ where: { id: req.params.id }, include: { attachments: true } });
  if (!existing || existing.userId !== req.user.id) throw ApiError.notFound('Note not found');

  if (existing.attachments.length) {
    for (const att of existing.attachments) {
      const filePath = path.join(UPLOAD_DIR, att.fileUrl.split('/').pop());
      if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    }
  }

  await prisma.note.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: 'Note deleted' });
});
