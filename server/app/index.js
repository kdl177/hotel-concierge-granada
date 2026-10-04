/**
 * Concierge application server: database, seed, bootstrap admin and the API
 * router. Shared by the Vite dev server (plugin) and the production entry.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { openDatabase, seedIfEmpty, uid } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { securityHeaders, sameOrigin } from './security.js';
import { createApi } from './api.js';
import { HOTEL, HOTEL_SERVICES, HOTEL_ACTIONS } from '../../src/concierge/data/hotel.js';
import { POIS } from '../../src/concierge/data/pois.js';

export function createConciergeApp({ env = process.env, mailer, fetchImpl } = {}) {
  const dbFile = env.CONCIERGE_DB || path.resolve(process.cwd(), 'data/concierge.sqlite');
  const db = openDatabase(dbFile);

  const seeded = seedIfEmpty(db, { hotel: HOTEL, services: HOTEL_SERVICES, actions: HOTEL_ACTIONS, pois: POIS });
  if (seeded) console.log(`[concierge] seeded first hotel "${HOTEL.name}" (slug ${HOTEL.id}) into ${dbFile}`);

  // One-time fix: early seeds placed the Gran Hotel Luna ~350 m off. Only rows
  // still holding that exact old value are corrected; edits made in Admin stay.
  const fixed = db.prepare('UPDATE hotels SET lat = ?, lon = ? WHERE slug = ? AND lat = 37.1737 AND lon = -3.6095').run(HOTEL.lat, HOTEL.lon, HOTEL.id);
  if (fixed.changes) console.log(`[concierge] corrected coordinates of ${HOTEL.name}`);

  // First superadmin: from env; otherwise "admin1234" in development or a random
  // one-time password in production. Either way it must be changed on first login.
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const production = env.NODE_ENV === 'production';
  if (users === 0) {
    const email = (env.ADMIN_EMAIL || 'admin@hotel.local').toLowerCase();
    const password = env.ADMIN_PASSWORD || (production ? randomBytes(9).toString('base64url') + '7' : 'admin1234');
    db.prepare('INSERT INTO users (id, hotel_id, email, password_hash, name, role, must_change_password) VALUES (?,?,?,?,?,?,1)').run(
      uid(), db.prepare('SELECT id FROM hotels ORDER BY created_at LIMIT 1').get()?.id || null, email, hashPassword(password), 'Superadmin', 'superadmin',
    );
    console.log(`[concierge] created superadmin ${email}${env.ADMIN_PASSWORD ? '' : ` — temporary password: ${password} (you will be asked to change it)`}`);
  }
  // Accounts still on the old default password are forced to change it.
  for (const u of db.prepare('SELECT id, email, password_hash FROM users WHERE must_change_password = 0 AND role IN (\'superadmin\',\'admin\')').all()) {
    if (verifyPassword('admin1234', u.password_hash)) {
      db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(u.id);
      console.warn(`[concierge] ${u.email} still uses the default password: a change will be required at next sign-in`);
    }
  }

  let secret = env.CONCIERGE_SECRET;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    if (production) console.warn('[concierge] CONCIERGE_SECRET not set: sessions reset on every restart');
  }

  const app = express();
  app.disable('x-powered-by');
  // Only trust X-Forwarded-* from the reverse proxy (Caddy on the same host or Docker network).
  app.set('trust proxy', env.TRUST_PROXY || 'loopback, uniquelocal');
  app.use(securityHeaders({ production }));
  const dataDir = dbFile === ':memory:' ? path.resolve(process.cwd(), 'data') : path.dirname(dbFile);
  const api = createApi({ db, env, mailer, fetchImpl, secret, secureCookies: production && !env.CONCIERGE_INSECURE_COOKIES, publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''), dataDir });
  app.use('/uploads', api.media.serve);
  app.use('/api', sameOrigin, api);
  return { app, db };
}
