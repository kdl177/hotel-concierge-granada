/**
 * Google Routes API (TRANSIT) proxy for the hotel concierge.
 *
 * POST /api/google/routes
 *   body: { origin: {lat, lon}, destination: {lat, lon}, lang?: 'es'|'en'|'fr'|'de' }
 *   → { configured, routes: [{ durationS, distanceM, departure, arrival, polyline: [[lon,lat],...],
 *        legs: [{ mode: 'WALK'|'TRANSIT', durationS, distanceM, instruction,
 *                 transit?: { line, vehicle, headsign, color, textColor, agency,
 *                             from, to, departure, arrival, stopCount } }] }] }
 *
 * SERVER-SIDE ONLY: uses GOOGLE_MAPS_SERVER_API_KEY (or GOOGLE_MAPS_API_KEY),
 * never sends the key to the browser. Responses are cached 60 s per
 * origin/destination/lang to keep the Routes API bill small.
 */
import { resolveGoogleServerKey } from '../../scripts/google-server-key.mjs';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 12_000;
const MAX_BODY = 8_192;
const FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.navigationInstruction.instructions',
  'routes.legs.steps.transitDetails',
  'routes.legs.startLocation',
  'routes.legs.endLocation',
  'routes.legs.duration',
].join(',');

const cache = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Decode a Google encoded polyline into [[lon, lat], ...]. */
export function decodePolyline(str = '') {
  const out = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

function seconds(duration) {
  // "123s" → 123
  const m = /^(\d+)s$/.exec(String(duration ?? ''));
  return m ? Number(m[1]) : 0;
}

/** Trim the Routes API response to what the guest UI needs. */
export function shapeTransitRoutes(payload) {
  const routes = Array.isArray(payload?.routes) ? payload.routes : [];
  return routes.map((route) => {
    const legs = [];
    let departure = null, arrival = null;
    for (const leg of route.legs ?? []) {
      for (const step of leg.steps ?? []) {
        const td = step.transitDetails;
        const entry = {
          mode: step.travelMode === 'TRANSIT' ? 'TRANSIT' : 'WALK',
          durationS: seconds(step.staticDuration),
          distanceM: step.distanceMeters ?? 0,
          instruction: step.navigationInstruction?.instructions ?? '',
          polyline: decodePolyline(step.polyline?.encodedPolyline),
        };
        if (td) {
          const line = td.transitLine ?? {};
          const dep = td.stopDetails?.departureTime ?? null;
          const arr = td.stopDetails?.arrivalTime ?? null;
          entry.transit = {
            line: line.nameShort || line.name || '',
            lineName: line.name || '',
            vehicle: line.vehicle?.type || 'BUS',
            headsign: td.headsign || '',
            color: line.color || '',
            textColor: line.textColor || '',
            agency: line.agencies?.[0]?.name || '',
            from: td.stopDetails?.departureStop?.name || '',
            to: td.stopDetails?.arrivalStop?.name || '',
            departure: dep,
            arrival: arr,
            stopCount: td.stopCount ?? 0,
          };
          departure ||= dep;
          if (arr) arrival = arr;
        }
        legs.push(entry);
      }
    }
    return {
      durationS: seconds(route.duration),
      distanceM: route.distanceMeters ?? 0,
      departure,
      arrival,
      polyline: decodePolyline(route.polyline?.encodedPolyline),
      legs,
    };
  });
}

async function computeTransit({ origin, destination, lang, key, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(ROUTES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lon } } },
        travelMode: 'TRANSIT',
        computeAlternativeRoutes: true,
        languageCode: lang,
        units: 'METRIC',
        transitPreferences: { routingPreference: 'FEWER_TRANSFERS' },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `Routes API ${res.status}`;
      try {
        message = JSON.parse(text)?.error?.message || message;
      } catch {}
      throw new Error(message);
    }
    return shapeTransitRoutes(JSON.parse(text));
  } finally {
    clearTimeout(timer);
  }
}

/** Vite plugin: same-origin transit routing for the concierge UI. */
export function googleRoutesProxy({ fetchImpl = (...args) => fetch(...args) } = {}) {
  function install(middlewares) {
    middlewares.use('/api/google/routes', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'POST only' }));
        return;
      }
      const key = resolveGoogleServerKey(process.env);
      if (!key) {
        res.end(JSON.stringify({ configured: false, routes: [] }));
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const { origin, destination } = body ?? {};
      const lang = ['es', 'en', 'fr', 'de'].includes(body?.lang) ? body.lang : 'es';
      if (
        !finite(origin?.lat) || !finite(origin?.lon) ||
        !finite(destination?.lat) || !finite(destination?.lon)
      ) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'origin/destination {lat, lon} required' }));
        return;
      }
      const cacheKey = [origin.lat, origin.lon, destination.lat, destination.lon, lang]
        .map((v) => (typeof v === 'number' ? v.toFixed(5) : v))
        .join('|');
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        res.end(JSON.stringify({ configured: true, cached: true, routes: hit.routes }));
        return;
      }
      try {
        const routes = await computeTransit({ origin, destination, lang, key, fetchImpl });
        cache.set(cacheKey, { at: Date.now(), routes });
        res.end(JSON.stringify({ configured: true, routes }));
      } catch (error) {
        res.statusCode = 502;
        res.end(JSON.stringify({ configured: true, error: error?.message || 'Routes request failed', routes: [] }));
      }
    });
  }
  return {
    name: 'google-routes-transit-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
