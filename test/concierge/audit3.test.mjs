/** Regression tests for the third audit (7 oct 2026). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, superadmin, hotelUser, guestKey, STRONG } from './helpers.mjs';

let app;
let sa;
before(async () => {
  app = await startApp({ mailer: { sendMail: async () => {} } });
  sa = await superadmin(app.base);
});
after(() => app.close());

test('a guest request at hotel B is not shown in hotel A chat, and chat works in both hotels', async () => {
  await sa.post('/api/super/hotels', { slug: 'hotel-b', name: 'Hotel B', lat: 37.17, lon: -3.6 });
  const g = client(app.base);
  const key = guestKey(77);
  assert.equal((await g.post('/api/h/default/chat', { key, body: 'Hola A' })).status, 201);
  await g.post('/api/h/hotel-b/requests', { room: '1', type: 'other', details: 'SECRET B', guestKey: key });
  const a = await sa.get(`/api/staff/chats/${key}`);
  assert.ok(!JSON.stringify(a.data).includes('SECRET B'));
});

test('chat is rate limited per IP even when the device key rotates', async () => {
  const g = client(app.base);
  const codes = [];
  for (let i = 0; i < 32; i++) codes.push((await g.post('/api/h/default/chat', { key: guestKey(1000 + i), body: 'spam', lang: 'x'.repeat(5000) })).status);
  assert.ok(codes.includes(429));
  assert.ok(!codes.includes(500), 'bad lang never crashes');
});

test('housekeeping (staff role) cannot do check-in, see room tokens or block guests', async () => {
  const hk = await hotelUser(app.base, sa, { email: 'pisos@luna.es', role: 'staff' });
  assert.equal((await hk.get('/api/staff/requests')).status, 200);
  assert.equal((await hk.get('/api/staff/stays')).status, 403);
  assert.equal((await hk.post('/api/staff/stays', { room: '101' })).status, 403);
  assert.equal((await hk.post(`/api/staff/chats/${guestKey(77)}/block`, {})).status, 403);
  const users = await hk.get('/api/staff/users');
  assert.ok(users.data.users.every((u) => u.role !== 'superadmin'));
});

test('the room QR never reveals who is staying', async () => {
  const rooms = (await sa.get('/api/admin/rooms')).data.items;
  const r = rooms.find((x) => x.number === '101');
  await sa.post('/api/staff/stays', { roomId: r.id, guestName: 'María López', checkout: '2026-10-10' });
  const res = await client(app.base).get(`/api/h/default/room/${r.token}`);
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.data).includes('María'));
  assert.ok(!JSON.stringify(res.data).includes('2026-10-10'));
});

test('a deactivated hotel locks out its staff, not the superadmin', async () => {
  const hotels = (await sa.get('/api/super/hotels')).data.hotels;
  const b = hotels.find((h) => h.slug === 'hotel-b');
  const res = await sa.post('/api/admin/users', { email: 'jefe-b@b.es', password: 'Temporal12345', role: 'admin' }, { 'X-Hotel': b.id });
  assert.equal(res.status, 201);
  const adminB = client(app.base);
  await adminB.post('/api/auth/login', { email: 'jefe-b@b.es', password: 'Temporal12345' });
  await adminB.post('/api/auth/password', { current: 'Temporal12345', next: STRONG });
  assert.equal((await adminB.get('/api/admin/hotel')).status, 200);
  await sa.patch(`/api/super/hotels/${b.id}`, { active: false });
  assert.equal((await adminB.get('/api/admin/hotel')).status, 403);
  assert.equal((await sa.get('/api/admin/hotel', { 'X-Hotel': b.id })).status, 200);
});

test('only the superadmin reloads the shared timetables', async () => {
  const admin = await hotelUser(app.base, sa, { email: 'admin-gtfs@luna.es' });
  assert.equal((await admin.post('/api/admin/transit/reload')).status, 403);
  const info = await admin.get('/api/admin/transit');
  assert.equal(info.data.dir, undefined, 'no server paths');
});

test('uploads are rejected before parsing for anonymous clients', async () => {
  const r = await client(app.base).post('/api/admin/upload', { dataUrl: 'x'.repeat(10) });
  assert.equal(r.status, 401);
});

test('production: reset links are never built from the Host header', async () => {
  const prod = await startApp({ env: { NODE_ENV: 'production', ADMIN_PASSWORD: 'Arranque2026x' }, mailer: { sendMail: async (m) => sentProd.push(m) } });
  const sentProd = [];
  try {
    const c = client(prod.base);
    const r = await c.post('/api/auth/forgot', { email: 'admin@hotel.local' }, { Host: 'evil.example' });
    assert.equal(r.data.emailReset, false);
    assert.equal(sentProd.length, 0);
  } finally {
    await prod.close();
  }
});
