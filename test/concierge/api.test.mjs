import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, superadmin, hotelUser, guestKey, STRONG } from './helpers.mjs';

let app;
const sent = [];
before(async () => {
  app = await startApp({ mailer: { sendMail: async (m) => sent.push(m) } });
});
after(() => app.close());

test('guest config: public data of the default hotel, 404 for unknown hotels', async () => {
  const c = client(app.base);
  const r = await c.get('/api/h/default/config');
  assert.equal(r.status, 200);
  assert.match(r.data.hotel.name, /Luna/);
  assert.ok(r.data.pois.length >= 10);
  assert.ok(r.data.pois.every((p) => typeof p.id === 'string' && p.id.length));
  assert.equal(r.data.hotel.webhookUrl, undefined, 'private settings are not public');
  assert.equal((await c.get('/api/h/nope/config')).status, 404);
});

test('bootstrap superadmin must change the default password before doing anything', async () => {
  const c = client(app.base);
  const login = await c.post('/api/auth/login', { email: 'admin@hotel.local', password: 'admin1234' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);
  const blocked = await c.get('/api/admin/hotel');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'must_change_password');
  assert.equal((await c.post('/api/auth/password', { current: 'admin1234', next: 'short1' })).status, 400);
  assert.equal((await c.post('/api/auth/password', { current: 'admin1234', next: 'onlyletterspassword' })).status, 400);
  assert.equal((await c.post('/api/auth/password', { current: 'wrong', next: STRONG })).status, 400);
  const old = c.cookie;
  assert.equal((await c.post('/api/auth/password', { current: 'admin1234', next: STRONG })).status, 200);
  assert.equal((await c.get('/api/admin/hotel')).status, 200);
  const stale = client(app.base);
  stale.cookie = old;
  assert.equal((await stale.get('/api/auth/me')).status, 401, 'sessions issued before the change are revoked');
});

test('A-01: a hotel admin cannot see, edit or delete the superadmin', async () => {
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const admin = await hotelUser(app.base, sa, { email: 'jefe@luna.es' });
  const list = await admin.get('/api/admin/users');
  assert.equal(list.status, 200);
  assert.ok(list.data.items.every((u) => u.role !== 'superadmin'));
  const saId = (await sa.get('/api/admin/users')).data.items.find((u) => u.role === 'superadmin').id;
  assert.equal((await admin.put(`/api/admin/users/${saId}`, { password: 'Pwned1234567' })).status, 404);
  assert.equal((await admin.del(`/api/admin/users/${saId}`)).status, 404);
  const me = (await admin.get('/api/auth/me')).data.user;
  await admin.put(`/api/admin/users/${me.id}`, { role: 'staff' });
  assert.equal((await admin.get('/api/auth/me')).data.user.role, 'admin', 'cannot change own role');
  assert.equal((await client(app.base).post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG })).status, 200, 'superadmin password intact');
  assert.equal((await admin.get('/api/super/hotels')).status, 403);
});

test('roles: reception cannot reach admin endpoints, anonymous gets 401', async () => {
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const rec = await hotelUser(app.base, sa, { email: 'recepcion@luna.es', role: 'reception' });
  assert.equal((await rec.get('/api/staff/requests')).status, 200);
  assert.equal((await rec.get('/api/admin/hotel')).status, 403);
  assert.equal((await rec.post('/api/admin/upload', { dataUrl: 'x' })).status, 403);
  assert.equal((await client(app.base).get('/api/staff/requests')).status, 401);
  assert.equal((await sa.get('/api/admin/hotel', { 'X-Hotel': 'does-not-exist' })).status, 404);
});

test('admin reset of a user forces a new password and closes their sessions', async () => {
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const staff = await hotelUser(app.base, sa, { email: 'camarera@luna.es', role: 'staff' });
  const id = (await staff.get('/api/auth/me')).data.user.id;
  assert.equal((await sa.put(`/api/admin/users/${id}`, { password: 'weak' })).status, 400);
  assert.equal((await sa.put(`/api/admin/users/${id}`, { password: 'NuevaTemporal99' })).status, 200);
  assert.equal((await staff.get('/api/auth/me')).status, 401);
  const again = client(app.base);
  const r = await again.post('/api/auth/login', { email: 'camarera@luna.es', password: 'NuevaTemporal99' });
  assert.equal(r.data.user.mustChangePassword, true);
});

test('logout-all revokes every session of the account', async () => {
  const a = client(app.base);
  const b = client(app.base);
  await a.post('/api/auth/login', { email: 'jefe@luna.es', password: STRONG + 'admin' });
  await b.post('/api/auth/login', { email: 'jefe@luna.es', password: STRONG + 'admin' });
  assert.equal((await a.post('/api/auth/logout-all')).status, 200);
  assert.equal((await b.get('/api/auth/me')).status, 401);
});

test('A-04: login is rate limited per account and IP', async () => {
  const c = client(app.base);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await c.post('/api/auth/login', { email: 'recepcion@luna.es', password: `bad${i}` })).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[5], 429);
  const r = await c.post('/api/auth/login', { email: 'recepcion@luna.es', password: STRONG + 'reception' });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('password recovery by e-mail: single use, same answer for unknown accounts', async () => {
  const c = client(app.base);
  assert.equal((await c.get('/api/auth/options')).data.emailReset, true);
  const unknown = await c.post('/api/auth/forgot', { email: 'nadie@luna.es' });
  assert.deepEqual(unknown.data, { ok: true, emailReset: true });
  assert.equal(sent.length, 0);
  await c.post('/api/auth/forgot', { email: 'jefe@luna.es' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  const tokenValue = /#reset=([A-Za-z0-9_-]+)/.exec(sent[0].text)[1];
  assert.equal((await c.post('/api/auth/reset', { token: tokenValue, password: 'x' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { token: tokenValue, password: 'Recuperada2026' })).status, 200);
  assert.equal((await c.post('/api/auth/reset', { token: tokenValue, password: 'OtraVez2026xx' })).status, 400, 'token is single-use');
  assert.equal((await c.post('/api/auth/login', { email: 'jefe@luna.es', password: 'Recuperada2026' })).status, 200);
});

test('guest request → reception → guest timeline; requests are private to their device', async () => {
  const guest = client(app.base);
  const key = guestKey(1);
  const created = await guest.post('/api/h/default/requests', { room: '101', type: 'wakeup', when: '2026-10-05T07:30', details: '<b>hola</b>', guestKey: key, lang: 'es' });
  assert.equal(created.status, 201);
  const id = created.data.request.id;
  assert.equal((await guest.get(`/api/h/default/requests?ids=${id}`)).data.requests.length, 0, 'no key → nothing');
  assert.equal((await guest.get(`/api/h/default/requests?ids=${id}&key=${guestKey(2)}`)).data.requests.length, 0, 'other device → nothing');
  assert.equal((await guest.get(`/api/h/default/requests?ids=${id}&key=${key}`)).data.requests[0].status, 'pending');

  const rec = client(app.base);
  await rec.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const inbox = await rec.get('/api/staff/requests');
  assert.ok(inbox.data.requests.some((r) => r.id === id && r.details === '<b>hola</b>'), 'stored as text, escaped at render time');
  const upd = await rec.patch(`/api/staff/requests/${id}`, { status: 'confirmed', note: 'Le llamamos a las 7:30' });
  assert.equal(upd.data.request.status, 'confirmed');
  const chat = await guest.get(`/api/h/default/chat?key=${key}`);
  const bodies = chat.data.messages.map((m) => m.body);
  assert.ok(bodies.includes('status:confirmed') && bodies.includes('Le llamamos a las 7:30'));
  assert.equal((await rec.patch(`/api/staff/requests/${id}`, { status: 'hacked' })).data.request.status, 'confirmed', 'unknown status ignored');
  const events = await rec.get(`/api/staff/requests/${id}/events`);
  assert.deepEqual(events.data.events.map((e) => e.event), ['created', 'status', 'note']);
});

test('A-08: guest requests are rate limited and validated', async () => {
  const g = client(app.base);
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await g.post('/api/h/default/requests', { room: '202', type: 'other', guestKey: guestKey(9) })).status);
  assert.equal(codes.filter((c) => c === 201).length, 6);
  assert.equal(codes.at(-1), 429);
  const g2 = client(app.base);
  assert.equal((await g2.post('/api/h/default/requests', { room: '', guestKey: guestKey(10) })).status, 400);
  assert.equal((await g2.post('/api/h/default/requests', { room: '<script>', guestKey: guestKey(10) })).status, 400);
});

test('A-06/A-07/A-15: content is validated so nothing executes on guests', async () => {
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const bad = await sa.post('/api/admin/pois', { name: { es: 'Mirador' }, lat: 37.18, lon: -3.59, actions: [{ url: 'javascript:alert(1)', label: { es: 'x' } }, { url: 'https://ok.es', icon: '<img src=x onerror=alert(1)>', label: { es: 'Web' } }, { mode: 'teleport' }, { mode: 'walk' }] });
  assert.equal(bad.status, 201);
  assert.deepEqual(bad.data.item.actions.map((a) => a.url || a.mode), ['https://ok.es/', 'walk']);
  assert.equal(bad.data.item.actions[0].icon, 'open_in_new');
  assert.equal((await sa.post('/api/admin/pois', { name: { es: 'Fuera' }, lat: 200, lon: 0 })).status, 400);
  assert.equal((await sa.post('/api/admin/pois', { lat: 37, lon: -3 })).status, 400, 'name required');
  const svc = await sa.post('/api/admin/services', { name: { es: 'Bar' }, icon: '"><script>', photo: 'javascript:x' });
  assert.equal(svc.data.item.icon, 'room_service');
  assert.equal(svc.data.item.photo, '');
  const act = await sa.post('/api/admin/actions', { name: { es: 'Taxi' }, key: 'taxi2', fields: ['when', 'onclick'], tel: '1"><svg onload=1>' });
  assert.deepEqual(act.data.item.fields, ['when']);
  assert.equal(act.data.item.tel, '1 1');
  const dup = await sa.post('/api/admin/rooms', { number: '101' });
  assert.equal(dup.status, 400);
  assert.equal(dup.data.error, 'already exists', 'no raw SQLite message');
});

test('A-12: webhook cannot target internal networks', async () => {
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const h = (await sa.get('/api/admin/hotel')).data.hotel;
  for (const url of ['http://127.0.0.1:4180/api', 'http://169.254.169.254/latest/meta-data', 'http://localhost/x', 'file:///etc/passwd']) {
    const r = await sa.put('/api/admin/hotel', { ...h, webhookUrl: url });
    assert.equal(r.status, 400, url);
  }
  assert.equal((await sa.put('/api/admin/hotel', { ...h, notifyEmail: 'no-es-email' })).status, 400);
  assert.equal((await sa.put('/api/admin/hotel', { ...h, webhookUrl: '' })).status, 200);
});

test('A-14: cross-site state changes are refused', async () => {
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  assert.equal((await sa.post('/api/auth/logout-all', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await sa.post('/api/auth/logout-all', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await sa.get('/api/auth/me')).status, 200, 'still signed in');
});

test('security headers are present', async () => {
  const r = await fetch(`${app.base}/api/h/default/config`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('referrer-policy'));
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('photo upload: only real images, admins only', async () => {
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ok = await sa.post('/api/admin/upload', { dataUrl: png });
  assert.equal(ok.status, 201);
  const img = await fetch(app.base + ok.data.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const fake = await sa.post('/api/admin/upload', { dataUrl: `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` });
  assert.equal(fake.status, 400);
  assert.equal((await sa.post('/api/admin/upload', { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
});

test('chat: guest ↔ staff, keys never cross hotels, flood limited', async () => {
  const g = client(app.base);
  const key = guestKey(20);
  const first = await g.post('/api/h/default/chat', { key, body: '¿A qué hora cierra la piscina?', room: '102', lang: 'es' });
  assert.equal(first.status, 201);
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const list = await sa.get('/api/staff/chats');
  assert.ok(list.data.chats.some((c) => c.key === key));
  assert.equal((await sa.post(`/api/staff/chats/${key}`, { body: 'A las 21:00' })).status, 201);
  const mine = await g.get(`/api/h/default/chat?key=${key}`);
  assert.ok(mine.data.messages.some((m) => m.author === 'staff' && m.body === 'A las 21:00'));
  assert.equal((await g.post('/api/h/default/chat', { key: 'short', body: 'x' })).status, 400);
});

test('anonymous usage stats and admin dashboard', async () => {
  const g = client(app.base);
  const r = await g.post('/api/h/default/events', { lang: 'en', events: [{ kind: 'open' }, { kind: 'view_poi', ref: 'alhambra' }, { kind: 'bogus' }] });
  assert.ok([200, 204].includes(r.status));
  const sa = client(app.base);
  await sa.post('/api/auth/login', { email: 'admin@hotel.local', password: STRONG });
  const s = await sa.get('/api/admin/stats?days=7');
  assert.equal(s.status, 200);
  assert.ok(s.data.topPois.some((p) => p.k === 'alhambra'));
});
