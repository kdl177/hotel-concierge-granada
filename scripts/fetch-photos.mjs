#!/usr/bin/env node
/**
 * Downloads a free photo (Wikimedia Commons, CC/public domain) for each place
 * of the first hotel and stores it with its author/licence credit.
 *
 *   npm run photos:fetch            # places without photo only
 *   npm run photos:fetch -- --force # replace every photo
 *   CONCIERGE_DB=... npm run photos:fetch
 *
 * Needs internet (Wikipedia + Wikimedia Commons). Files land in
 * data/uploads/<hotelId>/poi-<key>.jpg (1200 px wide, served at /uploads/…).
 * Credit is shown to guests in the place view, as the licences require.
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDatabase } from '../server/app/db.js';

// Wikipedia article per place: its lead image is almost always a good, free photo.
const ARTICLES = {
  alhambra: 'es:Alhambra',
  generalife: 'es:Generalife',
  'san-nicolas': 'es:Mirador de San Nicolás',
  albaicin: 'es:Albaicín',
  sacromonte: 'es:Sacromonte',
  catedral: 'es:Catedral de Granada',
  'capilla-real': 'es:Capilla Real de Granada',
  alcaiceria: 'es:Alcaicería de Granada',
  darro: 'es:Carrera del Darro',
  'plaza-nueva': 'es:Plaza Nueva (Granada)',
  'san-jeronimo': 'es:Monasterio de San Jerónimo (Granada)',
  'san-juan-de-dios': 'es:Basílica de San Juan de Dios',
  cartuja: 'es:Monasterio de la Cartuja (Granada)',
  'parque-ciencias': 'es:Parque de las Ciencias',
  realejo: 'es:Realejo-San Matías',
  'sierra-nevada': 'es:Sierra Nevada (España)',
};
const WIDTH = 1200;
const UA = 'hotel-concierge/1.0 (place photos; contact via repository)';
const force = process.argv.includes('--force');

async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Lead image of a Wikipedia article → { file, thumb }. */
async function leadImage(article) {
  const [lang, title] = article.split(/:(.+)/);
  const api = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=name|thumbnail&pithumbsize=${WIDTH}&titles=${encodeURIComponent(title)}`;
  const page = Object.values((await json(api)).query?.pages || {})[0];
  if (!page?.pageimage) return null;
  return { file: `File:${page.pageimage}`, thumb: page.thumbnail?.source || null };
}

/** Author + licence from Commons, for the credit line. */
async function credit(file) {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=extmetadata|url&iiurlwidth=${WIDTH}&titles=${encodeURIComponent(file)}`;
  const page = Object.values((await json(api)).query?.pages || {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const m = info.extmetadata || {};
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();
  return {
    author: strip(m.Artist?.value).slice(0, 80),
    license: strip(m.LicenseShortName?.value) || 'CC',
    page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(file)}`,
    thumb: info.thumburl || info.url,
  };
}

const db = openDatabase(process.env.CONCIERGE_DB || path.resolve(process.cwd(), 'data/concierge.sqlite'));
const hotel = db.prepare('SELECT id, name FROM hotels ORDER BY created_at LIMIT 1').get();
if (!hotel) {
  console.error('No hotel in the database yet: start the app once first.');
  process.exit(1);
}
const dir = path.resolve(path.dirname(process.env.CONCIERGE_DB || 'data/concierge.sqlite'), 'uploads', hotel.id);
mkdirSync(dir, { recursive: true });
const pois = db.prepare('SELECT id, key, photo FROM pois WHERE hotel_id = ? ORDER BY sort').all(hotel.id);
let done = 0;
for (const poi of pois) {
  const article = ARTICLES[poi.key];
  if (!article) continue;
  if (poi.photo && !force) {
    console.log(`· ${poi.key}: already has a photo (use --force to replace)`);
    continue;
  }
  try {
    const lead = await leadImage(article);
    if (!lead) throw new Error('no lead image on Wikipedia');
    const c = await credit(lead.file);
    const src = c?.thumb || lead.thumb;
    if (!src) throw new Error('no thumbnail URL');
    const res = await fetch(src, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = /png/i.test(res.headers.get('content-type') || '') ? 'png' : 'jpg';
    const name = `poi-${poi.key}.${ext}`;
    writeFileSync(path.join(dir, name), buf);
    const line = c ? `${c.author ? `${c.author} · ` : ''}${c.license} · Wikimedia Commons` : 'Wikimedia Commons';
    db.prepare('UPDATE pois SET photo = ?, photo_credit = ?, photo_credit_url = ? WHERE id = ?').run(`/uploads/${hotel.id}/${name}`, line, c?.page || '', poi.id);
    done++;
    console.log(`✓ ${poi.key}: ${Math.round(buf.length / 1024)} KB — ${line}`);
  } catch (error) {
    console.warn(`✗ ${poi.key}: ${error.message}`);
  }
}
console.log(`\n${done} photo(s) saved for ${hotel.name}. Restart or reload the app to see them.`);
