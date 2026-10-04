/** Boots the concierge app on a random port with a throw-away database. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConciergeApp } from '../../server/app/index.js';

export async function startApp({ env = {}, mailer } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'concierge-test-'));
  const fullEnv = { NODE_ENV: 'test', CONCIERGE_DB: path.join(dir, 'db.sqlite'), CONCIERGE_SECRET: 'test-secret', CONCIERGE_GTFS_DIR: path.join(dir, 'gtfs'), ...env };
  const log = console.log;
  console.log = () => {};
  const { app, db } = createConciergeApp({ env: fullEnv, mailer, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  console.log = log;
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    db,
    dir,
    async close() {
      await new Promise((r) => server.close(r));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Tiny cookie-aware client. */
export function client(base) {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    let data = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b = {}, h) => call('POST', u, b, h),
    put: (u, b = {}, h) => call('PUT', u, b, h),
    patch: (u, b = {}, h) => call('PATCH', u, b, h),
    del: (u, h) => call('DELETE', u, undefined, h),
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
  };
}

export const STRONG = 'Granada2026luna';

/** Signs in the bootstrap superadmin and replaces the default password. */
export async function superadmin(base) {
  const c = client(base);
  await c.post('/api/auth/login', { email: 'admin@hotel.local', password: 'admin1234' });
  await c.post('/api/auth/password', { current: 'admin1234', next: STRONG });
  return c;
}

/** Creates a hotel admin (password already changed) and returns its client. */
export async function hotelUser(base, sa, { email, role = 'admin' }) {
  const temp = 'Temporal12345';
  const r = await sa.post('/api/admin/users', { email, password: temp, role, name: role });
  if (r.status !== 201) throw new Error(JSON.stringify(r.data));
  const c = client(base);
  await c.post('/api/auth/login', { email, password: temp });
  await c.post('/api/auth/password', { current: temp, next: STRONG + role });
  return c;
}
export const guestKey = (n = 1) => `guestdevicekey${String(n).padStart(6, '0')}`;
