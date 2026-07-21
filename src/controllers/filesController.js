import multer from 'multer';
import fs from 'fs';
import path from 'path';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { env } from '../config/env.js';

// Memory storage — files are held in RAM then pushed to Supabase (or written to
// local disk) by the storage service. Keeps a single code path for both backends.
const memory = multer.memoryStorage();

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const DOC_RE = /\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i;

export const imageUpload = multer({
  storage: memory,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (IMAGE_RE.test(file.originalname) ? cb(null, true) : cb(new ApiError(400, 'File must be an image (PNG, JPG, GIF, WEBP)'))),
});

export const docUpload = multer({
  storage: memory,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (DOC_RE.test(file.originalname) ? cb(null, true) : cb(new ApiError(400, 'Unsupported file type'))),
});

// GET /api/files/:bucket/:filename — serves locally-stored files (fallback mode).
// When Supabase is in use, files are served straight from Supabase's public URL
// and this route is simply never hit.
export const serveLocalFile = asyncHandler(async (req, res) => {
  const bucket = path.basename(req.params.bucket);
  const filename = path.basename(req.params.filename);
  const filePath = path.join(env.uploadDir || 'uploads', bucket, filename);
  if (!fs.existsSync(filePath)) throw ApiError.notFound('File not found');
  res.sendFile(path.resolve(filePath));
});
