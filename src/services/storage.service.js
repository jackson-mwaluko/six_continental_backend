import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { env } from '../config/env.js';

/*
 * Storage abstraction. Every upload in the app goes through here so we can swap
 * the backing store without touching controllers.
 *
 * - When Supabase is configured (SUPABASE_URL + SUPABASE_SERVICE_KEY), files are
 *   uploaded to the bucket that matches their MEDIA TYPE (see BUCKETS below).
 * - Otherwise it falls back to the local uploads/ directory so the app keeps
 *   working out of the box (and in dev) with zero config.
 *
 * The public URL returned is what gets stored on the record (e.g. asset.imageUrl).
 * For Supabase, that's the object's public URL; for local, it's an /api/... path
 * served by our own routes.
 */

// media type -> Supabase bucket name. Create these buckets in your project.
export const BUCKETS = {
  'asset-image': 'asset-image',
  'asset-document': 'asset-document',
  'user-avatar': 'user-avatar',
  'ticket-image': 'ticket-image',
  'ticket-document': 'ticket-document',
  'qr-code': 'qr-code',
  'company-logo': 'company-logo',
  'other-files': 'other-files',
};

const supaEnabled = () => !!(env.supabase?.url && env.supabase?.serviceKey);

// Lazily create the Supabase client only if configured (keeps the dep optional).
let _client = null;
async function getClient() {
  if (_client) return _client;
  const { createClient } = await import('@supabase/supabase-js');
  _client = createClient(env.supabase.url, env.supabase.serviceKey, {
    auth: { persistSession: false },
  });
  return _client;
}

function safeName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stamp = Date.now();
  const rand = crypto.randomBytes(6).toString('hex');
  return `${stamp}-${rand}${ext}`;
}

/**
 * Store a file buffer under the bucket for the given media type.
 * @param {Object} p
 * @param {'asset-image'|'asset-document'|'user-avatar'|'ticket-image'|'ticket-document'|'qr-code'|'other-files'} p.mediaType
 * @param {Buffer} p.buffer
 * @param {string} p.originalName
 * @param {string} [p.mimeType]
 * @returns {Promise<{ url: string, key: string, storage: 'supabase'|'local' }>}
 */
export async function storeFile({ mediaType, buffer, originalName, mimeType }) {
  const bucket = BUCKETS[mediaType] || BUCKETS['other-files'];
  const filename = safeName(originalName);

  if (supaEnabled()) {
    const client = await getClient();
    const objectPath = filename; // flat within the bucket; bucket already segments by type
    const { error } = await client.storage.from(bucket).upload(objectPath, buffer, {
      contentType: mimeType || 'application/octet-stream',
      upsert: false,
    });
    if (error) throw new Error(`Supabase upload failed (${bucket}): ${error.message}`);
    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
    return { url: data.publicUrl, key: `${bucket}/${objectPath}`, storage: 'supabase' };
  }

  // ── Local fallback ──
  const LOCAL_ROOT = env.uploadDir || 'uploads';
  const dir = path.join(LOCAL_ROOT, bucket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buffer);
  // Served by our own route (see routes: /api/files/:bucket/:filename)
  return { url: `/api/files/${bucket}/${filename}`, key: `${bucket}/${filename}`, storage: 'local' };
}

/** Remove a previously stored file by its key ("bucket/filename"). Best-effort. */
export async function deleteFile(key) {
  if (!key) return;
  const [bucket, ...rest] = key.split('/');
  const objectPath = rest.join('/');
  if (!bucket || !objectPath) return;

  if (supaEnabled()) {
    try {
      const client = await getClient();
      await client.storage.from(bucket).remove([objectPath]);
    } catch { /* best effort */ }
    return;
  }
  const LOCAL_ROOT = env.uploadDir || 'uploads';
  const p = path.join(LOCAL_ROOT, bucket, objectPath);
  if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
}

/** Derive the storage key from a stored URL, for either backend. */
export function keyFromUrl(url) {
  if (!url) return null;
  // Local: /api/files/<bucket>/<filename>
  const local = url.match(/\/api\/files\/([^/]+)\/([^/?#]+)/);
  if (local) return `${local[1]}/${local[2]}`;
  // Supabase public: .../object/public/<bucket>/<filename>
  const supa = url.match(/\/object\/public\/([^/]+)\/([^/?#]+)/);
  if (supa) return `${supa[1]}/${supa[2]}`;
  return null;
}

export function usingSupabase() { return supaEnabled(); }
