/**
 * Photos for places, services and the hotel. The admin panel resizes images
 * in the browser (max 1600 px, JPEG/WebP) and posts them as a data URL, so the
 * server needs no image library. Files live in <dataDir>/uploads/<hotelId>/.
 *
 *   POST   /api/admin/upload  { dataUrl }  → { url }
 *   Static /uploads/<hotelId>/<file>
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 3 * 1024 * 1024;

export function createMedia({ dataDir }) {
  const root = path.join(dataDir, 'uploads');
  mkdirSync(root, { recursive: true });

  function save(hotelId, dataUrl) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw Object.assign(new Error('JPEG, PNG or WebP image required'), { status: 400 });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_BYTES) throw Object.assign(new Error('image too large (max 3 MB)'), { status: 413 });
    // Check magic bytes, not just the declared type.
    const ok = (m[1] === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'image/png' && buf[0] === 0x89 && buf[1] === 0x50) || (m[1] === 'image/webp' && buf.slice(8, 12).toString() === 'WEBP');
    if (!ok) throw Object.assign(new Error('file is not a valid image'), { status: 400 });
    const dir = path.join(root, hotelId.replace(/[^A-Za-z0-9_-]/g, ''));
    mkdirSync(dir, { recursive: true });
    const name = `${randomBytes(8).toString('hex')}.${TYPES[m[1]]}`;
    writeFileSync(path.join(dir, name), buf);
    return `/uploads/${path.basename(dir)}/${name}`;
  }

  function mount(app, { admin }) {
    app.post('/admin/upload', express.json({ limit: '5mb' }), admin, (req, res) => {
      try {
        res.status(201).json({ url: save(req.hotelId, req.body?.dataUrl) });
      } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
      }
    });
  }

  /** Static handler for the uploads folder (mounted at /uploads by the app). */
  const serve = express.static(root, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' });
  return { mount, serve, exists: (p) => existsSync(path.join(root, p)) };
}
