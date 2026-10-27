// Automatic GTFS renewal from the National Access Point: only better feeds
// replace the local ones, bad downloads never touch them, and the admin
// endpoint is superadmin-only and honest about the server configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { updateFeeds, inspectFeed, parseFileList, NAP_DOWNLOAD } from '../../server/app/gtfs-update.js';
import { createTransit } from '../../server/app/gtfs.js';
import { startApp, client, superadmin } from './helpers.mjs';

// ---- minimal ZIP writer (stored entries) so the tests need no fixtures ----
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function zip(files) {
  const locals = [];
  const dirs = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0, 8); // stored
    h.writeUInt32LE(crc32(data), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    const d = Buffer.alloc(46);
    d.writeUInt32LE(0x02014b50, 0);
    d.writeUInt16LE(20, 6);
    d.writeUInt32LE(crc32(data), 16);
    d.writeUInt32LE(data.length, 20);
    d.writeUInt32LE(data.length, 24);
    d.writeUInt16LE(n.length, 28);
    d.writeUInt32LE(off, 42);
    locals.push(h, n, data);
    dirs.push(d, n);
    off += h.length + n.length + data.length;
  }
  const dir = Buffer.concat(dirs);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(dirs.length / 2, 8);
  e.writeUInt16LE(dirs.length / 2, 10);
  e.writeUInt32LE(dir.length, 12);
  e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, dir, e]);
}
/** A tiny but valid feed for one agency, valid until `end` (YYYYMMDD). */
function feed(agency, end, trips = 2) {
  return zip({
    'agency.txt': `agency_id,agency_name,agency_url,agency_timezone\nA,${agency},https://x.es,Europe/Madrid\n`,
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nS1,Uno,37.17,-3.60\nS2,Dos,37.18,-3.59\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,Linea 1,3\n',
    'calendar.txt': `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,${end}\n`,
    'trips.txt': `route_id,service_id,trip_id\n${Array.from({ length: trips }, (_, i) => `R1,WK,T${i}`).join('\n')}\n`,
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT0,08:00:00,08:00:00,S1,1\nT0,08:10:00,08:10:00,S2,2\n',
  });
}
const fakeNap = (bodies, seen = []) => async (url, opts) => {
  seen.push({ url, key: opts?.headers?.ApiKey });
  const id = url.replace(NAP_DOWNLOAD, '');
  const body = bodies[id];
  if (body === 401) return { ok: false, status: 401, headers: new Headers() };
  if (!body) return { ok: false, status: 404, headers: new Headers() };
  return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => body };
};
const scratch = () => mkdtempSync(path.join(tmpdir(), 'gtfs-upd-'));

test('inspectFeed reads agencies and validity; rejects non-feeds', () => {
  const info = inspectFeed(feed('Metro de Granada', '20271231', 3));
  assert.deepEqual(info, { agencies: ['Metro de Granada'], validTo: '20271231', trips: 3 });
  assert.throws(() => inspectFeed(Buffer.from('hello')), /not a zip/);
  assert.throws(() => inspectFeed(zip({ 'readme.txt': 'x' })), /missing stops\.txt/);
  assert.throws(() => inspectFeed(zlib.gzipSync('x')), /not a zip/);
});

test('parseFileList: defaults, custom names, bad ids', () => {
  assert.deepEqual(parseFileList(), [
    { id: '1367', name: 'bus-urbano-granada' },
    { id: '1370', name: 'metro-granada' },
  ]);
  assert.deepEqual(parseFileList('42:Mi Bus, 7'), [
    { id: '42', name: 'mi-bus' },
    { id: '7', name: 'nap-7' },
  ]);
  assert.throws(() => parseFileList('abc'), /bad file id/);
});

test('updateFeeds: downloads with the ApiKey, writes new feeds, replaces older ones, keeps newer local ones', async () => {
  const dir = scratch();
  try {
    const seen = [];
    // Nothing local yet → both written.
    let report = await updateFeeds({ dir, apiKey: 'k1', fetchImpl: fakeNap({ 1367: feed('Rober', '20270301'), 1370: feed('Metro de Granada', '20261213') }, seen) });
    assert.deepEqual(report.map((r) => [r.file, r.status, r.validTo]), [
      ['bus-urbano-granada.zip', 'updated', '20270301'],
      ['metro-granada.zip', 'updated', '20261213'],
    ]);
    assert.ok(seen.every((s) => s.key === 'k1' && s.url.startsWith(NAP_DOWNLOAD)), 'ApiKey header on every NAP request');
    assert.deepEqual(readdirSync(dir).sort(), ['bus-urbano-granada.zip', 'metro-granada.zip']);
    // Same files again → unchanged; metro renewed → updated; bus download older than local → kept.
    report = await updateFeeds({ dir, apiKey: 'k1', fetchImpl: fakeNap({ 1367: feed('Rober', '20261001'), 1370: feed('Metro de Granada', '20271213', 5) }) });
    assert.equal(report[0].status, 'kept');
    assert.match(report[0].reason, /valid until 20270301/);
    assert.equal(report[1].status, 'updated');
    assert.equal(inspectFeed(readFileSync(path.join(dir, 'metro-granada.zip'))).validTo, '20271213');
    assert.equal(inspectFeed(readFileSync(path.join(dir, 'bus-urbano-granada.zip'))).validTo, '20270301', 'older download did not replace the local feed');
    report = await updateFeeds({ dir, apiKey: 'k1', fetchImpl: fakeNap({ 1367: feed('Rober', '20270301'), 1370: feed('Metro de Granada', '20271213', 5) }) });
    assert.deepEqual(report.map((r) => r.status), ['unchanged', 'unchanged']);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp files left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateFeeds: a hand-named local file for the same operator is replaced in place (no duplicate feed)', async () => {
  const dir = scratch();
  try {
    writeFileSync(path.join(dir, 'MetroGranada_old.zip'), feed('Metro de Granada', '20261213'));
    const report = await updateFeeds({ dir, apiKey: 'k', files: '1370:metro-granada', fetchImpl: fakeNap({ 1370: feed('Metro de Granada', '20270630') }) });
    assert.equal(report[0].status, 'updated');
    assert.equal(report[0].file, 'MetroGranada_old.zip', 'kept the existing file name');
    assert.deepEqual(readdirSync(dir), ['MetroGranada_old.zip']);
    assert.equal(inspectFeed(readFileSync(path.join(dir, 'MetroGranada_old.zip'))).validTo, '20270630');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateFeeds: bad key, missing file, corrupt or empty download never touch the local feeds', async () => {
  const dir = scratch();
  try {
    writeFileSync(path.join(dir, 'metro-granada.zip'), feed('Metro de Granada', '20261213'));
    const before = readFileSync(path.join(dir, 'metro-granada.zip'));
    const report = await updateFeeds({
      dir,
      apiKey: 'bad',
      files: '1370:metro-granada,1367:bus-urbano-granada,9:corrupt,8:empty',
      fetchImpl: fakeNap({ 1370: 401, 9: Buffer.from('<html>login</html>'), 8: feed('X', '20270101', 0) }),
    });
    assert.deepEqual(report.map((r) => r.status), ['error', 'error', 'error', 'error']);
    assert.match(report[0].reason, /rejected the ApiKey \(401\)/);
    assert.match(report[1].reason, /404/);
    assert.match(report[2].reason, /not a zip/);
    assert.match(report[3].reason, /no trips/);
    assert.ok(readFileSync(path.join(dir, 'metro-granada.zip')).equals(before), 'local feed untouched');
    assert.deepEqual(readdirSync(dir), ['metro-granada.zip']);
    await assert.rejects(updateFeeds({ dir, apiKey: '', fetchImpl: fakeNap({}) }), /NAP_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createTransit: update() reloads the planner and schedules itself only when a key is set', async () => {
  const dir = scratch();
  try {
    const timers = { timeouts: [], intervals: [], setTimeout: (fn, ms) => timers.timeouts.push(ms), setInterval: (fn, ms) => timers.intervals.push(ms) };
    const silent = createTransit({ dataDir: dir, env: { CONCIERGE_GTFS_DIR: dir }, timers });
    assert.equal((await silent.load()).feeds.length, 0);
    assert.deepEqual(timers.intervals, [], 'no scheduler without NAP_API_KEY');
    const t = createTransit({ dataDir: dir, env: { CONCIERGE_GTFS_DIR: dir, NAP_API_KEY: 'k', GTFS_NAP_FILES: '1370:metro-granada', GTFS_UPDATE_DAYS: '3' }, fetchImpl: fakeNap({ 1370: feed('Metro de Granada', '20271231') }), timers });
    assert.deepEqual(timers.intervals, [3 * 86400_000], 'checks every GTFS_UPDATE_DAYS days');
    assert.equal((await t.load()).feeds.length, 0);
    const report = await t.update();
    assert.equal(report[0].status, 'updated');
    const net = await t.load();
    assert.equal(net.feeds.length, 1, 'planner reloaded with the downloaded feed');
    assert.equal(net.feeds[0].validTo, '20271231');
    assert.ok(existsSync(path.join(dir, 'metro-granada.zip')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/admin/transit/update: superadmin only; 409 when the server has no NAP key; works when it has one', async () => {
  const app = await startApp();
  try {
    const sa = await superadmin(app.base);
    const info = await sa.get('/api/admin/transit');
    assert.deepEqual(info.data.nap, { configured: false, autoDays: 0, last: null });
    assert.equal((await sa.post('/api/admin/transit/update')).status, 409);
    assert.equal((await client(app.base).post('/api/admin/transit/update')).status, 401);
  } finally {
    await app.close();
  }
  const withKey = await startApp({ env: { NAP_API_KEY: 'k', GTFS_NAP_FILES: '1370:metro-granada' }, fetchImpl: fakeNap({ 1370: feed('Metro de Granada', '20271231') }) });
  try {
    const sa = await superadmin(withKey.base);
    const r = await sa.post('/api/admin/transit/update');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.report[0].status, 'updated');
    assert.equal(r.data.feeds.length, 1);
    const info = await sa.get('/api/admin/transit');
    assert.equal(info.data.nap.configured, true);
    assert.equal(info.data.nap.autoDays, 7);
    assert.equal(info.data.nap.last.report[0].validTo, '20271231');
  } finally {
    await withKey.close();
  }
});
