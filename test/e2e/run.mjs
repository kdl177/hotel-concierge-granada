#!/usr/bin/env node
/**
 * End-to-end test of the concierge on the PRODUCTION build (real server, real
 * browser): admin → reception → guest flows, account security screens, a11y
 * (axe-core, WCAG 2 A/AA) and zero same-origin console errors.
 *
 *   npm run build && npm run test:e2e:concierge
 *   E2E_CHROME=/path/to/chrome  (optional; default: Puppeteer's browser)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
if (!existsSync(path.join(root, 'dist/index.html'))) {
  console.error('dist/ missing: run `npm run build` first');
  process.exit(2);
}
const PORT = 4197;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'admin@hotel.local', temp: 'Arranque2026x', pass: 'Granada2026luna' };
const dir = mkdtempSync(path.join(tmpdir(), 'concierge-e2e-'));
const gtfs = path.join(root, 'data/gtfs');
const server = spawn(process.execPath, ['server/app/main.js'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), HOST: '127.0.0.1', CONCIERGE_DB: path.join(dir, 'e2e.sqlite'), CONCIERGE_SECRET: 'e2e', CONCIERGE_INSECURE_COOKIES: '1', ADMIN_PASSWORD: ADMIN.temp, CONCIERGE_GTFS_DIR: existsSync(gtfs) ? gtfs : path.join(dir, 'gtfs'), PROVIDER_RATE_PER_MIN: '500' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
for (let i = 0; i < 60; i++) {
  if (serverLog.includes('listening on')) break;
  await new Promise((r) => setTimeout(r, 250));
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.E2E_CHROME || undefined,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--lang=es-ES'],
});

const results = [];
let expected401 = false; // the deliberate wrong-password attempt
const problems = [];
const ok = (name, detail = '') => {
  results.push({ name, ok: true });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
};
function watch(page, tag) {
  // Only so axe-core can be injected for the audit; the app itself runs under the real CSP headers.
  page.setBypassCSP(true);
  page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const url = m.location()?.url || '';
    const text = m.text();
    // External services (map tiles, fonts, Open-Meteo…) may be unreachable in CI: only our own origin counts.
    if (url && !url.startsWith(BASE)) return;
    if (expected401 && url.endsWith('/api/auth/login')) return;
    if (/Failed to load resource/.test(text) && url && !url.startsWith(BASE)) return;
    if (m.type() === 'warning' && !/Content Security Policy|deprecated/i.test(text)) return;
    problems.push(`${tag} console.${m.type()}: ${text.slice(0, 200)} ${url}`);
  });
  page.on('response', (r) => {
    if (expected401 && r.url().endsWith('/api/auth/login') && r.status() === 401) return;
    if (r.url().startsWith(BASE) && r.status() >= 400 && !r.url().includes('/api/route') && !r.url().includes('/api/geocode') && !r.url().includes('/api/google')) problems.push(`${tag} HTTP ${r.status()} ${r.url()}`);
  });
}
async function axe(page, label) {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, t: x.nodes[0]?.target?.join(' ') })));
  const serious = v.filter((x) => x.impact === 'serious' || x.impact === 'critical');
  if (serious.length) problems.push(`axe ${label}: ${serious.map((x) => `${x.id}×${x.n} (${x.t})`).join(', ')}`);
  ok(`a11y ${label}`, `${v.length} findings, ${serious.length} serious/critical`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Tap inside the guest's scrollable sheet (scrolls the element into view first). */
async function tap(page, sel) {
  const el = await page.waitForSelector(sel, { timeout: 15000 });
  await el.evaluate((e) => {
    e.scrollIntoView({ block: 'center' });
    e.click();
  });
}
async function clickText(page, selector, text) {
  const handles = await page.$$(selector);
  for (const h of handles) if ((await h.evaluate((e) => e.textContent)).includes(text)) return h.click();
  throw new Error(`no ${selector} with "${text}"`);
}

let exitCode = 0;
try {
  // ---------- 1. Admin: forced password change, staff account, room link ----------
  const adminCtx = await browser.createBrowserContext();
  const admin = await adminCtx.newPage();
  await admin.setViewport({ width: 1366, height: 900 });
  watch(admin, 'admin');
  await admin.goto(`${BASE}/admin.html`, { waitUntil: 'networkidle2' });
  await admin.waitForSelector('input[name=email]');
  await axe(admin, 'login');
  await admin.type('input[name=email]', ADMIN.email);
  await admin.type('input[name=password]', 'wrong-password');
  expected401 = true;
  await admin.click('button[type=submit]');
  await admin.waitForFunction(() => document.querySelector('[data-err]')?.textContent.includes('incorrectos'));
  await sleep(200);
  expected401 = false;
  ok('wrong password shows an error');
  await admin.$eval('input[name=password]', (e) => (e.value = ''));
  await admin.type('input[name=password]', ADMIN.temp);
  await admin.click('button[type=submit]');
  await admin.waitForSelector('input[name=next]');
  ok('first sign-in asks to change the temporary password');
  await axe(admin, 'change password');
  await admin.type('input[name=current]', ADMIN.temp);
  await admin.type('input[name=next]', ADMIN.pass);
  await admin.type('input[name=again]', ADMIN.pass);
  await admin.click('button[type=submit]');
  await admin.waitForSelector('[data-hotel-form]');
  ok('admin panel opens after the change');
  await axe(admin, 'admin hotel');
  await admin.click('[data-tab=users]');
  await admin.waitForSelector('[data-new]');
  await admin.click('[data-new]');
  await admin.waitForSelector('.modal input[name=email]');
  await admin.type('.modal input[name=name]', 'Lucía Recepción');
  await admin.type('.modal input[name=email]', 'lucia@luna.es');
  await admin.select('.modal select[name=role]', 'reception');
  await admin.type('.modal input[name=password]', 'Temporal12345');
  await admin.click('.modal button[type=submit]');
  await admin.waitForFunction(() => [...document.querySelectorAll('td')].some((td) => td.textContent.includes('lucia@luna.es')));
  ok('reception user created', 'shown with "Contraseña temporal"');
  await axe(admin, 'admin users');
  // Production starts with no demo rooms: create the real one through the Rooms tab.
  await admin.click('[data-tab=rooms]');
  await admin.waitForSelector('[data-new]');
  if (await admin.$('table.table td[colspan]')) ok('rooms tab empty state in production (no demo data)');
  await admin.click('[data-new]');
  await admin.waitForSelector('.modal input[name=number]');
  await admin.type('.modal input[name=number]', '204');
  await admin.type('.modal input[name=floor]', '2');
  await admin.click('.modal button[type=submit]');
  await admin.waitForFunction(() => [...document.querySelectorAll('td')].some((td) => td.textContent.trim().startsWith('204')));
  const roomLink = await admin.evaluate(async () => (await (await fetch('/api/admin/rooms')).json()).items.find((r) => r.number === '204').url);
  const roomUrl = BASE + new URL(roomLink, 'http://x').pathname + new URL(roomLink, 'http://x').search;
  ok('room 204 QR link', roomUrl.replace(BASE, ''));
  await admin.click('[data-tab=stats]').catch(() => {});

  // ---------- 2. Reception signs in (forced change) ----------
  const recCtx = await browser.createBrowserContext();
  const rec = await recCtx.newPage();
  await rec.setViewport({ width: 1280, height: 860 });
  watch(rec, 'reception');
  await rec.goto(`${BASE}/reception.html`, { waitUntil: 'networkidle2' });
  await rec.waitForSelector('input[name=email]');
  await rec.type('input[name=email]', 'lucia@luna.es');
  await rec.type('input[name=password]', 'Temporal12345');
  await rec.click('button[type=submit]');
  await rec.waitForSelector('input[name=next]');
  await rec.type('input[name=current]', 'Temporal12345');
  await rec.type('input[name=next]', 'Recepcion2026');
  await rec.type('input[name=again]', 'Recepcion2026');
  await rec.click('button[type=submit]');
  await rec.waitForSelector('main#main');
  ok('reception inbox opens after its own password change');

  // ---------- 3. Guest on a phone, identified by the room QR ----------
  const guestCtx = await browser.createBrowserContext();
  const guest = await guestCtx.newPage();
  await guest.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  watch(guest, 'guest');
  await guest.goto(roomUrl, { waitUntil: 'domcontentloaded' });
  await guest.waitForSelector('.cg-tabs', { timeout: 45000 });
  await sleep(1500);
  await axe(guest, 'guest home');
  await tap(guest, '[data-action=filter-cat][data-cat=all]');
  await guest.waitForSelector('[data-action=catalog-sort]');
  const total = await guest.$$eval('.cg-list .cg-card', (c) => c.length);
  await tap(guest, '[data-action=catalog-toggle][data-key=indoor]');
  const indoor = await guest.$$eval('.cg-list .cg-card', (c) => c.length);
  if (!(total >= 10 && indoor > 0 && indoor < total)) throw new Error(`catalog filter: ${total} → ${indoor}`);
  ok('catalog with filters', `${total} places, ${indoor} indoors`);
  await axe(guest, 'guest catalog');
  await tap(guest, '[data-action=catalog-toggle][data-key=indoor]');
  await tap(guest, '[data-action=catalog-sort][data-sort=dist]');
  await tap(guest, '.cg-card[data-id=alhambra]');
  await guest.waitForSelector('.cg-act[data-action=request]');
  ok('Alhambra detail with action buttons');
  await axe(guest, 'guest place');
  await tap(guest, '.cg-act[data-action=request]');
  await guest.waitForSelector('form[data-role=request-form] input[name=room]');
  const roomVal = await guest.$eval('form[data-role=request-form] input[name=room]', (e) => e.value);
  // Re-rendering (here: switching language) must keep what the guest is typing.
  await guest.$eval('form[data-role=request-form] textarea[name=details]', (e) => { e.value = 'Dos adultos, por la mañana'; });
  await tap(guest, '[data-lang=en]');
  await tap(guest, '[data-lang=es]');
  const kept = await guest.$eval('form[data-role=request-form] textarea[name=details]', (e) => e.value);
  if (kept !== 'Dos adultos, por la mañana') throw new Error(`form text lost on re-render: "${kept}"`);
  ok('typed text survives a re-render of the panel');
  if (roomVal !== '204') throw new Error(`room not prefilled: ${roomVal}`);
  await tap(guest, 'form[data-role=request-form] button[type=submit]');
  await guest.waitForSelector('.cg-toast');
  ok('guest sends a ticket request (room prefilled from QR)');
  await tap(guest, '[data-tab=tasks]');
  await guest.waitForSelector('.cg-req');
  await axe(guest, 'guest tasks');

  // ---------- 4. Reception confirms with a note → guest sees it ----------
  await rec.waitForFunction(() => document.querySelectorAll('.card.pending').length >= 1, { timeout: 20000 });
  ok('request arrives at reception');
  await axe(rec, 'reception inbox');
  await rec.click('.card.pending [data-status=confirmed]');
  await rec.waitForFunction(() => document.querySelectorAll('.card.pending').length === 0, { timeout: 10000 });
  ok('reception confirms the request');
  await guest.waitForFunction(() => document.querySelector('.cg-req')?.className.includes('confirmed'), { timeout: 40000 });
  ok('guest sees the request confirmed');

  // ---------- 5. Account security UI ----------
  const anon = await (await browser.createBrowserContext()).newPage();
  watch(anon, 'forgot');
  await anon.goto(`${BASE}/reception.html`, { waitUntil: 'networkidle2' });
  await anon.click('[data-forgot]');
  await anon.type('input[name=email]', 'lucia@luna.es');
  await anon.click('button[type=submit]');
  await anon.waitForFunction(() => document.querySelector('.notice')?.textContent.includes('Admin'));
  ok('forgot password explains the no-SMTP path');
  await admin.goto(`${BASE}/admin.html`, { waitUntil: 'networkidle2' });
  await admin.waitForSelector('[data-account]');
  await admin.click('[data-account]');
  await admin.waitForSelector('.modal [data-signout-all]');
  ok('account menu (change password / sign out everywhere)');
  await admin.keyboard.press('Escape');

  // ---------- 5b. Kiosk mode: attract screen, reset, take-away QR ----------
  const kiosk = await (await browser.createBrowserContext()).newPage();
  await kiosk.setViewport({ width: 1366, height: 860 });
  watch(kiosk, 'kiosk');
  await kiosk.goto(`${BASE}/?kiosk=1&idle=30`, { waitUntil: 'domcontentloaded' });
  await kiosk.waitForSelector('.cg-sheet', { timeout: 45000 });
  await sleep(1500);
  await kiosk.click('[data-lang=en]');
  await kiosk.evaluate(() => document.querySelector('.cg-panel .cg-card[data-id=alhambra]').click());
  await kiosk.waitForSelector('.cg-takeaway img');
  const qr = await fetch(`${BASE}/api/h/gran-hotel-luna-granada/qr.svg?p=alhambra`);
  if (qr.status !== 200 || !(await qr.text()).includes('<svg')) throw new Error('take-away QR missing');
  ok('kiosk: place view offers a QR to take it on the phone');
  await kiosk.evaluate(() => document.querySelector('[data-action=toggle-plan]').click());
  await kiosk.waitForFunction(() => document.querySelector('.cg-attract') && !document.querySelector('.cg-attract').hidden, { timeout: 45000 });
  const wiped = await kiosk.evaluate(() => ({ plan: localStorage.getItem('concierge.plan'), lang: document.documentElement.lang, hidden: getComputedStyle(document.getElementById('cg-app')).display }));
  if (wiped.plan !== null || wiped.lang !== 'es' || wiped.hidden !== 'none') throw new Error(`kiosk reset incomplete: ${JSON.stringify(wiped)}`);
  ok('kiosk: after idle it shows the attract screen and forgets the previous guest');
  await kiosk.mouse.click(683, 430);
  await kiosk.waitForFunction(() => document.querySelector('.cg-attract').hidden);
  ok('kiosk: a tap wakes it on the home screen');

  // ---------- 6. Production surface ----------
  for (const [url, want] of [['/console.html', 404], ['/api/realtime/token', 404], ['/api/setup/status', 404], ['/manifest.webmanifest', 200], ['/robots.txt', 200]]) {
    const r = await fetch(BASE + url);
    if (r.status !== want) throw new Error(`${url} → ${r.status}, expected ${want}`);
  }
  ok('production publishes only the concierge surface');
} catch (error) {
  exitCode = 1;
  console.error('\n✗ E2E failure:', error.message);
}
await browser.close();
server.kill();
rmSync(dir, { recursive: true, force: true });
if (problems.length) {
  exitCode = 1;
  console.error(`\n✗ ${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
}
console.log(`\n${results.length} checks passed${exitCode ? ', with failures' : ', 0 console errors, 0 serious a11y issues'}`);
process.exit(exitCode);
