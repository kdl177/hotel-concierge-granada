#!/usr/bin/env node
/**
 * Emergency password reset from the server shell (when no SMTP is configured).
 *   npm run reset-password -- admin@hotel.local
 * Prints a temporary password; the user must change it at next sign-in and
 * every open session of that account is closed.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../server/app/db.js';
import { hashPassword } from '../server/app/auth.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Uso: npm run reset-password -- <email>');
  process.exit(1);
}
const db = openDatabase(process.env.CONCIERGE_DB || path.resolve(process.cwd(), 'data/concierge.sqlite'));
const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No existe ningún usuario ${email}`);
  process.exit(2);
}
const temp = `${randomBytes(9).toString('base64url')}7a`;
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, active = 1, session_version = session_version + 1 WHERE id = ?').run(hashPassword(temp), user.id);
console.log(`Contraseña temporal para ${email}: ${temp}\n(se pedirá cambiarla al entrar; sus sesiones abiertas se han cerrado)`);
