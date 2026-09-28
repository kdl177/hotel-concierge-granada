/**
 * Concierge application server: database, seed, bootstrap admin and the API
 * router. Shared by the Vite dev server (plugin) and the production entry.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { openDatabase, seedIfEmpty, uid } from './db.js';
import { hashPassword } from './auth.js';
import { createApi } from './api.js';
import { HOTEL, HOTEL_SERVICES, HOTEL_ACTIONS } from '../../src/concierge/data/hotel.js';
import { POIS } from '../../src/concierge/data/pois.js';

export function createConciergeApp({ env = process.env } = {}) {
  const dbFile = env.CONCIERGE_DB || path.resolve(process.cwd(), 'data/concierge.sqlite');
  const db = openDatabase(dbFile);

  const seeded = seedIfEmpty(db, { hotel: HOTEL, services: HOTEL_SERVICES, actions: HOTEL_ACTIONS, pois: POIS });
  if (seeded) console.log(`[concierge] seeded first hotel "${HOTEL.name}" (slug ${HOTEL.id}) into ${dbFile}`);

  // First superadmin: from env, or a default local account (printed once).
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (users === 0) {
    const email = (env.ADMIN_EMAIL || 'admin@hotel.local').toLowerCase();
    const password = env.ADMIN_PASSWORD || 'admin1234';
    db.prepare('INSERT INTO users (id, hotel_id, email, password_hash, name, role) VALUES (?,?,?,?,?,?)').run(
      uid(), db.prepare('SELECT id FROM hotels ORDER BY created_at LIMIT 1').get()?.id || null, email, hashPassword(password), 'Superadmin', 'superadmin',
    );
    console.log(`[concierge] created superadmin ${email}${env.ADMIN_PASSWORD ? '' : ' (password: admin1234 — change it in the admin panel)'}`);
  }

  let secret = env.CONCIERGE_SECRET;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    if (env.NODE_ENV === 'production') console.warn('[concierge] CONCIERGE_SECRET not set: sessions reset on every restart');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use('/api', createApi({ db, secret, secureCookies: env.NODE_ENV === 'production' && !env.CONCIERGE_INSECURE_COOKIES, publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, '') }));
  return { app, db };
}
