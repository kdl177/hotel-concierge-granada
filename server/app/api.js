/**
 * Hotel concierge API (Express). Mounted by the Vite dev server in development
 * and by server/app/main.js in production.
 *
 *   Guest (public, per hotel slug)
 *     GET  /api/h/:slug/config                hotel + services + actions + pois
 *     GET  /api/h/:slug/room/:token           room identified by QR → { room, stay }
 *     POST /api/h/:slug/requests              new request
 *     GET  /api/h/:slug/requests?ids=a,b      status of the guest's own requests
 *   Auth
 *     POST /api/auth/login  { email, password }   POST /api/auth/logout   GET /api/auth/me
 *     POST /api/auth/password { current, next }
 *   Staff (reception/admin of the hotel)
 *     GET  /api/staff/requests?status=open|all&q=   PATCH /api/staff/requests/:id { status, note, assignedTo }
 *     GET  /api/staff/requests/:id/events           GET /api/staff/users
 *     GET  /api/staff/stays  POST /api/staff/stays  PATCH /api/staff/stays/:id
 *   Admin (hotel admin)
 *     GET/PUT /api/admin/hotel
 *     GET/POST/PUT/DELETE /api/admin/{services|actions|pois|rooms|users}[/:id]
 *     GET /api/admin/rooms/:id/qr.svg
 *   Superadmin
 *     GET/POST /api/super/hotels    PATCH /api/super/hotels/:id
 */
import express from 'express';
import QRCode from 'qrcode';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, createSessions } from './auth.js';
import { createLimiter, limit, clientIp, safeIcon, safePhone, safeUrl, checkWebhookUrl, EMAIL_RE } from './security.js';
import { uid, token as newToken, J, P, hotelPublic, serviceRow, actionRow, poiRow, requestRow } from './db.js';
import { createNotifier } from './notify.js';
import { createChat } from './chat.js';
import { createWeather } from './weather.js';
import { createMedia } from './media.js';
import { createStats } from './stats.js';
import { createTransit } from './gtfs.js';

const LANGS = ['es', 'en', 'fr', 'de'];
const STATUSES = ['pending', 'confirmed', 'done', 'rejected'];
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const num = (v, d = 0) => (v !== '' && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, num(v, d)));
const lat = (v, d) => { const n = num(v, NaN); return n >= -90 && n <= 90 ? n : d; };
const lon = (v, d) => { const n = num(v, NaN); return n >= -180 && n <= 180 ? n : d; };
const FIELDS = ['when', 'people', 'destination', 'details'];
const MODES = ['walk', 'bike', 'transit'];
const MIN_PASSWORD = 10;
/** Translated text object {es,en,fr,de} with bounded strings only. */
const i18nObj = (v, max = 300) => Object.fromEntries(LANGS.filter((l) => v && typeof v === 'object' && v[l] != null).map((l) => [l, clean(v[l], max)]));
const i18nList = (v) => Object.fromEntries(LANGS.filter((l) => Array.isArray(v?.[l])).map((l) => [l, v[l].slice(0, 20).map((x) => clean(x, 200)).filter(Boolean)]));
/** POI action buttons: url | request | tel | mode — validated so nothing executes. */
function poiActions(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).map((a) => {
    const out = { icon: safeIcon(a?.icon, 'open_in_new'), label: i18nObj(a?.label, 80) };
    const url = safeUrl(a?.url);
    if (url) out.url = url;
    else if (a?.request) out.request = clean(a.request, 30).replace(/[^a-z0-9_-]/gi, '');
    else if (a?.tel) out.tel = true;
    else if (MODES.includes(a?.mode)) out.mode = a.mode;
    else return null;
    return out;
  }).filter(Boolean);
}
const weekly = (v) => (Array.isArray(v) ? v.slice(0, 14).map((x) => ({ days: Array.isArray(x?.days) ? x.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [], from: /^\d{2}:\d{2}$/.test(x?.from) ? x.from : '00:00', to: /^\d{2}:\d{2}$/.test(x?.to) ? x.to : '23:59' })) : null);
const passwordProblem = (p) => {
  const s = String(p || '');
  if (s.length < MIN_PASSWORD) return `min ${MIN_PASSWORD} characters`;
  if (s.length > 200) return 'too long';
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return 'use letters and numbers';
  return '';
};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createApi({ db, secret, secureCookies = false, publicUrl = '', dataDir = 'data', fetchImpl, env = process.env, mailer }) {
  const app = express.Router();
  const sessions = createSessions({ secret });
  const notifier = createNotifier(mailer ? { mailer } : {});
  const production = env.NODE_ENV === 'production';
  // Brute-force protection: per IP and per account (failed attempts only).
  const loginIp = createLimiter({ windowMs: 15 * 60_000, max: 30 });
  const loginFail = createLimiter({ windowMs: 15 * 60_000, max: 5 }); // per IP + account
  const loginFailAccount = createLimiter({ windowMs: 15 * 60_000, max: 25 }); // per account, any IP
  const forgotLimiter = createLimiter({ windowMs: 60 * 60_000, max: 5 });
  const guestReq = createLimiter({ windowMs: 60_000, max: 6 });
  const guestReqDay = createLimiter({ windowMs: 24 * 3600_000, max: 60 });
  const jsonSmall = express.json({ limit: '256kb' });
  // Photo uploads carry their own, larger body limit (see media.js).
  app.use((req, res, next) => (req.path === '/admin/upload' ? next() : jsonSmall(req, res, next)));
  const chat = createChat({ db });
  const weather = createWeather(fetchImpl ? { fetchImpl } : {});
  const media = createMedia({ dataDir });
  const stats = createStats({ db });
  const transit = createTransit({ dataDir });

  // ---------- helpers ----------
  const hotelBySlugStmt = db.prepare('SELECT * FROM hotels WHERE slug = ? AND active = 1');
  const firstHotel = db.prepare('SELECT * FROM hotels WHERE active = 1 ORDER BY created_at LIMIT 1');
  const hotelBySlug = { get: (slug) => (slug === 'default' || !slug ? firstHotel.get() : hotelBySlugStmt.get(slug)) };
  const hotelById = db.prepare('SELECT * FROM hotels WHERE id = ?');
  const userById = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1');

  function currentUser(req) {
    const data = sessions.read(sessions.cookieFrom(req));
    if (!data) return null;
    const user = userById.get(data.uid);
    // Password change / "sign out everywhere" bumps session_version → old cookies die.
    if (!user || (user.session_version || 0) !== (data.sv || 0)) return null;
    return user;
  }
  function requireRole(...roles) {
    return (req, res, next) => {
      const user = currentUser(req);
      if (!user) return res.status(401).json({ error: 'auth required' });
      if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'forbidden' });
      if (user.must_change_password) return res.status(403).json({ error: 'password change required', code: 'must_change_password' });
      req.user = user;
      // Superadmin can act on any hotel via ?hotel=<id>; others are bound to theirs.
      req.hotelId = user.role === 'superadmin' ? clean(req.query.hotel || req.headers['x-hotel'] || user.hotel_id || '', 40) : user.hotel_id;
      if (!req.hotelId) return res.status(400).json({ error: 'hotel required' });
      if (!hotelById.get(req.hotelId)) return res.status(404).json({ error: 'hotel not found' });
      next();
    };
  }
  /** Signed in, even if a password change is still pending (for /auth/password). */
  function signedIn(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'auth required' });
    req.user = user;
    next();
  }
  function logEvent(requestId, userId, event, detail = '') {
    db.prepare('INSERT INTO request_events (request_id, user_id, event, detail) VALUES (?,?,?,?)').run(requestId, userId, event, detail);
  }
  function requestWithAssignee(id) {
    return db.prepare(`SELECT r.*, u.name AS assigned_name FROM requests r LEFT JOIN users u ON u.id = r.assigned_to WHERE r.id = ?`).get(id);
  }

  // ---------- guest ----------
  app.get('/h/:slug/config', (req, res) => {
    const h = hotelBySlug.get(req.params.slug);
    if (!h) return res.status(404).json({ error: 'hotel not found' });
    const services = db.prepare('SELECT * FROM services WHERE hotel_id = ? AND active = 1 ORDER BY sort, rowid').all(h.id).map(serviceRow);
    const actions = db.prepare('SELECT * FROM actions WHERE hotel_id = ? AND active = 1 ORDER BY sort, rowid').all(h.id).map(actionRow);
    // Guests reference places by their stable key (plans and checklists are saved on the device).
    const pois = db.prepare('SELECT * FROM pois WHERE hotel_id = ? AND active = 1 ORDER BY sort, rowid').all(h.id).map((r) => ({ ...poiRow(r), id: r.key }));
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ hotel: hotelPublic(h), services, actions, pois });
  });

  app.get('/h/:slug/room/:token', (req, res) => {
    const h = hotelBySlug.get(req.params.slug);
    if (!h) return res.status(404).json({ error: 'hotel not found' });
    const room = db.prepare('SELECT * FROM rooms WHERE hotel_id = ? AND token = ? AND active = 1').get(h.id, req.params.token);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const stay = db.prepare(`SELECT * FROM stays WHERE room_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(room.id) || null;
    res.json({ room: { id: room.id, number: room.number, floor: room.floor }, stay: stay && { id: stay.id, guestName: stay.guest_name, lang: stay.lang, checkout: stay.checkout } });
  });

  const guestBucket = (req) => `${clientIp(req)}|${clean(req.body?.guestKey, 64)}`;
  app.post('/h/:slug/requests', limit(guestReq, guestBucket, 'too many requests, try again in a minute'), limit(guestReqDay, (req) => clientIp(req), 'daily request limit reached'), async (req, res) => {
    const h = hotelBySlug.get(req.params.slug);
    if (!h) return res.status(404).json({ error: 'hotel not found' });
    const b = req.body || {};
    const room = clean(b.room, 12);
    if (!room) return res.status(400).json({ error: 'room required' });
    if (!/^[\p{L}\p{N} ._-]{1,12}$/u.test(room)) return res.status(400).json({ error: 'invalid room' });
    const type = clean(b.type, 40).replace(/[^a-z0-9_-]/gi, '') || 'other';
    let stayId = null;
    if (b.roomToken) {
      const r = db.prepare('SELECT id FROM rooms WHERE hotel_id = ? AND token = ?').get(h.id, clean(b.roomToken, 40));
      const s = r && db.prepare(`SELECT id FROM stays WHERE room_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(r.id);
      stayId = s?.id || null;
    }
    const id = uid();
    const lang = LANGS.includes(b.lang) ? b.lang : 'es';
    const guestKey = chat.validKey(b.guestKey) ? b.guestKey : '';
    if (guestKey && chat.isBlocked(guestKey)) return res.status(403).json({ error: 'blocked' });
    db.prepare(`INSERT INTO requests (id, hotel_id, stay_id, room, type, name, when_at, details, lang, guest_key) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, h.id, stayId, room, type, clean(b.name, 80), clean(b.when, 40), clean(b.details, 1000), lang, guestKey,
    );
    logEvent(id, null, 'created');
    if (guestKey && chat.ensure({ key: guestKey, hotelId: h.id, room, name: clean(b.name, 80), stayId, lang })) {
      // Shown to both sides as "New request: …"; guest's own copy stays read.
      chat.post({ key: guestKey, hotelId: h.id, author: 'system', requestId: id, body: 'created' });
      db.prepare('UPDATE conversations SET unread_guest = MAX(0, unread_guest - 1), unread_staff = unread_staff + 1 WHERE key = ?').run(guestKey);
    }
    const request = requestRow(requestWithAssignee(id));
    notifier.send({ event: 'created', hotel: hotelPublic(h), hotelRow: h, request });
    res.status(201).json({ request });
  });

  app.get('/h/:slug/requests', (req, res) => {
    const h = hotelBySlug.get(req.params.slug);
    if (!h) return res.status(404).json({ error: 'hotel not found' });
    const ids = clean(req.query.ids, 400).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
    // A request is only visible to the device that made it (its anonymous guest key).
    const key = clean(req.query.key, 64);
    if (!ids.length || !chat.validKey(key)) return res.json({ requests: [] });
    const rows = db.prepare(`SELECT r.*, u.name AS assigned_name FROM requests r LEFT JOIN users u ON u.id = r.assigned_to WHERE r.hotel_id = ? AND r.guest_key = ? AND r.id IN (${ids.map(() => '?').join(',')})`).all(h.id, key, ...ids);
    res.json({ requests: rows.map(requestRow) });
  });

  // ---------- auth ----------
  const tooMany = (res, s) => {
    res.setHeader('Retry-After', String(s));
    return res.status(429).json({ error: 'too many attempts', retryAfter: s });
  };
  app.post('/auth/login', (req, res) => {
    const email = clean(req.body?.email, 120).toLowerCase();
    const ip = clientIp(req);
    const lockedFor = loginFailAccount.blocked(email) || loginFail.blocked(`${ip}|${email}`);
    if (lockedFor) return tooMany(res, lockedFor);
    const ipHit = loginIp.hit(ip);
    if (!ipHit.ok) return tooMany(res, ipHit.retryAfterS);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    // Always run scrypt so response time doesn't reveal whether the email exists.
    const ok = verifyPassword(req.body?.password, user?.password_hash || 'scrypt$00$00');
    if (!user || !ok) {
      loginFailAccount.hit(email);
      loginFail.hit(`${ip}|${email}`);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    loginFail.reset(`${ip}|${email}`);
    db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
    sessions.setCookie(res, sessions.issue(user), { secure: secureCookies });
    res.json({ user: publicUser(user) });
  });
  app.post('/auth/logout', (req, res) => {
    sessions.clearCookie(res);
    res.json({ ok: true });
  });
  /** Signs out every device of this account (bumps the session version). */
  app.post('/auth/logout-all', signedIn, (req, res) => {
    db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(req.user.id);
    sessions.clearCookie(res);
    res.json({ ok: true });
  });
  app.get('/auth/me', (req, res) => {
    const user = currentUser(req);
    // "Not signed in" is a normal state for the login screen, not an error.
    if (!user) return res.json({ user: null });
    const hotel = user.hotel_id ? hotelById.get(user.hotel_id) : null;
    res.json({ user: publicUser(user), hotel: hotel && hotelPublic(hotel) });
  });
  app.get('/auth/options', (req, res) => res.json({ emailReset: notifier.canMail(), minPassword: MIN_PASSWORD }));
  app.post('/auth/password', signedIn, (req, res) => {
    if (!verifyPassword(req.body?.current, req.user.password_hash)) return res.status(400).json({ error: 'wrong password' });
    const next = String(req.body?.next || '');
    const problem = passwordProblem(next);
    if (problem) return res.status(400).json({ error: problem });
    if (verifyPassword(next, req.user.password_hash)) return res.status(400).json({ error: 'new password must be different' });
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?').run(hashPassword(next), req.user.id);
    // Other devices are signed out; this one gets a fresh cookie.
    sessions.setCookie(res, sessions.issue(userById.get(req.user.id)), { secure: secureCookies });
    res.json({ ok: true });
  });
  // Password recovery by e-mail: single-use token (only its hash is stored), 30 min.
  app.post('/auth/forgot', limit(forgotLimiter, (req) => clientIp(req), 'too many attempts'), async (req, res) => {
    const email = clean(req.body?.email, 120).toLowerCase();
    const user = EMAIL_RE.test(email) ? db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email) : null;
    if (user && notifier.canMail()) {
      const raw = randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(user.id, Date.now());
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(raw), user.id, Date.now() + 30 * 60_000);
      const base = publicUrl || `${req.protocol}://${req.get('host')}`;
      notifier.mail({
        to: user.email,
        subject: 'Restablecer tu contraseña · Concierge',
        text: `Hola ${user.name || ''},\n\nPara crear una contraseña nueva abre este enlace (válido 30 minutos, un solo uso):\n${base}/admin.html#reset=${raw}\n\nSi no lo has pedido tú, ignora este mensaje.`,
      });
    }
    // Same answer whether or not the account exists.
    res.json({ ok: true, emailReset: notifier.canMail() });
  });
  app.post('/auth/reset', limit(forgotLimiter, (req) => `r:${clientIp(req)}`, 'too many attempts'), (req, res) => {
    const raw = clean(req.body?.token, 100);
    const row = raw && db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(raw));
    if (!row || row.used_at || row.expires_at < Date.now()) return res.status(400).json({ error: 'invalid or expired link' });
    const problem = passwordProblem(req.body?.password);
    if (problem) return res.status(400).json({ error: problem });
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?').run(hashPassword(req.body.password), row.user_id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(Date.now(), row.token_hash);
    res.json({ ok: true });
  });
  function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, hotelId: u.hotel_id, mustChangePassword: !!u.must_change_password, lastLoginAt: u.last_login_at || null };
  }

  // ---------- staff (reception) ----------
  const staff = requireRole('superadmin', 'admin', 'reception', 'staff');
  app.get('/staff/requests', staff, (req, res) => {
    const status = clean(req.query.status, 10) || 'open';
    const q = clean(req.query.q, 60);
    const where = ['r.hotel_id = ?'];
    const args = [req.hotelId];
    if (status === 'open') where.push(`r.status IN ('pending','confirmed')`);
    else if (STATUSES.includes(status)) { where.push('r.status = ?'); args.push(status); }
    if (q) { where.push('(r.room LIKE ? OR r.name LIKE ? OR r.details LIKE ? OR r.type LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    const rows = db.prepare(`SELECT r.*, u.name AS assigned_name FROM requests r LEFT JOIN users u ON u.id = r.assigned_to WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 300`).all(...args);
    const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM requests WHERE hotel_id = ? GROUP BY status`).all(req.hotelId);
    res.json({ requests: rows.map(requestRow), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
  });
  app.patch('/staff/requests/:id', staff, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id = ? AND hotel_id = ?').get(req.params.id, req.hotelId);
    if (!r) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const toGuest = r.guest_key && db.prepare('SELECT 1 FROM conversations WHERE key = ? AND hotel_id = ?').get(r.guest_key, req.hotelId);
    if (STATUSES.includes(b.status) && b.status !== r.status) {
      db.prepare(`UPDATE requests SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(b.status, r.id);
      logEvent(r.id, req.user.id, 'status', b.status);
      chat.markFirstResponse(r.id);
      if (toGuest) chat.post({ key: r.guest_key, hotelId: req.hotelId, author: 'system', requestId: r.id, body: `status:${b.status}` });
    }
    if (b.note !== undefined && clean(b.note) !== r.note) {
      db.prepare(`UPDATE requests SET note = ?, updated_at = datetime('now') WHERE id = ?`).run(clean(b.note), r.id);
      logEvent(r.id, req.user.id, 'note', clean(b.note));
      chat.markFirstResponse(r.id);
      if (toGuest && clean(b.note)) chat.post({ key: r.guest_key, hotelId: req.hotelId, author: 'staff', userId: req.user.id, requestId: r.id, body: clean(b.note) });
    }
    if (b.assignedTo !== undefined) {
      const assignee = b.assignedTo ? db.prepare('SELECT id, name FROM users WHERE id = ? AND hotel_id = ?').get(b.assignedTo, req.hotelId) : null;
      db.prepare(`UPDATE requests SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?`).run(assignee?.id || null, r.id);
      logEvent(r.id, req.user.id, 'assigned', assignee?.name || '');
    }
    if (b.comment) logEvent(r.id, req.user.id, 'comment', clean(b.comment));
    const updated = requestRow(requestWithAssignee(r.id));
    const h = hotelById.get(req.hotelId);
    if (b.status && b.status !== r.status) notifier.send({ event: 'updated', hotel: hotelPublic(h), hotelRow: h, request: updated });
    res.json({ request: updated });
  });
  app.get('/staff/requests/:id/events', staff, (req, res) => {
    const rows = db.prepare(`SELECT e.*, u.name AS user_name FROM request_events e LEFT JOIN users u ON u.id = e.user_id JOIN requests r ON r.id = e.request_id WHERE e.request_id = ? AND r.hotel_id = ? ORDER BY e.id`).all(req.params.id, req.hotelId);
    res.json({ events: rows.map((e) => ({ id: e.id, event: e.event, detail: e.detail, at: e.at, user: e.user_name || null })) });
  });
  app.get('/staff/users', staff, (req, res) => {
    res.json({ users: db.prepare('SELECT id, name, email, role FROM users WHERE hotel_id = ? AND active = 1 ORDER BY name').all(req.hotelId) });
  });
  app.get('/staff/stays', staff, (req, res) => {
    const rows = db.prepare(`SELECT s.*, r.number AS room_number, r.token AS room_token FROM stays s LEFT JOIN rooms r ON r.id = s.room_id WHERE s.hotel_id = ? ORDER BY s.status = 'active' DESC, s.created_at DESC LIMIT 300`).all(req.hotelId);
    res.json({ stays: rows.map(stayRow) });
  });
  app.post('/staff/stays', staff, (req, res) => {
    const b = req.body || {};
    const room = db.prepare('SELECT * FROM rooms WHERE hotel_id = ? AND (id = ? OR number = ?)').get(req.hotelId, clean(b.roomId, 12), clean(b.room, 12));
    if (!room) return res.status(400).json({ error: 'room not found' });
    db.prepare(`UPDATE stays SET status = 'closed' WHERE room_id = ? AND status = 'active'`).run(room.id);
    const id = uid();
    db.prepare(`INSERT INTO stays (id, hotel_id, room_id, guest_name, guests, lang, code, checkin, checkout, status) VALUES (?,?,?,?,?,?,?,?,?,'active')`).run(
      id, req.hotelId, room.id, clean(b.guestName, 80), clamp(b.guests, 1, 20, 1), LANGS.includes(b.lang) ? b.lang : 'es', clean(b.code, 40), clean(b.checkin, 20), clean(b.checkout, 20),
    );
    res.status(201).json({ stay: stayRow(db.prepare(`SELECT s.*, r.number AS room_number, r.token AS room_token FROM stays s LEFT JOIN rooms r ON r.id = s.room_id WHERE s.id = ?`).get(id)) });
  });
  app.patch('/staff/stays/:id', staff, (req, res) => {
    const s = db.prepare('SELECT * FROM stays WHERE id = ? AND hotel_id = ?').get(req.params.id, req.hotelId);
    if (!s) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (['upcoming', 'active', 'closed'].includes(b.status)) db.prepare('UPDATE stays SET status = ? WHERE id = ?').run(b.status, s.id);
    if (b.guestName !== undefined) db.prepare('UPDATE stays SET guest_name = ? WHERE id = ?').run(clean(b.guestName, 80), s.id);
    if (b.checkout !== undefined) db.prepare('UPDATE stays SET checkout = ? WHERE id = ?').run(clean(b.checkout, 20), s.id);
    res.json({ stay: stayRow(db.prepare(`SELECT s.*, r.number AS room_number, r.token AS room_token FROM stays s LEFT JOIN rooms r ON r.id = s.room_id WHERE s.id = ?`).get(s.id)) });
  });
  function stayRow(s) {
    return { id: s.id, roomId: s.room_id, room: s.room_number, roomToken: s.room_token, guestName: s.guest_name, guests: s.guests, lang: s.lang, code: s.code, checkin: s.checkin, checkout: s.checkout, status: s.status, createdAt: s.created_at };
  }

  // ---------- admin (hotel) ----------
  const admin = requireRole('superadmin', 'admin');
  app.get('/admin/hotel', admin, (req, res) => {
    const h = hotelById.get(req.hotelId);
    res.json({ hotel: { ...hotelPublic(h), webhookUrl: h.webhook_url, notifyEmail: h.notify_email, active: !!h.active } });
  });
  app.put('/admin/hotel', admin, async (req, res) => {
    const b = req.body || {};
    const h = hotelById.get(req.hotelId);
    const hook = await checkWebhookUrl(b.webhookUrl, { production });
    if (!hook.ok) return res.status(400).json({ error: `webhook: ${hook.error}` });
    if (clean(b.notifyEmail) && !EMAIL_RE.test(clean(b.notifyEmail, 120))) return res.status(400).json({ error: 'invalid notification e-mail' });
    if (clean(b.email) && !EMAIL_RE.test(clean(b.email, 120))) return res.status(400).json({ error: 'invalid e-mail' });
    db.prepare(`UPDATE hotels SET name=?, brand=?, address=?, phone=?, email=?, city=?, lat=?, lon=?, langs=?, reception_json=?, wifi_json=?, view_json=?, theme_json=?, taxi_phone=?, webhook_url=?, notify_email=? WHERE id=?`).run(
      clean(b.name, 120) || h.name, clean(b.brand, 120), clean(b.address, 200), safePhone(b.phone), clean(b.email, 120), clean(b.city, 80),
      lat(b.lat, h.lat), lon(b.lon, h.lon), J((Array.isArray(b.langs) ? b.langs : LANGS).filter((l) => LANGS.includes(l))),
      J(plainObj(b.reception)), J(plainObj(b.wifi)), J(plainObj(b.welcomeView)), J(plainObj(b.theme)), safePhone(b.taxiPhone), hook.url, clean(b.notifyEmail, 120), h.id,
    );
    if (b.photo !== undefined) db.prepare('UPDATE hotels SET photo = ? WHERE id = ?').run(safeUrl(b.photo, { allowPath: true }), h.id);
    res.json({ hotel: hotelPublic(hotelById.get(h.id)) });
  });

  // Generic CRUD for content tables.
  const TABLES = {
    services: {
      row: serviceRow,
      cols: (b) => ({ sort: clamp(b.sort, -9999, 9999, 0), icon: safeIcon(b.icon, 'room_service'), category: clean(b.category, 30).replace(/[^a-z0-9_-]/gi, '') || 'leisure', name_json: J(i18nObj(b.name, 120)), desc_json: J(i18nObj(b.desc, 600)), hours_json: J(i18nObj(b.hours, 120)), open_json: J(weekly(b.open)), bookable: bool(b.bookable), active: b.active === undefined ? 1 : bool(b.active), photo: safeUrl(b.photo, { allowPath: true }) }),
      required: (c) => (JSON.parse(c.name_json).es || JSON.parse(c.name_json).en ? '' : 'name required'),
    },
    actions: {
      row: actionRow,
      cols: (b) => ({ sort: clamp(b.sort, -9999, 9999, 0), key: clean(b.key, 30).replace(/[^a-z0-9_-]/gi, '') || 'other', icon: safeIcon(b.icon, 'support_agent'), name_json: J(i18nObj(b.name, 120)), sub_json: J(i18nObj(b.sub, 200)), fields_json: J(Array.isArray(b.fields) ? [...new Set(b.fields.filter((f) => FIELDS.includes(f)))] : []), tel: safePhone(b.tel), active: b.active === undefined ? 1 : bool(b.active) }),
      required: (c) => (JSON.parse(c.name_json).es || JSON.parse(c.name_json).en ? '' : 'name required'),
    },
    pois: {
      row: poiRow,
      cols: (b) => ({ sort: clamp(b.sort, -9999, 9999, 0), key: clean(b.key, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '-') || uid(), cat: clean(b.cat, 30).replace(/[^a-z0-9_-]/gi, '') || 'monument', lat: lat(b.lat, NaN), lon: lon(b.lon, NaN), minutes: clamp(b.minutes, 5, 600, 60), best_json: J(Array.isArray(b.best) ? b.best.filter((x) => ['morning', 'afternoon', 'evening', 'night'].includes(x)) : ['morning', 'afternoon']), priority: clamp(b.priority, 0, 10, 5), name_json: J(i18nObj(b.name, 120)), tag_json: J(i18nObj(b.tag, 60)), desc_json: J(i18nObj(b.desc, 1200)), tasks_json: J(i18nList(b.tasks)), actions_json: J(poiActions(b.actions)), active: b.active === undefined ? 1 : bool(b.active), photo: safeUrl(b.photo, { allowPath: true }), indoor: bool(b.indoor) }),
      required: (c) => (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) ? 'valid lat/lon required' : JSON.parse(c.name_json).es || JSON.parse(c.name_json).en ? '' : 'name required'),
    },
    rooms: {
      row: (r) => ({ id: r.id, number: r.number, floor: r.floor, token: r.token, active: !!r.active, url: `${publicUrl}/?h=__SLUG__&r=${r.token}` }),
      cols: (b) => ({ number: clean(b.number, 12), floor: clean(b.floor, 12), active: b.active === undefined ? 1 : bool(b.active) }),
      required: (c) => (/^[\p{L}\p{N} ._-]{1,12}$/u.test(c.number) ? '' : 'valid room number required'),
    },
  };
  for (const [table, def] of Object.entries(TABLES)) {
    app.get(`/admin/${table}`, admin, (req, res) => {
      const slug = hotelById.get(req.hotelId).slug;
      const rows = db.prepare(`SELECT * FROM ${table} WHERE hotel_id = ? ORDER BY ${table === 'rooms' ? 'number' : 'sort, rowid'}`).all(req.hotelId);
      res.json({ items: rows.map((r) => fixSlug(def.row(r), slug)) });
    });
    app.post(`/admin/${table}`, admin, (req, res) => {
      const cols = def.cols(req.body || {});
      const problem = def.required?.(cols);
      if (problem) return res.status(400).json({ error: problem });
      if (table === 'rooms') cols.token = newToken();
      const id = uid();
      const keys = Object.keys(cols);
      try {
        db.prepare(`INSERT INTO ${table} (id, hotel_id, ${keys.join(',')}) VALUES (?,?,${keys.map(() => '?').join(',')})`).run(id, req.hotelId, ...keys.map((k) => cols[k]));
      } catch (e) {
        return res.status(400).json({ error: dbError(e) });
      }
      res.status(201).json({ item: fixSlug(def.row(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)), hotelById.get(req.hotelId).slug) });
    });
    app.put(`/admin/${table}/:id`, admin, (req, res) => {
      const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND hotel_id = ?`).get(req.params.id, req.hotelId);
      if (!existing) return res.status(404).json({ error: 'not found' });
      const cols = def.cols({ ...def.row(existing), ...(req.body || {}) });
      const problem = def.required?.(cols);
      if (problem) return res.status(400).json({ error: problem });
      const keys = Object.keys(cols);
      try {
        db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), existing.id);
      } catch (e) {
        return res.status(400).json({ error: dbError(e) });
      }
      res.json({ item: fixSlug(def.row(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(existing.id)), hotelById.get(req.hotelId).slug) });
    });
    app.delete(`/admin/${table}/:id`, admin, (req, res) => {
      db.prepare(`DELETE FROM ${table} WHERE id = ? AND hotel_id = ?`).run(req.params.id, req.hotelId);
      res.json({ ok: true });
    });
  }
  function dbError(e) {
    if (/UNIQUE/i.test(e?.message)) return 'already exists';
    console.error('[concierge api] db', e?.message);
    return 'invalid data';
  }
  function plainObj(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const [k, val] of Object.entries(v).slice(0, 30)) {
      if (!/^[A-Za-z0-9_]{1,30}$/.test(k)) continue;
      if (typeof val === 'number' || typeof val === 'boolean') out[k] = val;
      else if (typeof val === 'string') out[k] = clean(val, 300);
      else if (val && typeof val === 'object' && !Array.isArray(val)) out[k] = i18nObj(val, 300);
    }
    return out;
  }
  function fixSlug(item, slug) {
    if (item.url) item.url = item.url.replace('__SLUG__', slug);
    return item;
  }
  app.get('/admin/rooms/:id/qr.svg', admin, async (req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND hotel_id = ?').get(req.params.id, req.hotelId);
    if (!room) return res.status(404).end();
    const slug = hotelById.get(req.hotelId).slug;
    const url = `${publicUrl || `${req.protocol}://${req.get('host')}`}/?h=${slug}&r=${room.token}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 512 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Disposition', `inline; filename="qr-${slug}-${room.number}.svg"`);
    res.send(svg);
  });
  app.post('/admin/rooms/:id/regenerate', admin, (req, res) => {
    db.prepare('UPDATE rooms SET token = ? WHERE id = ? AND hotel_id = ?').run(newToken(), req.params.id, req.hotelId);
    res.json({ ok: true });
  });

  // Users of the hotel.
  // Hotel admins manage their hotel's staff; superadmin accounts are invisible
  // and untouchable to them (prevents privilege escalation).
  const isSuper = (req) => req.user.role === 'superadmin';
  const manageable = (req, u) => u && (isSuper(req) || u.role !== 'superadmin');
  const userItem = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: !!u.active, mustChangePassword: !!u.must_change_password, lastLoginAt: u.last_login_at || null });
  app.get('/admin/users', admin, (req, res) => {
    const rows = db.prepare(`SELECT * FROM users WHERE hotel_id = ? ${isSuper(req) ? '' : "AND role != 'superadmin'"} ORDER BY role, name`).all(req.hotelId);
    res.json({ items: rows.map(userItem) });
  });
  app.post('/admin/users', admin, (req, res) => {
    const b = req.body || {};
    const email = clean(b.email, 120).toLowerCase();
    const role = ['admin', 'reception', 'staff'].includes(b.role) ? b.role : 'reception';
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid e-mail required' });
    const problem = passwordProblem(b.password);
    if (problem) return res.status(400).json({ error: `password: ${problem}` });
    const id = uid();
    try {
      // New staff choose their own password on first sign-in.
      db.prepare('INSERT INTO users (id, hotel_id, email, password_hash, name, role, must_change_password) VALUES (?,?,?,?,?,?,1)').run(id, req.hotelId, email, hashPassword(b.password), clean(b.name, 80), role);
    } catch {
      return res.status(400).json({ error: 'email already exists' });
    }
    res.status(201).json({ item: userItem(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  });
  app.put('/admin/users/:id', admin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND hotel_id = ?').get(req.params.id, req.hotelId);
    if (!manageable(req, u)) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const self = u.id === req.user.id;
    if (b.password) {
      const problem = passwordProblem(b.password);
      if (problem) return res.status(400).json({ error: `password: ${problem}` });
    }
    if (b.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(clean(b.name, 80), u.id);
    if (['admin', 'reception', 'staff'].includes(b.role) && !self && u.role !== 'superadmin') db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
    if (b.active !== undefined && !self) db.prepare('UPDATE users SET active = ?, session_version = session_version + 1 WHERE id = ?').run(bool(b.active), u.id);
    // Reset by an admin: temporary password, forced change, other sessions closed.
    if (b.password && !self) db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, session_version = session_version + 1 WHERE id = ?').run(hashPassword(b.password), u.id);
    if (b.signOut && !self) db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(u.id);
    res.json({ ok: true, item: userItem(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  });
  app.delete('/admin/users/:id', admin, (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND hotel_id = ?').get(req.params.id, req.hotelId);
    if (!manageable(req, u)) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    res.json({ ok: true });
  });

  // ---------- superadmin ----------
  function superadminOnly(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'auth required' });
    if (user.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
    if (user.must_change_password) return res.status(403).json({ error: 'password change required', code: 'must_change_password' });
    req.user = user;
    next();
  }
  app.get('/super/hotels', superadminOnly, (req, res) => {
    const rows = db.prepare(`SELECT h.*, (SELECT COUNT(*) FROM requests r WHERE r.hotel_id = h.id AND r.status = 'pending') AS pending FROM hotels h ORDER BY h.created_at`).all();
    res.json({ hotels: rows.map((h) => ({ ...hotelPublic(h), active: !!h.active, pending: h.pending })) });
  });
  app.post('/super/hotels', superadminOnly, (req, res) => {
    const b = req.body || {};
    const slug = clean(b.slug, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!slug || !clean(b.name, 120)) return res.status(400).json({ error: 'slug and name required' });
    if (b.adminEmail) {
      if (!EMAIL_RE.test(clean(b.adminEmail, 120))) return res.status(400).json({ error: 'valid admin e-mail required' });
      const problem = passwordProblem(b.adminPassword);
      if (problem) return res.status(400).json({ error: `admin password: ${problem}` });
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(clean(b.adminEmail, 120).toLowerCase())) return res.status(400).json({ error: 'admin email already exists' });
    }
    const id = uid();
    try {
      db.prepare(`INSERT INTO hotels (id, slug, name, brand, address, phone, email, city, lat, lon) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, slug, clean(b.name, 120), clean(b.brand, 120), clean(b.address, 200), safePhone(b.phone), clean(b.email, 120), clean(b.city, 80), lat(b.lat, 37.1773), lon(b.lon, -3.5986));
    } catch {
      return res.status(400).json({ error: 'slug already exists' });
    }
    // Default quick actions so the Tasks panel is never empty.
    const defaults = [
      ['reception', 'support_agent', { es: 'Hablar con recepción', en: 'Talk to reception', fr: 'Parler à la réception', de: 'Mit der Rezeption sprechen' }, ['details']],
      ['housekeeping', 'cleaning_services', { es: 'Toallas / limpieza', en: 'Towels / housekeeping', fr: 'Serviettes / ménage', de: 'Handtücher / Zimmerservice' }, ['details']],
      ['latecheckout', 'schedule', { es: 'Pedir late check-out', en: 'Request late check-out', fr: 'Départ tardif', de: 'Late Check-out' }, ['when', 'details']],
    ];
    const ins = db.prepare('INSERT INTO actions (id, hotel_id, sort, key, icon, name_json, fields_json) VALUES (?,?,?,?,?,?,?)');
    defaults.forEach(([key, icon, name, fields], i) => ins.run(uid(), id, i, key, icon, J(name), J(fields)));
    if (b.adminEmail && !passwordProblem(b.adminPassword) && EMAIL_RE.test(clean(b.adminEmail, 120))) {
      try {
        db.prepare('INSERT INTO users (id, hotel_id, email, password_hash, name, role) VALUES (?,?,?,?,?,?)').run(uid(), id, clean(b.adminEmail, 120).toLowerCase(), hashPassword(b.adminPassword), clean(b.adminName, 80) || 'Admin', 'admin');
        db.prepare('UPDATE users SET must_change_password = 1 WHERE email = ?').run(clean(b.adminEmail, 120).toLowerCase());
      } catch {
        return res.status(400).json({ error: 'admin email already exists (hotel created)' });
      }
    }
    res.status(201).json({ hotel: hotelPublic(hotelById.get(id)) });
  });
  app.patch('/super/hotels/:id', superadminOnly, (req, res) => {
    const b = req.body || {};
    if (b.active !== undefined) db.prepare('UPDATE hotels SET active = ? WHERE id = ?').run(bool(b.active), req.params.id);
    res.json({ ok: true });
  });

  chat.mount(app, { hotelBySlug, staff });
  weather.mount(app, { hotelBySlug });
  media.mount(app, { admin });
  stats.mount(app, { hotelBySlug, admin });
  transit.mount(app, { hotelBySlug, admin });

  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    console.error('[concierge api]', err);
    res.status(500).json({ error: 'server error' });
  });

  app.media = media;
  return app;
}
