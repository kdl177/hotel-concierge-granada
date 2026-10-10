/**
 * SQLite storage for the hotel concierge (node:sqlite, no native deps).
 * One database file holds every hotel (multi-tenant by hotel_id).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hotels (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, brand TEXT DEFAULT '',
  address TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', city TEXT DEFAULT '',
  lat REAL NOT NULL, lon REAL NOT NULL, langs TEXT DEFAULT '["es","en","fr","de"]',
  reception_json TEXT DEFAULT '{}', wifi_json TEXT DEFAULT '{}', view_json TEXT DEFAULT '{}',
  theme_json TEXT DEFAULT '{}', taxi_phone TEXT DEFAULT '', webhook_url TEXT DEFAULT '',
  notify_email TEXT DEFAULT '', active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, hotel_id TEXT REFERENCES hotels(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('superadmin','admin','reception','staff')),
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY, hotel_id TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  sort INTEGER DEFAULT 0, icon TEXT DEFAULT 'room_service', category TEXT DEFAULT 'leisure',
  name_json TEXT NOT NULL, desc_json TEXT DEFAULT '{}', hours_json TEXT DEFAULT '{}',
  open_json TEXT DEFAULT 'null', bookable INTEGER DEFAULT 0, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, hotel_id TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  sort INTEGER DEFAULT 0, key TEXT NOT NULL, icon TEXT DEFAULT 'support_agent',
  name_json TEXT NOT NULL, sub_json TEXT DEFAULT '{}', fields_json TEXT DEFAULT '["when","details"]',
  tel TEXT DEFAULT '', active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pois (
  id TEXT PRIMARY KEY, hotel_id TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  sort INTEGER DEFAULT 0, key TEXT NOT NULL, cat TEXT DEFAULT 'monument', lat REAL NOT NULL, lon REAL NOT NULL,
  minutes INTEGER DEFAULT 60, best_json TEXT DEFAULT '["morning","afternoon"]', priority INTEGER DEFAULT 5,
  name_json TEXT NOT NULL, tag_json TEXT DEFAULT '{}', desc_json TEXT DEFAULT '{}',
  tasks_json TEXT DEFAULT '{}', actions_json TEXT DEFAULT '[]', active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, hotel_id TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  number TEXT NOT NULL, token TEXT UNIQUE NOT NULL, floor TEXT DEFAULT '', active INTEGER DEFAULT 1,
  UNIQUE(hotel_id, number)
);
CREATE TABLE IF NOT EXISTS stays (
  id TEXT PRIMARY KEY, hotel_id TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL, guest_name TEXT DEFAULT '',
  guests INTEGER DEFAULT 1, lang TEXT DEFAULT 'es', code TEXT, checkin TEXT, checkout TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('upcoming','active','closed')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, hotel_id TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  stay_id TEXT REFERENCES stays(id) ON DELETE SET NULL, room TEXT NOT NULL, type TEXT NOT NULL,
  name TEXT DEFAULT '', when_at TEXT DEFAULT '', details TEXT DEFAULT '', lang TEXT DEFAULT 'es',
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','confirmed','done','rejected')),
  note TEXT DEFAULT '', assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id TEXT, event TEXT NOT NULL, detail TEXT DEFAULT '', at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversations (
  key TEXT PRIMARY KEY, hotel_id TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room TEXT DEFAULT '', guest_name TEXT DEFAULT '', stay_id TEXT, lang TEXT DEFAULT 'es',
  unread_staff INTEGER DEFAULT 0, unread_guest INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), last_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_key TEXT NOT NULL REFERENCES conversations(key) ON DELETE CASCADE,
  hotel_id TEXT NOT NULL, author TEXT NOT NULL CHECK(author IN ('guest','staff','system')),
  user_id TEXT, request_id TEXT, body TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT DEFAULT '',
  lang TEXT DEFAULT '', at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_hotel ON requests(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_key, id);
CREATE INDEX IF NOT EXISTS idx_conv_hotel ON conversations(hotel_id, last_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_hotel ON events(hotel_id, at);
CREATE INDEX IF NOT EXISTS idx_events_request ON request_events(request_id);
`;

/** Bundled Granada places that are under a roof (rainy / very hot day suggestions). */
const INDOOR_KEYS = [
  'catedral',
  'capilla-real',
  'san-jeronimo',
  'san-juan-de-dios',
  'cartuja',
  'parque-ciencias',
  'alcaiceria',
];

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive column migrations for databases created by earlier versions. */
function migrate(db) {
  const has = (table, col) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === col);
  const add = (table, col, def) => {
    if (!has(table, col))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  add('requests', 'guest_key', "TEXT DEFAULT ''");
  add('requests', 'first_response_at', 'TEXT');
  add('pois', 'photo', "TEXT DEFAULT ''");
  add('pois', 'indoor', 'INTEGER DEFAULT 0');
  add('services', 'photo', "TEXT DEFAULT ''");
  add('hotels', 'photo', "TEXT DEFAULT ''");
  // Account security: session revocation, forced password change, audit.
  add('users', 'session_version', 'INTEGER DEFAULT 0');
  add('users', 'must_change_password', 'INTEGER DEFAULT 0');
  add('users', 'last_login_at', 'TEXT');
  // Moderation: reception can block an abusive guest device (chat + requests).
  add('conversations', 'blocked', 'INTEGER DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, used_at INTEGER
  )`);
  // Databases seeded before the "indoor" column existed: mark the bundled covered places once.
  if (!db.prepare('SELECT 1 FROM pois WHERE indoor = 1 LIMIT 1').get()) {
    db.prepare(
      `UPDATE pois SET indoor = 1 WHERE key IN (${INDOOR_KEYS.map(() => '?').join(',')})`,
    ).run(...INDOOR_KEYS);
  }
}

export const uid = () => randomUUID().slice(0, 8);
export const token = () => randomBytes(9).toString('base64url');
export const J = (v) => JSON.stringify(v ?? null);
export const P = (s, fallback = null) => {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

/** Hotel row → public shape (no secrets). */
export function hotelPublic(h) {
  return {
    id: h.id,
    slug: h.slug,
    name: h.name,
    brand: h.brand,
    address: h.address,
    phone: h.phone,
    email: h.email,
    city: h.city,
    lat: h.lat,
    lon: h.lon,
    langs: P(h.langs, ['es', 'en', 'fr', 'de']),
    reception: P(h.reception_json, {}),
    wifi: P(h.wifi_json, {}),
    welcomeView: P(h.view_json, {}),
    theme: P(h.theme_json, {}),
    taxiPhone: h.taxi_phone,
    photo: h.photo || '',
  };
}
export function serviceRow(r) {
  return {
    id: r.id,
    sort: r.sort,
    icon: r.icon,
    category: r.category,
    name: P(r.name_json, {}),
    desc: P(r.desc_json, {}),
    hours: P(r.hours_json, {}),
    open: P(r.open_json),
    bookable: !!r.bookable,
    active: !!r.active,
    photo: r.photo || '',
  };
}
export function actionRow(r) {
  return {
    id: r.id,
    key: r.key,
    sort: r.sort,
    icon: r.icon,
    name: P(r.name_json, {}),
    sub: P(r.sub_json, {}),
    fields: P(r.fields_json, []),
    tel: r.tel,
    active: !!r.active,
  };
}
export function poiRow(r) {
  return {
    id: r.id,
    key: r.key,
    sort: r.sort,
    cat: r.cat,
    lat: r.lat,
    lon: r.lon,
    minutes: r.minutes,
    best: P(r.best_json, []),
    priority: r.priority,
    name: P(r.name_json, {}),
    tag: P(r.tag_json, {}),
    desc: P(r.desc_json, {}),
    tasks: P(r.tasks_json, {}),
    actions: P(r.actions_json, []),
    active: !!r.active,
    photo: r.photo || '',
    indoor: !!r.indoor,
  };
}
export function requestRow(r) {
  return {
    id: r.id,
    hotelId: r.hotel_id,
    stayId: r.stay_id,
    guestKey: r.guest_key || '',
    room: r.room,
    type: r.type,
    name: r.name,
    when: r.when_at,
    details: r.details,
    lang: r.lang,
    status: r.status,
    note: r.note,
    assignedTo: r.assigned_to,
    assignedName: r.assigned_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Insert the first hotel from the bundled config files when the DB is empty. */
export function seedIfEmpty(
  db,
  { hotel, services, actions, pois, sampleRooms = true },
) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM hotels').get().n;
  if (count > 0) return null;
  const hotelId = uid();
  db.prepare(
    `INSERT INTO hotels (id, slug, name, brand, address, phone, email, city, lat, lon, reception_json, wifi_json, view_json, taxi_phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    hotelId,
    hotel.id,
    hotel.name,
    hotel.brand,
    hotel.address,
    hotel.phone,
    hotel.email,
    'Granada',
    hotel.lat,
    hotel.lon,
    J(hotel.reception),
    J(hotel.wifi?.note),
    J(hotel.welcomeView),
    '+34 958 28 06 54',
  );
  const insS = db.prepare(
    `INSERT INTO services (id, hotel_id, sort, icon, category, name_json, desc_json, hours_json, open_json, bookable) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  services.forEach((s, i) =>
    insS.run(
      uid(),
      hotelId,
      i,
      s.icon,
      s.category,
      J(s.name),
      J(s.desc),
      J(s.hours),
      J(s.open ?? null),
      s.bookable ? 1 : 0,
    ),
  );
  const insA = db.prepare(
    `INSERT INTO actions (id, hotel_id, sort, key, icon, name_json, sub_json, fields_json, tel) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  actions.forEach((a, i) =>
    insA.run(
      uid(),
      hotelId,
      i,
      a.id,
      a.icon,
      J(a.name),
      J(a.sub ?? {}),
      J(a.fields ?? []),
      a.fields ? '' : a.tel || '',
    ),
  );
  const insP = db.prepare(
    `INSERT INTO pois (id, hotel_id, sort, key, cat, lat, lon, minutes, best_json, priority, name_json, tag_json, desc_json, tasks_json, actions_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  pois.forEach((p, i) =>
    insP.run(
      uid(),
      hotelId,
      i,
      p.id,
      p.cat,
      p.lat,
      p.lon,
      p.minutes,
      J(p.best),
      p.priority,
      J(p.name),
      J(p.tag),
      J(p.desc),
      J(p.tasks),
      J(p.actions ?? []),
    ),
  );
  db.prepare(
    `UPDATE pois SET indoor = 1 WHERE hotel_id = ? AND key IN (${INDOOR_KEYS.map(() => '?').join(',')})`,
  ).run(hotelId, ...INDOOR_KEYS);
  // Demo rooms only outside production: real room numbers are created in Admin → Habitaciones.
  if (sampleRooms) {
    const insR = db.prepare(
      `INSERT INTO rooms (id, hotel_id, number, token, floor) VALUES (?,?,?,?,?)`,
    );
    for (const n of ['101', '102', '103', '201', '202', '203', '301', '302'])
      insR.run(uid(), hotelId, n, token(), n[0]);
  }
  return hotelId;
}
