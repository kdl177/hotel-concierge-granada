import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, safeUrl, safeIcon, safePhone, checkWebhookUrl, privateIp, EMAIL_RE } from '../../server/app/security.js';
import { hashPassword, verifyPassword, createSessions } from '../../server/app/auth.js';

test('limiter blocks after max hits and reports retry time', () => {
  const l = createLimiter({ windowMs: 60_000, max: 3 });
  assert.equal(l.hit('a').ok, true);
  l.hit('a');
  l.hit('a');
  const r = l.hit('a');
  assert.equal(r.ok, false);
  assert.ok(r.retryAfterS > 0 && r.retryAfterS <= 60);
  assert.equal(l.hit('b').ok, true, 'buckets are independent');
  l.reset('a');
  assert.equal(l.hit('a').ok, true);
});

test('safeUrl only keeps http(s) or same-origin paths', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,x'), '');
  assert.equal(safeUrl('https://tickets.alhambra-patronato.es/'), 'https://tickets.alhambra-patronato.es/');
  assert.equal(safeUrl('/uploads/a/b.jpg'), '');
  assert.equal(safeUrl('/uploads/a/b.jpg', { allowPath: true }), '/uploads/a/b.jpg');
  assert.equal(safeUrl('//evil.com/x', { allowPath: true }), '');
  assert.equal(safeUrl('/x" onerror="y', { allowPath: true }), '');
});

test('icon and phone sanitizers', () => {
  assert.equal(safeIcon('<img src=x onerror=1>', 'spa'), 'spa');
  assert.equal(safeIcon('local_taxi', 'x'), 'local_taxi');
  assert.equal(safePhone('+34 958 "><svg/onload=1>'), '+34 958 1');
});

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.equal(privateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.215.14', '2a00:1450::1']) assert.equal(privateIp(ip), false, ip);
});

test('webhook URLs: https only in production, no internal targets (also after DNS)', async () => {
  const pub = async () => [{ address: '93.184.215.14' }];
  const internal = async () => [{ address: '10.0.0.5' }];
  assert.equal((await checkWebhookUrl('', { production: true })).ok, true);
  assert.equal((await checkWebhookUrl('http://hooks.example.com/x', { production: true, resolve: pub })).ok, false);
  assert.equal((await checkWebhookUrl('https://hooks.example.com/x', { production: true, resolve: pub })).ok, true);
  assert.equal((await checkWebhookUrl('https://intranet.example.com/x', { production: true, resolve: internal })).ok, false);
  assert.equal((await checkWebhookUrl('https://169.254.169.254/latest', { production: true })).ok, false);
  assert.equal((await checkWebhookUrl('https://localhost/x', { production: true })).ok, false);
  assert.equal((await checkWebhookUrl('https://user:pw@hooks.example.com', { production: true, resolve: pub })).ok, false);
  assert.equal((await checkWebhookUrl('ftp://x', { production: false })).ok, false);
});

test('email regex', () => {
  assert.ok(EMAIL_RE.test('recepcion@hotel-luna.es'));
  assert.ok(!EMAIL_RE.test('a@b'));
  assert.ok(!EMAIL_RE.test('<x>@y.es'));
});

test('scrypt hashes verify and differ per salt', () => {
  const a = hashPassword('Granada2026luna');
  assert.notEqual(a, hashPassword('Granada2026luna'));
  assert.ok(verifyPassword('Granada2026luna', a));
  assert.ok(!verifyPassword('granada2026luna', a));
  assert.ok(!verifyPassword('x', 'garbage'));
});

test('session tokens are signed, expire and carry the session version', () => {
  const s = createSessions({ secret: 'k', ttlMs: 1000 });
  const tok = s.issue({ id: 'u1', session_version: 3 });
  assert.deepEqual({ uid: s.read(tok).uid, sv: s.read(tok).sv }, { uid: 'u1', sv: 3 });
  const [body] = tok.split('.');
  assert.equal(s.read(`${body}.forged`), null);
  const other = createSessions({ secret: 'other' });
  assert.equal(other.read(tok), null);
  const expired = createSessions({ secret: 'k', ttlMs: -1 }).issue({ id: 'u1' });
  assert.equal(s.read(expired), null);
});

test('SSRF: IPv4 hidden inside IPv6 literals is refused', async () => {
  for (const ip of ['::ffff:7f00:1', '::7f00:1', '64:ff9b::7f00:1', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1', 'ff02::1', 'fe80::1']) assert.equal(privateIp(ip), true, ip);
  assert.equal(privateIp('64:ff9b::808:808'), false);
  for (const u of ['https://[::ffff:7f00:1]/', 'https://[::ffff:a9fe:a9fe]/latest', 'https://[64:ff9b::7f00:1]/']) assert.equal((await checkWebhookUrl(u, { production: true })).ok, false, u);
});
