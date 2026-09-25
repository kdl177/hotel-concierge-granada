/** Network helpers: routing (walk / bike / transit) and place search. */
import { HOTEL } from './data/hotel.js';
import { POIS } from './data/pois.js';
import { L } from './i18n.js';

const GRANADA_BOUNDS = '37.05,-3.75|37.30,-3.45';

function haversineM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function distanceFromHotelM(point) {
  return haversineM(HOTEL, point);
}

/** Walking or cycling route via the keyless OSRM proxy of the base project. */
export async function fetchRoute(profile, from, to, { signal } = {}) {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const res = await fetch(
    `/api/route?profile=${encodeURIComponent(profile)}&coords=${encodeURIComponent(coords)}&steps=1`,
    { signal },
  );
  const data = await res.json();
  if (!data?.ok) throw new Error(data?.error || 'route failed');
  return data; // { distanceM, durationS, geometry: [[lon,lat]...], steps }
}

/** Transit itineraries via the Google Routes proxy (server-side key). */
export async function fetchTransit(from, to, lang, { signal } = {}) {
  const res = await fetch('/api/google/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: from, destination: to, lang }),
    signal,
  });
  const data = await res.json();
  if (data?.error && !data.routes?.length) throw new Error(data.error);
  return data; // { configured, routes }
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Search curated places first, then Google Places, then Nominatim. */
export async function searchPlaces(query, { signal } = {}) {
  const q = normalize(query.trim());
  if (!q) return [];
  const local = POIS.filter((p) => {
    const hay = normalize(
      [L(p.name), p.name.es, p.name.en, L(p.tag), L(p.desc)].join(' '),
    );
    return hay.includes(q);
  }).map((p) => ({ kind: 'poi', id: p.id, poi: p }));
  if (local.length >= 3) return local;

  const results = [...local];
  try {
    const res = await fetch(
      `/api/google/text-search?q=${encodeURIComponent(query + ' Granada')}&lat=${HOTEL.lat}&lon=${HOTEL.lon}`,
      { signal },
    );
    const data = await res.json();
    for (const place of data?.places ?? []) {
      if (!Number.isFinite(place.latitude)) continue;
      results.push({
        kind: 'place',
        id: `place:${place.id}`,
        name: place.name,
        address: place.address,
        lat: place.latitude,
        lon: place.longitude,
      });
    }
    if (data?.configured !== false && results.length) return dedupe(results);
  } catch {}
  try {
    const res = await fetch(
      `/api/geocode?q=${encodeURIComponent(query + ', Granada')}&bounds=${encodeURIComponent(GRANADA_BOUNDS)}`,
      { signal },
    );
    const data = await res.json();
    for (const r of data?.results ?? []) {
      const loc = r.geometry?.location;
      if (!loc) continue;
      results.push({
        kind: 'place',
        id: `osm:${loc.lat},${loc.lng}`,
        name: r.address_components?.[0]?.long_name || r.formatted_address.split(',')[0],
        address: r.formatted_address,
        lat: loc.lat,
        lon: loc.lng,
      });
    }
  } catch {}
  return dedupe(results);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => {
    const key = r.kind === 'poi' ? r.id : `${r.lat.toFixed(4)},${r.lon.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "morning" | "afternoon" | "evening" | "night" for the local clock. */
export function dayMoment(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

/** Is a hotel service open right now, per its weekly `open` table? */
export function isOpenNow(service, date = new Date()) {
  if (!service.open) return null;
  const day = date.getDay();
  const now = date.getHours() * 60 + date.getMinutes();
  const mins = (s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  return service.open.some(
    (slot) => slot.days.includes(day) && now >= mins(slot.from) && now <= mins(slot.to),
  );
}

export function formatDistance(m, t) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} ${t('km')}` : `${Math.round(m)} ${t('m')}`;
}

export function formatDuration(s, t) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} ${t('minutes')}`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

export function formatTime(iso, lang) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
