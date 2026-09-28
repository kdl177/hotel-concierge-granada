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
import { hashPassword, verifyPassword, createSessions } from './auth.js';
import { uid, token as newToken, J, P, hotelPublic, serviceRow, actionRow, poiRow, requestRow } from './db.js';
import { createNotifier } from './notify.js';

const LANGS = ['es', 'en', 'fr', 'de'];
const STATUSES = ['pending', 'confirmed', 'done', 'rejected'];
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function createApi({ db, secret, secureCookies = false, publicUrl = '' }) {
  const app = express.Router();
  const sessions = createSessions({ secret });
  const notifier = createNotifier();
  app.use(express.json({ limit: '256kb' }));

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
    return user || null;
  }
  function requireRole(...roles) {
    return (req, res, next) => {
      const user = currentUser(req);
      if (!user) return res.status(401).json({ error: 'auth required' });
      if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'forbidden' });
      req.user = user;
      // Superadmin can act on any hotel via ?hotel=<id>; others are bound to theirs.
      req.hotelId = user.role === 'superadmin' ? clean(req.query.hotel || req.headers['x-hotel'] || user.hotel_id || '') : user.hotel_id;
      if (!req.hotelId) return res.status(400).json({ error: 'hotel required' });
      next();
    };
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

  app.post('/h/:slug/requests', async (req, res) => {
    const h = hotelBySlug.get(req.params.slug);
    if (!h) return res.status(404).json({ error: 'hotel not found' });
    const b = req.body || {};
    const room = clean(b.room, 12);
    if (!room) return res.status(400).json({ error: 'room required' });
    let stayId = null;
    if (b.roomToken) {
      const r = db.prepare('SELECT id FROM rooms WHERE hotel_id = ? AND token = ?').get(h.id, clean(b.roomToken, 40));
      const s = r && db.prepare(`SELECT id FROM stays WHERE room_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(r.id);
      stayId = s?.id || null;
    }
    const id = uid();
    db.prepare(`INSERT INTO requests (id, hotel_id, stay_id, room, type, name, when_at, details, lang) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      id, h.id, stayId, room, clean(b.type, 40) || 'other', clean(b.name, 80), clean(b.when, 40), clean(b.details), LANGS.includes(b.lang) ? b.lang : 'es',
    );
    logEvent(id, null, 'created');
    const request = requestRow(requestWithAssignee(id));
    notifier.send({ event: 'created', hotel: hotelPublic(h), hotelRow: h, request });
    res.status(201).json({ request });
  });

  app.get('/h/:slug/requests', (req, res) => {
    const h = hotelBySlug.get(req.params.slug);
    if (!h) return res.status(404).json({ error: 'hotel not found' });
    const ids = clean(req.query.ids, 400).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
    if (!ids.length) return res.json({ requests: [] });
    const rows = db.prepare(`SELECT r.*, u.name AS assigned_name FROM requests r LEFT JOIN users u ON u.id = r.assigned_to WHERE r.hotel_id = ? AND r.id IN (${ids.map(() => '?').join(',')})`).all(h.id, ...ids);
    res.json({ requests: rows.map(requestRow) });
  });

  // ---------- auth ----------
  app.post('/auth/login', (req, res) => {
    const email = clean(req.body?.email, 120).toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !verifyPassword(req.body?.password, user.password_hash)) return res.status(401).json({ error: 'invalid credentials' });
    sessions.setCookie(res, sessions.issue(user), { secure: secureCookies });
    res.json({ user: publicUser(user) });
  });
  app.post('/auth/logout', (req, res) => {
    sessions.clearCookie(res);
    res.json({ ok: true });
  });
  app.get('/auth/me', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'auth required' });
    const hotel = user.hotel_id ? hotelById.get(user.hotel_id) : null;
    res.json({ user: publicUser(user), hotel: hotel && hotelPublic(hotel) });
  });
  app.post('/auth/password', requireRole(), (req, res) => {
    if (!verifyPassword(req.body?.current, req.user.password_hash)) return res.status(400).json({ error: 'wrong password' });
    const next = String(req.body?.next || '');
    if (next.length < 8) return res.status(400).json({ error: 'min 8 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    res.json({ ok: true });
  });
  function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, hotelId: u.hotel_id };
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
    if (STATUSES.includes(b.status) && b.status !== r.status) {
      db.prepare(`UPDATE requests SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(b.status, r.id);
      logEvent(r.id, req.user.id, 'status', b.status);
    }
    if (b.note !== undefined) {
      db.prepare(`UPDATE requests SET note = ?, updated_at = datetime('now') WHERE id = ?`).run(clean(b.note), r.id);
      logEvent(r.id, req.user.id, 'note', clean(b.note));
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
      id, req.hotelId, room.id, clean(b.guestName, 80), num(b.guests, 1), LANGS.includes(b.lang) ? b.lang : 'es', clean(b.code, 40), clean(b.checkin, 20), clean(b.checkout, 20),
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
  app.put('/admin/hotel', admin, (req, res) => {
    const b = req.body || {};
    const h = hotelById.get(req.hotelId);
    db.prepare(`UPDATE hotels SET name=?, brand=?, address=?, phone=?, email=?, city=?, lat=?, lon=?, langs=?, reception_json=?, wifi_json=?, view_json=?, theme_json=?, taxi_phone=?, webhook_url=?, notify_email=? WHERE id=?`).run(
      clean(b.name, 120) || h.name, clean(b.brand, 120), clean(b.address, 200), clean(b.phone, 40), clean(b.email, 120), clean(b.city, 80),
      num(b.lat, h.lat), num(b.lon, h.lon), J((Array.isArray(b.langs) ? b.langs : LANGS).filter((l) => LANGS.includes(l))),
      J(b.reception ?? {}), J(b.wifi ?? {}), J(b.welcomeView ?? {}), J(b.theme ?? {}), clean(b.taxiPhone, 40), clean(b.webhookUrl, 300), clean(b.notifyEmail, 120), h.id,
    );
    res.json({ hotel: hotelPublic(hotelById.get(h.id)) });
  });

  // Generic CRUD for content tables.
  const TABLES = {
    services: {
      row: serviceRow,
      cols: (b) => ({ sort: num(b.sort), icon: clean(b.icon, 40) || 'room_service', category: clean(b.category, 30) || 'leisure', name_json: J(b.name || {}), desc_json: J(b.desc || {}), hours_json: J(b.hours || {}), open_json: J(b.open ?? null), bookable: bool(b.bookable), active: b.active === undefined ? 1 : bool(b.active) }),
    },
    actions: {
      row: actionRow,
      cols: (b) => ({ sort: num(b.sort), key: clean(b.key, 30) || 'other', icon: clean(b.icon, 40) || 'support_agent', name_json: J(b.name || {}), sub_json: J(b.sub || {}), fields_json: J(Array.isArray(b.fields) ? b.fields : []), tel: clean(b.tel, 40), active: b.active === undefined ? 1 : bool(b.active) }),
    },
    pois: {
      row: poiRow,
      cols: (b) => ({ sort: num(b.sort), key: clean(b.key, 40) || uid(), cat: clean(b.cat, 30) || 'monument', lat: num(b.lat), lon: num(b.lon), minutes: num(b.minutes, 60), best_json: J(Array.isArray(b.best) ? b.best : ['morning', 'afternoon']), priority: num(b.priority, 5), name_json: J(b.name || {}), tag_json: J(b.tag || {}), desc_json: J(b.desc || {}), tasks_json: J(b.tasks || {}), actions_json: J(Array.isArray(b.actions) ? b.actions : []), active: b.active === undefined ? 1 : bool(b.active) }),
    },
    rooms: {
      row: (r) => ({ id: r.id, number: r.number, floor: r.floor, token: r.token, active: !!r.active, url: `${publicUrl}/?h=__SLUG__&r=${r.token}` }),
      cols: (b) => ({ number: clean(b.number, 12), floor: clean(b.floor, 12), active: b.active === undefined ? 1 : bool(b.active) }),
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
      if (table === 'rooms') { if (!cols.number) return res.status(400).json({ error: 'number required' }); cols.token = newToken(); }
      const id = uid();
      const keys = Object.keys(cols);
      try {
        db.prepare(`INSERT INTO ${table} (id, hotel_id, ${keys.join(',')}) VALUES (?,?,${keys.map(() => '?').join(',')})`).run(id, req.hotelId, ...keys.map((k) => cols[k]));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      res.status(201).json({ item: fixSlug(def.row(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)), hotelById.get(req.hotelId).slug) });
    });
    app.put(`/admin/${table}/:id`, admin, (req, res) => {
      const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND hotel_id = ?`).get(req.params.id, req.hotelId);
      if (!existing) return res.status(404).json({ error: 'not found' });
      const cols = def.cols({ ...def.row(existing), ...(req.body || {}) });
      const keys = Object.keys(cols);
      try {
        db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), existing.id);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      res.json({ item: fixSlug(def.row(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(existing.id)), hotelById.get(req.hotelId).slug) });
    });
    app.delete(`/admin/${table}/:id`, admin, (req, res) => {
      db.prepare(`DELETE FROM ${table} WHERE id = ? AND hotel_id = ?`).run(req.params.id, req.hotelId);
      res.json({ ok: true });
    });
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
  app.get('/admin/users', admin, (req, res) => {
    res.json({ items: db.prepare('SELECT id, email, name, role, active FROM users WHERE hotel_id = ? ORDER BY role, name').all(req.hotelId).map((u) => ({ ...u, active: !!u.active })) });
  });
  app.post('/admin/users', admin, (req, res) => {
    const b = req.body || {};
    const email = clean(b.email, 120).toLowerCase();
    const role = ['admin', 'reception', 'staff'].includes(b.role) ? b.role : 'reception';
    if (!email || String(b.password || '').length < 8) return res.status(400).json({ error: 'email and password (8+) required' });
    const id = uid();
    try {
      db.prepare('INSERT INTO users (id, hotel_id, email, password_hash, name, role) VALUES (?,?,?,?,?,?)').run(id, req.hotelId, email, hashPassword(b.password), clean(b.name, 80), role);
    } catch {
      return res.status(400).json({ error: 'email already exists' });
    }
    res.status(201).json({ item: { id, email, name: clean(b.name, 80), role, active: true } });
  });
  app.put('/admin/users/:id', admin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND hotel_id = ?').get(req.params.id, req.hotelId);
    if (!u) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (b.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(clean(b.name, 80), u.id);
    if (['admin', 'reception', 'staff'].includes(b.role)) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
    if (b.active !== undefined && u.id !== req.user.id) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(bool(b.active), u.id);
    if (b.password && String(b.password).length >= 8) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
    res.json({ ok: true });
  });
  app.delete('/admin/users/:id', admin, (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
    db.prepare('DELETE FROM users WHERE id = ? AND hotel_id = ?').run(req.params.id, req.hotelId);
    res.json({ ok: true });
  });

  // ---------- superadmin ----------
  const superadmin = requireRole('superadmin');
  app.get('/super/hotels', (req, res, next) => {
    const user = currentUser(req);
    if (!user || user.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
    const rows = db.prepare(`SELECT h.*, (SELECT COUNT(*) FROM requests r WHERE r.hotel_id = h.id AND r.status = 'pending') AS pending FROM hotels h ORDER BY h.created_at`).all();
    res.json({ hotels: rows.map((h) => ({ ...hotelPublic(h), active: !!h.active, pending: h.pending })) });
  });
  app.post('/super/hotels', (req, res) => {
    const user = currentUser(req);
    if (!user || user.role !== 'superadmin') return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    const slug = clean(b.slug, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!slug || !clean(b.name, 120)) return res.status(400).json({ error: 'slug and name required' });
    const id = uid();
    try {
      db.prepare(`INSERT INTO hotels (id, slug, name, brand, address, phone, email, city, lat, lon) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, slug, clean(b.name, 120), clean(b.brand, 120), clean(b.address, 200), clean(b.phone, 40), clean(b.email, 120), clean(b.city, 80), num(b.lat, 37.1773), num(b.lon, -3.5986));
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
    if (b.adminEmail && String(b.adminPassword || '').length >= 8) {
      try {
        db.prepare('INSERT INTO users (id, hotel_id, email, password_hash, name, role) VALUES (?,?,?,?,?,?)').run(uid(), id, clean(b.adminEmail, 120).toLowerCase(), hashPassword(b.adminPassword), clean(b.adminName, 80) || 'Admin', 'admin');
      } catch {
        return res.status(400).json({ error: 'admin email already exists (hotel created)' });
      }
    }
    res.status(201).json({ hotel: hotelPublic(hotelById.get(id)) });
  });
  app.patch('/super/hotels/:id', superadmin, (req, res) => {
    const b = req.body || {};
    if (b.active !== undefined) db.prepare('UPDATE hotels SET active = ? WHERE id = ?').run(bool(b.active), req.params.id);
    res.json({ ok: true });
  });

  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    console.error('[concierge api]', err);
    res.status(500).json({ error: 'server error' });
  });

  return app;
}
