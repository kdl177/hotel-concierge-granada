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
// Several candidates per place: Spanish article, English article, then a Commons
// search; the first one with a usable image wins.
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
const FALLBACK = {
  'san-nicolas': ['en:Albaicín', 'commons:Mirador de San Nicolás'],
  catedral: ['en:Granada Cathedral', 'commons:Granada Cathedral'],
  'capilla-real': ['en:Royal Chapel of Granada', 'commons:Capilla Real de Granada'],
  alcaiceria: ['en:Alcaicería', 'commons:Alcaicería (Granada)'],
  darro: ['en:Carrera del Darro', 'commons:Carrera del Darro'],
  'plaza-nueva': ['en:Plaza Nueva, Granada', 'commons:Plaza Nueva (Granada)'],
  'san-jeronimo': ['en:Monastery of San Jerónimo', 'commons:Monasterio de San Jerónimo (Granada)'],
  'san-juan-de-dios': ['en:Basilica of San Juan de Dios', 'commons:Basílica de San Juan de Dios (Granada)'],
  cartuja: ['en:Charterhouse of Granada', 'commons:Cartuja de Granada'],
  'parque-ciencias': ['en:Parque de las Ciencias', 'commons:Parque de las Ciencias (Granada)'],
  realejo: ['en:Realejo', 'commons:Realejo (Granada)'],
  'sierra-nevada': ['en:Sierra Nevada (Spain)', 'commons:Sierra Nevada (Spain)'],
  generalife: ['en:Generalife'],
  albaicin: ['en:Albaicín'],
  sacromonte: ['en:Sacromonte'],
  alhambra: ['en:Alhambra'],
};
const WIDTH = 1200;
const UA = 'hotel-concierge/1.0 (place photos; contact via repository)';
const force = process.argv.includes('--force');

async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Lead image of a Wikipedia article, or the best match of a Commons search → { file, thumb }. */
async function leadImage(article) {
  const [lang, title] = article.split(/:(.+)/);
  if (lang === 'commons') {
    // Commons full-text search, photos only (jpg), sorted by relevance.
    const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(`${title} filetype:bitmap`)}&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=${WIDTH}`;
    const pages = Object.values((await json(api)).query?.pages || {});
    const pick = pages
      .map((p) => ({ file: p.title, info: p.imageinfo?.[0] }))
      .filter((x) => x.info && /jpeg|png/.test(x.info.mime || '') && x.info.width >= 1000 && x.info.width >= x.info.height)
      .sort((a, b) => (a.file.toLowerCase().includes(title.split(' ')[0].toLowerCase()) ? -1 : 1))[0];
    return pick ? { file: pick.file, thumb: pick.info.thumburl } : null;
  }
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
    let lead = null;
    const tried = [];
    for (const candidate of [article, ...(FALLBACK[poi.key] || [])]) {
      try {
        lead = await leadImage(candidate);
      } catch (error) {
        tried.push(`${candidate}: ${error.message}`);
      }
      if (lead) break;
      tried.push(`${candidate}: no image`);
    }
    if (!lead) throw new Error(`no free photo found (${tried.join('; ')})`);
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
