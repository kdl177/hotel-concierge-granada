#!/usr/bin/env node
/**
 * End-to-end test of the concierge on the PRODUCTION build (real server, real
 * browser): admin → reception → guest flows, account security screens, a11y
 * (axe-core, WCAG 2 A/AA) and zero same-origin console errors.
 *
 *   npm run build && npm run test:e2e:concierge
 *   E2E_CHROME=/path/to/chrome  (optional; default: the system Chrome on Windows if installed, else Puppeteer's browser)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Puppeteer's own Chromium may live on a slow disk (P-15): on Windows prefer the installed Chrome.
const systemChrome = process.platform === 'win32' ? path.join(process.env['ProgramFiles'] || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe') : '';
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
  executablePath: process.env.E2E_CHROME || [systemChrome].find(existsSync),
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
// E2E_SHOTS=<dir> also saves a screenshot of every audited screen, for visual review.
async function axe(page, label) {
  if (process.env.E2E_SHOTS) {
    mkdirSync(process.env.E2E_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${label.replace(/[^a-z0-9]+/gi, '-')}.png`) });
  }
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
  await admin.goto(`${BASE}/reception.html#hotel`, { waitUntil: 'networkidle2' });
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
  // One back-office for every role: the tabs each role sees.
  const recTabs = await rec.$$eval('.tabs [data-tab]', (b) => b.map((x) => x.dataset.tab));
  if (recTabs.join() !== 'inbox,chats,stays') throw new Error(`reception tabs: ${recTabs.join()}`);
  const adminTabs = await admin.$$eval('.tabs [data-tab]', (b) => b.map((x) => x.dataset.tab));
  if (adminTabs.join() !== 'inbox,chats,stays,hotel,services,actions,pois,rooms,users,stats,hotels') throw new Error(`superadmin tabs: ${adminTabs.join()}`);
  const staffMade = await admin.evaluate(async () => (await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Paco Personal', email: 'paco@luna.es', role: 'staff', password: 'Temporal12345' }) })).status);
  if (staffMade !== 200 && staffMade !== 201) throw new Error(`staff user: HTTP ${staffMade}`);
  const staff = await (await browser.createBrowserContext()).newPage();
  watch(staff, 'staff');
  await staff.goto(`${BASE}/reception.html#stays`, { waitUntil: 'networkidle2' }); // a tab this role does not have
  await staff.type('input[name=email]', 'paco@luna.es');
  await staff.type('input[name=password]', 'Temporal12345');
  await staff.click('button[type=submit]');
  await staff.waitForSelector('input[name=next]');
  await staff.type('input[name=current]', 'Temporal12345');
  await staff.type('input[name=next]', 'Personal2026ok');
  await staff.type('input[name=again]', 'Personal2026ok');
  await staff.click('button[type=submit]');
  await staff.waitForSelector('.tabs [data-tab]');
  const staffTabs = await staff.$$eval('.tabs [data-tab]', (b) => b.map((x) => x.dataset.tab + (x.classList.contains('on') ? '*' : '')));
  if (staffTabs.join() !== 'inbox*,chats') throw new Error(`staff tabs: ${staffTabs.join()}`);
  await staff.close();
  ok('one back-office, tabs by role: staff inbox+chat, reception +stays, superadmin +8 configuration tabs', `#stays for staff fell back to the inbox`);

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
  // The texts checked below are Spanish: pick the language explicitly (the CI runner's browser starts in English).
  await tap(guest, '[data-lang=es]');
  await guest.waitForFunction(() => /A pie/.test(document.querySelector('[data-action="mode"][data-mode="walk"]')?.textContent || ''), { timeout: 20000 });
  // Walking directions in the guest's language, every step with distance and time (OSRM is external: skipped when it does not answer).
  const walkLi = await guest.waitForSelector('[data-role="route"] .cg-steps li', { timeout: 20000 }).catch(() => null);
  if (walkLi) {
    const checkSteps = async (first, leak) => {
      const items = await guest.$$eval('[data-role="route"] .cg-steps li', (els) => els.map((e) => e.textContent.trim()));
      if (!items[0].startsWith(first)) throw new Error(`walk steps: first step is "${items[0]}"`);
      const bad = items.filter((x, i) => (i < items.length - 1 && !/(\d+ m|\d+\.\d km) · \d+ min$/.test(x)) || leak.test(x) || /undefined|NaN/.test(x));
      if (bad.length) throw new Error(`walk steps: ${bad.slice(0, 3).join(' | ')}`);
      return items.length;
    };
    const nSteps = await checkSteps('Salga del hotel', /\b(Turn|Continue|Head)\b/);
    await tap(guest, '[data-lang=en]');
    await guest.waitForFunction(() => document.querySelector('[data-role="route"] .cg-steps li')?.textContent.startsWith('Leave the hotel'), { timeout: 20000 });
    await checkSteps('Leave the hotel', /\b(Gire|Siga|Salga)\b/);
    await tap(guest, '[data-lang=es]');
    await guest.waitForFunction(() => document.querySelector('[data-role="route"] .cg-steps li')?.textContent.startsWith('Salga del hotel'), { timeout: 20000 });
    ok("walking directions read in the guest's language, each step with distance and time", `${nSteps} steps to the Alhambra`);
  } else ok('walking directions skipped: the OSRM routing service did not answer');
  // Bus is bus: transit mode shows a bus/metro itinerary even though walking is about as fast; walking is only a note under it.
  await tap(guest, '[data-action="mode"][data-mode="transit"]');
  if (existsSync(gtfs)) {
    await guest.waitForSelector('[data-role="route"] .cg-tl-item.ride', { timeout: 20000 });
    const note = await guest.$eval('[data-role="route"] .cg-walknote', (e) => e.textContent.trim()).catch(() => '');
    if (!/a pie/i.test(note)) throw new Error(`transit: walking note missing under the itinerary: "${note}"`);
    if (await guest.$('[data-role="route"] .cg-walkbetter')) throw new Error('transit mode replaced the itinerary with "better on foot"');
    ok('transit to the Alhambra: bus itinerary shown, walking only as a note', note);
  } else {
    await guest.waitForFunction(() => /No hay bus|no configurados/.test(document.querySelector('[data-role="route"]')?.textContent || ''), { timeout: 20000 });
    ok('transit without GTFS data on this machine: honest message, no itinerary invented');
  }
  await tap(guest, '[data-action="mode"][data-mode="walk"]');
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
  // No line at all (Sierra Nevada is outside the Metro and city-bus timetables): say so and offer the walk.
  if (existsSync(gtfs)) {
    await tap(guest, '[data-tab=explore]');
    await tap(guest, '[data-action="back"]'); // from the Alhambra back to the catalog
    if (!(await guest.waitForSelector('.cg-card[data-id=sierra-nevada]', { timeout: 5000 }).catch(() => null)))
      await tap(guest, '[data-action=filter-cat][data-cat=all]');
    await tap(guest, '.cg-card[data-id=sierra-nevada]');
    await guest.waitForSelector('[data-role="route"]');
    await tap(guest, '[data-action="mode"][data-mode="transit"]');
    await guest.waitForSelector('[data-role="route"] .cg-walkbetter', { timeout: 20000 });
    const noLine = await guest.$eval('[data-role="route"] .cg-walkbetter', (e) => ({ txt: e.textContent.replace(/\s+/g, ' ').trim(), walkButton: !!e.querySelector('button[data-mode="walk"]') }));
    if (!noLine.txt.includes('No hay bus ni metro') || !noLine.walkButton) throw new Error(`no-line message: ${JSON.stringify(noLine)}`);
    ok('transit to Sierra Nevada: no line in the timetables, says so and offers the walk', noLine.txt);
    await tap(guest, '[data-tab=tasks]');
  }

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
  await admin.goto(`${BASE}/reception.html`, { waitUntil: 'networkidle2' });
  await admin.waitForSelector('[data-account]');
  await admin.click('[data-account]');
  await admin.waitForSelector('.modal [data-signout-all]');
  ok('account menu (change password / sign out everywhere)');
  await admin.keyboard.press('Escape');
  // Statistics: KPIs and charts render with the real data created above (one request, one chat).
  await admin.click('[data-tab=stats]');
  await admin.waitForSelector('.chart-card');
  const kpis = await admin.$$eval('.kpi-value', (els) => els.map((e) => e.textContent.trim()));
  if (!kpis.length || kpis.every((v) => v === '0' || v === '—')) throw new Error(`stats KPIs: ${kpis.join(' ')}`);
  ok('statistics tab with KPIs and charts', kpis.join(' · '));
  await axe(admin, 'admin stats');

  // ---------- 5a. Reception and Admin on a phone (375 px) ----------
  const phone = { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const settled = (page) => page.waitForFunction(() => document.querySelector('#main')?.children.length && !document.querySelector('#main .boot'));
  const fits = async (page, label) => {
    await sleep(300);
    const m = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, bar: document.querySelector('.bar').offsetHeight, tab: (({ left, right }) => left >= -1 && right <= innerWidth + 1)(document.querySelector('.tabs .on').getBoundingClientRect()) }));
    if (m.w > page.viewport().width || m.bar > 130 || !m.tab) throw new Error(`${label} at ${page.viewport().width}px: page ${m.w}px, header ${m.bar}px, active tab visible ${m.tab}`);
  };
  const adminPhone = await adminCtx.newPage();
  await adminPhone.setViewport(phone);
  watch(adminPhone, 'admin phone');
  await adminPhone.goto(`${BASE}/reception.html`, { waitUntil: 'networkidle2' });
  for (const t of ['hotel', 'users', 'rooms', 'pois', 'stats']) {
    await adminPhone.$eval(`[data-tab=${t}]`, (b) => b.click());
    await settled(adminPhone);
    await fits(adminPhone, `admin ${t}`);
  }
  ok('admin on a phone: no sideways scroll, compact header, active tab in view');
  // Tablet: between the phone and desktop breakpoints the 8 tabs used to stack into a 400px header.
  await adminPhone.setViewport({ ...phone, width: 768, height: 1024 });
  for (const t of ['users', 'pois']) {
    await adminPhone.$eval(`[data-tab=${t}]`, (b) => b.click());
    await settled(adminPhone);
    await fits(adminPhone, `admin ${t}`);
  }
  await adminPhone.setViewport(phone);
  ok('admin on a tablet (768 px): same compact header, places table scrolls inside itself');
  await adminPhone.$eval('[data-tab=pois]', (b) => b.click());
  await settled(adminPhone);
  await axe(adminPhone, 'admin places (phone)');
  await adminPhone.close();
  const recPhone = await recCtx.newPage();
  await recPhone.setViewport(phone);
  watch(recPhone, 'reception phone');
  await recPhone.goto(`${BASE}/reception.html`, { waitUntil: 'networkidle2' });
  await settled(recPhone);
  await fits(recPhone, 'reception inbox');
  await recPhone.$eval('[data-tab=chats]', (b) => b.click());
  await recPhone.waitForSelector('[data-open-chat]', { timeout: 15000 });
  await recPhone.$eval('[data-open-chat]', (b) => b.click());
  await recPhone.waitForSelector('[data-chat-form] textarea');
  await fits(recPhone, 'reception chat');
  const box = await recPhone.$eval('[data-chat-form] textarea', (e) => Math.round(e.getBoundingClientRect().width));
  if (box < 200) throw new Error(`reception chat on a phone: message box ${box}px wide`);
  await axe(recPhone, 'reception chat (phone)');
  await recPhone.$eval('[data-tab=stays]', (b) => b.click());
  await settled(recPhone);
  await fits(recPhone, 'reception stays');
  ok('reception on a phone: inbox, chat and stays fit', `message box ${box}px`);
  await recPhone.setViewport({ ...phone, width: 768, height: 1024 });
  await recPhone.$eval('[data-tab=inbox]', (b) => b.click());
  await settled(recPhone);
  await fits(recPhone, 'reception inbox');
  ok('reception on a tablet (768 px): compact header');
  await recPhone.close();

  // ---------- 5c. Keyboard only: Tab order, visible focus, dialogs, focus kept across live repaints ----------
  const focused = (page) => page.evaluate(() => {
    const e = document.activeElement;
    const ring = (x) => { const cs = getComputedStyle(x); return cs.boxShadow !== 'none' || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0); };
    const r = e.getBoundingClientRect();
    return {
      id: e === document.body ? 'body' : `${e.tagName.toLowerCase()}${[...e.attributes].filter((a) => a.name.startsWith('data-') || a.name === 'name').map((a) => `[${a.name}=${a.value}]`).join('')} "${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 24)}"`,
      // The search box draws its ring on the wrapper (.search:focus-within).
      ring: e !== document.body && (ring(e) || (!!e.closest('.search') && ring(e.closest('.search')))),
      seen: r.width > 0 && r.bottom > 0 && r.top < innerHeight,
      inBar: !!e.closest('.bar'),
      inModal: !!e.closest('.modal'),
      // A ring drawn outside the box (box-shadow spread) is cut off by a scrolling ancestor unless it fits inside it.
      clipped: (() => {
        const sh = getComputedStyle(e).boxShadow;
        if (e === document.body || sh === 'none' || /inset/.test(sh)) return false;
        const spread = Math.max(0, ...(sh.match(/-?[\d.]+px/g) || []).map(parseFloat));
        for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p);
          if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
          const a = p.getBoundingClientRect();
          return r.top - spread < a.top - 0.5 || r.bottom + spread > a.bottom + 0.5 || r.left - spread < a.left - 0.5 || r.right + spread > a.right + 0.5;
        }
        return false;
      })(),
      top: Math.round(r.top),
      left: Math.round(r.left + (e.closest('.tabs')?.scrollLeft || 0)), // the tab strip scrolls on phones: compare positions inside it
    };
  });
  /** Tab from the top of the page until focus leaves it; every stop must show its ring and be on screen, and the header is read row by row, left to right (HTML order, no reading-flow: same in every browser). */
  const tabPage = async (page, label) => {
    await page.evaluate(() => document.activeElement?.blur());
    const stops = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const f = await focused(page);
      if (f.id === 'body' || (stops.length && f.id === stops[0].id)) break;
      stops.push(f);
    }
    const bad = stops.filter((s) => !s.ring || !s.seen);
    if (bad.length) throw new Error(`${label}: focus not visible on ${bad.map((s) => s.id).join(', ')}`);
    const cut = stops.filter((s) => s.clipped);
    if (cut.length) throw new Error(`${label}: focus ring cut off by a scrolling container on ${cut.map((s) => s.id).join(', ')}`);
    const bar = stops.filter((s) => s.inBar);
    const back = bar.findIndex((s, i) => i && (s.top < bar[i - 1].top - 12 || (Math.abs(s.top - bar[i - 1].top) <= 12 && s.left < bar[i - 1].left))); // rows are 40+ px apart; items of different heights sit a few px apart within one
    if (back > 0) throw new Error(`${label}: Tab goes backwards in the header, ${bar[back - 1].id} (top ${bar[back - 1].top}, left ${bar[back - 1].left}) → ${bar[back].id} (top ${bar[back].top}, left ${bar[back].left})`);
    return stops;
  };
  const kbAdmin = await adminCtx.newPage();
  await kbAdmin.setViewport({ width: 1366, height: 900 });
  watch(kbAdmin, 'admin keyboard');
  await kbAdmin.goto(`${BASE}/reception.html`, { waitUntil: 'networkidle2' });
  await kbAdmin.$eval('[data-tab=users]', (b) => b.click());
  await kbAdmin.waitForSelector('[data-new]');
  const adminStops = await tabPage(kbAdmin, 'admin users');
  // isMobile changes reload the page in Puppeteer: go back to the tab after each one.
  const usersTab = async () => {
    await kbAdmin.waitForSelector('[data-tab=users]');
    await kbAdmin.$eval('[data-tab=users]', (b) => b.click());
    await kbAdmin.waitForSelector('[data-new]');
  };
  await kbAdmin.setViewport(phone);
  await usersTab();
  await tabPage(kbAdmin, 'admin users (phone)');
  await kbAdmin.setViewport({ width: 1366, height: 900 });
  await usersTab();
  ok('admin by keyboard: Tab reads the header row by row, focus ring on every stop', `${adminStops.length} stops`);
  // Dialog: focus starts on the first field, Tab and Shift+Tab wrap inside it, Escape gives focus back to the opener.
  await kbAdmin.focus('[data-new]');
  await kbAdmin.keyboard.press('Enter');
  await kbAdmin.waitForSelector('.modal');
  const start = await focused(kbAdmin);
  const fwd = [];
  for (let i = 0; i < 8; i++) {
    await kbAdmin.keyboard.press('Tab');
    fwd.push(await focused(kbAdmin));
  }
  await kbAdmin.keyboard.down('Shift');
  // From the second field back past the first one and "Cerrar" (first in the dialog): wraps to "Guardar".
  for (let i = 0; i < 3; i++) await kbAdmin.keyboard.press('Tab');
  await kbAdmin.keyboard.up('Shift');
  const backTo = await focused(kbAdmin);
  const cycle = [start, ...fwd].map((s) => s.id);
  const closeAt = cycle.findIndex((x) => x.includes('"Cerrar"'));
  if (!start.id.startsWith('input[name=name]')) throw new Error(`dialog opens with focus on ${start.id}`);
  if (![start, ...fwd].every((s) => s.inModal && s.ring)) throw new Error(`dialog Tab escapes or hides focus: ${cycle.join(' → ')}`);
  if (closeAt < 0 || !cycle[closeAt - 1]?.includes('Guardar') || cycle[closeAt + 1] !== cycle[0]) throw new Error(`dialog Tab does not wrap Guardar → Cerrar → first field: ${cycle.join(' → ')}`);
  if (!backTo.id.includes('Guardar')) throw new Error(`Shift+Tab from "Cerrar" goes to ${backTo.id}`);
  await kbAdmin.keyboard.press('Escape');
  await kbAdmin.waitForFunction(() => !document.querySelector('.modal'));
  const after = await focused(kbAdmin);
  if (!after.id.includes('[data-new=') || !after.ring) throw new Error(`after Escape focus is on ${after.id}`);
  ok('dialog by keyboard: starts on the first field, Tab/Shift+Tab stay inside, Escape returns to "Nuevo"');
  await kbAdmin.close();

  const kbRec = await recCtx.newPage();
  await kbRec.setViewport({ width: 1280, height: 860 });
  watch(kbRec, 'reception keyboard');
  await kbRec.goto(`${BASE}/reception.html`, { waitUntil: 'networkidle2' });
  await kbRec.waitForSelector('.card [data-history]');
  await tabPage(kbRec, 'reception inbox');
  await kbRec.$eval('[data-tab=chats]', (b) => b.click());
  await kbRec.waitForSelector('[data-open-chat]', { timeout: 15000 });
  await tabPage(kbRec, 'reception chats');
  await kbRec.$eval('[data-tab=inbox]', (b) => b.click());
  await kbRec.waitForSelector('.card [data-history]');
  for (const vp of [{ width: 768, height: 1024, isMobile: true, hasTouch: true }, phone]) {
    await kbRec.setViewport(vp);
    await kbRec.waitForSelector('.card [data-history]');
    await tabPage(kbRec, `reception inbox (${vp.width} px)`);
  }
  await kbRec.setViewport({ width: 1280, height: 860 });
  await kbRec.waitForSelector('.card [data-history]');
  // Buttons that repaint the cards must not drop the focus to the top of the page.
  await kbRec.focus('.card [data-history]');
  await kbRec.keyboard.press('Enter');
  await kbRec.waitForSelector('.card .events');
  const hist = await focused(kbRec);
  await kbRec.focus('.card [data-status=done]');
  await kbRec.keyboard.press('Enter');
  await kbRec.waitForFunction(() => !document.querySelector('.card [data-status=done]'), { timeout: 10000 });
  const done = await focused(kbRec);
  if (!hist.id.includes('[data-history=')) throw new Error(`after "Historial" focus is on ${hist.id}`);
  if (done.id === 'body' || !done.ring) throw new Error(`after "Hecha" focus is on ${done.id}`);
  ok('reception by keyboard: Tab order and rings, focus stays put when the cards repaint', `after "Hecha": ${done.id}`);
  // A guest message arriving while reception types must not steal the cursor.
  const gk = await guest.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('concierge.guestKey.'))?.[1]);
  await kbRec.$eval('[data-tab=chats]', (b) => b.click());
  await kbRec.waitForSelector(`[data-open-chat="${gk}"]`, { timeout: 15000 });
  await kbRec.$eval(`[data-open-chat="${gk}"]`, (b) => b.click());
  await kbRec.waitForSelector('[data-chat-form] textarea');
  await kbRec.focus('[data-chat-form] textarea');
  await kbRec.keyboard.type('Hola, le');
  const before = await kbRec.$$eval('[data-msgs] .msg', (m) => m.length);
  const sent = await guest.evaluate(async (key) => (await fetch('/api/h/gran-hotel-luna-granada/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, body: '¿A qué hora abre el spa?', lang: 'es' }) })).status, gk);
  if (sent !== 200 && sent !== 201) throw new Error(`guest chat message: HTTP ${sent}`);
  await kbRec.waitForFunction((n) => document.querySelectorAll('[data-msgs] .msg').length > n, { timeout: 15000 }, before);
  await kbRec.keyboard.type(' contesto');
  const draft = await kbRec.evaluate(() => ({ on: document.activeElement.matches('[data-chat-form] textarea'), v: document.activeElement.value }));
  if (!draft.on || draft.v !== 'Hola, le contesto') throw new Error(`reply box after a new guest message: focused ${draft.on}, text "${draft.v}"`);
  ok('reception chat: a new guest message does not take the cursor out of the reply box');
  await kbRec.close();

  // ---------- 5b. Kiosk mode: attract screen, reset, take-away QR ----------
  const kiosk = await (await browser.createBrowserContext()).newPage();
  await kiosk.setViewport({ width: 1366, height: 860 });
  watch(kiosk, 'kiosk');
  await kiosk.goto(`${BASE}/?kiosk=1&idle=30`, { waitUntil: 'domcontentloaded' });
  await kiosk.waitForSelector('.cg-sheet', { timeout: 45000 });
  await sleep(1500);
  await kiosk.click('[data-lang=en]');
  // Home suggestions depend on the time of day, so open the place from the full catalog.
  await tap(kiosk, '[data-action=filter-cat][data-cat=all]');
  await tap(kiosk, '.cg-card[data-id=alhambra]');
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
  const redirect = await (await fetch(`${BASE}/admin.html`)).text();
  if (!/url=\/reception\.html/.test(redirect)) throw new Error('admin.html does not redirect to reception.html');
  ok('production publishes only the concierge surface; admin.html redirects to reception.html');

  // ---------- 7. Superadmin with several hotels: the selector joins the header without breaking its Tab order ----------
  const made = await admin.evaluate(async () => (await fetch('/api/super/hotels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Hotel Prueba E2E', slug: 'hotel-prueba-e2e', city: 'Granada', lat: 37.1773, lon: -3.5986, adminEmail: 'admin@prueba-e2e.local', adminPassword: 'Prueba2026e2e' }) })).status);
  if (made !== 200 && made !== 201) throw new Error(`second hotel: HTTP ${made}`);
  const multi = await adminCtx.newPage();
  watch(multi, 'admin two hotels');
  for (const vp of [phone, { width: 1366, height: 900 }]) {
    await multi.setViewport(vp);
    await multi.goto(`${BASE}/reception.html`, { waitUntil: 'networkidle2' });
    await multi.waitForSelector('.bar [data-hotel]');
    await settled(multi);
    if (vp.isMobile) {
      await fits(multi, 'admin with a hotel selector');
      await axe(multi, 'admin two hotels (phone)');
    }
    const stops = await tabPage(multi, `admin with a hotel selector (${vp.width} px)`);
    if (!stops.some((s) => s.id.startsWith('select[data-hotel'))) throw new Error('hotel selector not reached by Tab');
  }
  ok('superadmin with two hotels: the selector stays in the first row on a phone and Tab reads the header in order');
  await multi.close();
} catch (error) {
  exitCode = 1;
  console.error('\n✗ E2E failure:', error.message);
}
await browser.close();
const serverExit = new Promise((r) => server.once('exit', r));
server.kill();
await serverExit;
rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
if (problems.length) {
  exitCode = 1;
  console.error(`\n✗ ${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
}
console.log(`\n${results.length} checks passed${exitCode ? ', with failures' : ', 0 console errors, 0 serious a11y issues'}`);
process.exit(exitCode);
