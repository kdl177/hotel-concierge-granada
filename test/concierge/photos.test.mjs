import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startApp, client, superadmin, STRONG } from './helpers.mjs';

test('photos:fetch stores a Commons photo with its credit, and the guest sees it', async () => {
  const app = await startApp();
  try {
    // Fake Wikipedia/Commons on localhost, reached through a fetch shim.
    const dir = mkdtempSync(path.join(tmpdir(), 'photos-'));
    const shim = path.join(dir, 'shim.mjs');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(shim, `
      const png = Buffer.from(${JSON.stringify(png.toString('base64'))}, 'base64');
      globalThis.fetch = async (url) => {
        const u = String(url);
        const j = (o) => ({ ok: true, json: async () => o, headers: new Map() });
        if (u.includes('wikipedia.org')) return j({ query: { pages: { 1: { pageimage: 'Alhambra_test.png', thumbnail: { source: 'https://upload.wikimedia.org/x.png' } } } } });
        if (u.includes('commons.wikimedia.org')) return j({ query: { pages: { 1: { imageinfo: [{ thumburl: 'https://upload.wikimedia.org/thumb.png', extmetadata: { Artist: { value: '<a href="#">Jebulon</a>' }, LicenseShortName: { value: 'CC BY-SA 3.0' } } }] } } } });
        return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
      };
    `);
    const dbFile = app.db.location ? app.db.location() : null;
    const env = { ...process.env, CONCIERGE_DB: path.join(app.dir, 'db.sqlite'), NODE_OPTIONS: `--import=${pathToFileURL(shim).href}` };
    const r = spawnSync(process.execPath, ['scripts/fetch-photos.mjs'], { env, encoding: 'utf8', cwd: path.resolve('.') });
    assert.match(r.stdout, /✓ alhambra: .*Jebulon · CC BY-SA 3.0 · Wikimedia Commons/);
    assert.ok(existsSync(path.join(app.dir, 'uploads', app.db.prepare('SELECT id FROM hotels').get().id, 'poi-alhambra.png')));
    const cfg = await client(app.base).get('/api/h/default/config');
    const alh = cfg.data.pois.find((p) => p.id === 'alhambra');
    assert.match(alh.photo, /\/uploads\/.*\/poi-alhambra\.png/);
    assert.equal(alh.photoCredit, 'Jebulon · CC BY-SA 3.0 · Wikimedia Commons');
    assert.match(alh.photoCreditUrl, /commons\.wikimedia\.org/);
    const img = await fetch(app.base + alh.photo);
    assert.equal(img.status, 200);
    // Second run skips places that already have a photo.
    const r2 = spawnSync(process.execPath, ['scripts/fetch-photos.mjs'], { env, encoding: 'utf8' });
    assert.match(r2.stdout, /alhambra: already has a photo/);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await app.close();
  }
});
