/**
 * Offline public-transport planner built on official GTFS timetables.
 *
 * Drop GTFS .zip files in <dataDir>/gtfs/ (e.g. Metro de Granada and the
 * urban bus network from nap.transportes.gob.es). They are read at startup
 * (no extra dependencies: a tiny ZIP reader + CSV parser live here), kept in
 * compact arrays, and queried with a round-based earliest-arrival search
 * (RAPTOR-style, up to one transfer, walking to/from/between stops).
 *
 *   POST /api/h/:slug/transit { origin:{lat,lon}, destination:{lat,lon}, destName?, lang?, at? }
 *     → { configured, source:'gtfs', routes:[…same shape as the Google proxy…] }
 *   GET  /api/admin/transit   → feeds loaded, validity dates, counts
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createLimiter, limit, clientIp } from './security.js';

// ---------------------------------------------------------------- zip + csv
/** Read every entry of a ZIP (stored or deflated) into { name: Buffer }. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    out[path.basename(name)] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Parse CSV text into rows of objects (RFC 4180 quotes, BOM stripped). */
export function parseCsv(text, onRow) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let header = null;
  let field = '';
  let row = [];
  let inQ = false;
  const push = () => {
    row.push(field);
    field = '';
  };
  const end = () => {
    push();
    if (!header) header = row.map((h) => h.trim());
    else if (row.length > 1 || row[0] !== '') {
      const o = {};
      for (let i = 0; i < header.length; i++) o[header[i]] = row[i] ?? '';
      onRow(o);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') push();
    else if (c === '\n') end();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) end();
}

// ---------------------------------------------------------------- geometry
const R = 6371000;
const toRad = Math.PI / 180;
export function haversine(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const WALK_SPEED = 1.3; // m/s (≈ 4.7 km/h)
const DETOUR = 1.25; // straight line → street distance
const walkSecs = (m) => Math.round((m * DETOUR) / WALK_SPEED);
const MAX_ACCESS_M = 900; // walk to the first stop / from the last stop
const MAX_TRANSFER_M = 300; // walk between stops when changing
const MIN_TRANSFER_S = 90;
const HORIZON_S = 3 * 3600; // search window after departure

const hms = (s) => {
  const [h, m, sec] = s.split(':').map(Number);
  return h * 3600 + m * 60 + (sec || 0);
};

// ---------------------------------------------------------------- loading
const VEHICLE = { 0: 'TRAM', 1: 'SUBWAY', 2: 'RAIL', 3: 'BUS', 5: 'TRAM', 7: 'TRAM', 11: 'BUS', 12: 'RAIL' };
// Line colours when the feed has none (Metro de Granada publishes none).
const DEFAULT_COLOR = { TRAM: '#2e9e5b', SUBWAY: '#2e9e5b', RAIL: '#7a5cc4', BUS: '#e8413c' };

function loadFeeds(dir) {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.zip')).sort() : [];
  const net = {
    feeds: [],
    stops: [], // { lat, lon, name, feed }
    routes: [], // { short, long, color, text, vehicle, agency }
    trips: [], // { route, service, headsign, shape, stops:Int32Array, times:Int32Array }
    services: [], // { feed, days:[mon..sun], start, end, add:Set, remove:Set }
    shapes: new Map(), // key → [[lon,lat],…]
    stopTrips: [], // stop → [tripIdx, pos, …] flat
    nearby: [], // stop → [stopIdx, walkSecs, …] flat
  };
  for (const file of files) {
    const feedName = file.replace(/\.zip$/i, '');
    let z;
    try {
      z = unzip(readFileSync(path.join(dir, file)));
    } catch (error) {
      console.warn(`[gtfs] ${file}: ${error.message}`);
      continue;
    }
    const txt = (n) => (z[n] ? z[n].toString('utf8') : '');
    if (!txt('stops.txt') || !txt('stop_times.txt') || !txt('trips.txt')) {
      console.warn(`[gtfs] ${file}: missing required files`);
      continue;
    }
    const fi = net.feeds.length;
    const agencies = {};
    parseCsv(txt('agency.txt'), (a) => (agencies[a.agency_id || '_'] = a.agency_name));
    const stopIdx = new Map();
    parseCsv(txt('stops.txt'), (s) => {
      if (s.location_type && s.location_type !== '0') return;
      const lat = Number(s.stop_lat);
      const lon = Number(s.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      stopIdx.set(s.stop_id, net.stops.length);
      net.stops.push({ lat, lon, name: s.stop_name.trim(), feed: fi });
    });
    const routeIdx = new Map();
    parseCsv(txt('routes.txt'), (r) => {
      const vehicle = VEHICLE[Number(r.route_type)] || 'BUS';
      routeIdx.set(r.route_id, net.routes.length);
      const long = (r.route_long_name || '').replace(/^L\.\s?\w+\s+/, '').trim();
      net.routes.push({
        short: r.route_short_name || r.route_id,
        long,
        color: r.route_color ? `#${r.route_color}` : DEFAULT_COLOR[vehicle],
        text: r.route_text_color ? `#${r.route_text_color}` : '#ffffff',
        vehicle,
        agency: agencies[r.agency_id || '_'] || Object.values(agencies)[0] || '',
      });
    });
    const svcIdx = new Map();
    const svc = (id) => {
      if (!svcIdx.has(id)) {
        svcIdx.set(id, net.services.length);
        net.services.push({ feed: fi, days: [0, 0, 0, 0, 0, 0, 0], start: '0', end: '0', add: new Set(), remove: new Set() });
      }
      return net.services[svcIdx.get(id)];
    };
    let minDate = '99999999';
    let maxDate = '0';
    parseCsv(txt('calendar.txt'), (c) => {
      const s = svc(c.service_id);
      s.days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => c[d] === '1');
      s.start = c.start_date;
      s.end = c.end_date;
      if (c.start_date < minDate) minDate = c.start_date;
      if (c.end_date > maxDate) maxDate = c.end_date;
    });
    parseCsv(txt('calendar_dates.txt'), (c) => {
      const s = svc(c.service_id);
      (c.exception_type === '1' ? s.add : s.remove).add(c.date);
      if (c.exception_type === '1') {
        if (c.date < minDate) minDate = c.date;
        if (c.date > maxDate) maxDate = c.date;
      }
    });
    const tripIdx = new Map();
    const tripShape = new Set();
    parseCsv(txt('trips.txt'), (t) => {
      const r = routeIdx.get(t.route_id);
      if (r === undefined) return;
      tripIdx.set(t.trip_id, net.trips.length);
      const shape = t.shape_id ? `${fi}:${t.shape_id}` : null;
      if (shape) tripShape.add(shape);
      net.trips.push({ route: r, service: svc(t.service_id) && svcIdx.get(t.service_id), headsign: (t.trip_headsign || '').trim(), shape, _st: [] });
    });
    parseCsv(txt('stop_times.txt'), (st) => {
      const ti = tripIdx.get(st.trip_id);
      const si = stopIdx.get(st.stop_id);
      if (ti === undefined || si === undefined) return;
      const time = st.departure_time || st.arrival_time;
      if (!time) return;
      net.trips[ti]._st.push([Number(st.stop_sequence), si, hms(time)]);
    });
    const shapePts = new Map();
    parseCsv(txt('shapes.txt'), (p) => {
      const key = `${fi}:${p.shape_id}`;
      if (!tripShape.has(key)) return;
      if (!shapePts.has(key)) shapePts.set(key, []);
      shapePts.get(key).push([Number(p.shape_pt_sequence), Number(p.shape_pt_lon), Number(p.shape_pt_lat)]);
    });
    for (const [k, pts] of shapePts) net.shapes.set(k, pts.sort((a, b) => a[0] - b[0]).map(([, lon, lat]) => [lon, lat]));
    let tripCount = 0;
    for (let ti = 0; ti < net.trips.length; ti++) {
      const t = net.trips[ti];
      if (!t._st) continue;
      t._st.sort((a, b) => a[0] - b[0]);
      t.stops = Int32Array.from(t._st, (x) => x[1]);
      t.times = Int32Array.from(t._st, (x) => x[2]);
      delete t._st;
      tripCount++;
    }
    net.feeds.push({ file, name: feedName, agencies: Object.values(agencies), stops: stopIdx.size, routes: routeIdx.size, trips: tripCount, validFrom: minDate, validTo: maxDate });
  }
  // stop → trips passing (flat [trip, pos, …]), and walking transfers between stops
  net.stopTrips = net.stops.map(() => []);
  net.trips.forEach((t, ti) => t.stops?.forEach((s, pos) => net.stopTrips[s].push(ti, pos)));
  net.grid = new Map();
  const cell = (lat, lon) => `${Math.floor(lat / 0.004)}:${Math.floor(lon / 0.005)}`; // ≈ 450 m cells
  net.stops.forEach((s, i) => {
    const k = cell(s.lat, s.lon);
    if (!net.grid.has(k)) net.grid.set(k, []);
    net.grid.get(k).push(i);
  });
  net.cell = cell;
  net.nearby = net.stops.map((s, i) => {
    const out = [];
    for (const j of nearStops(net, s.lat, s.lon, MAX_TRANSFER_M)) if (j !== i) out.push(j, walkSecs(haversine(s.lat, s.lon, net.stops[j].lat, net.stops[j].lon)));
    return out;
  });
  return net;
}

function nearStops(net, lat, lon, maxM) {
  const out = [];
  const ci = Math.floor(lat / 0.004);
  const cj = Math.floor(lon / 0.005);
  const span = Math.ceil(maxM / 400);
  for (let a = -span; a <= span; a++)
    for (let b = -span; b <= span; b++)
      for (const i of net.grid.get(`${ci + a}:${cj + b}`) || []) {
        const s = net.stops[i];
        if (haversine(lat, lon, s.lat, s.lon) <= maxM) out.push(i);
      }
  return out;
}

// ---------------------------------------------------------------- time
const TZ = 'Europe/Madrid';
/** Local calendar date (YYYYMMDD), weekday (0=Mon) and seconds since midnight for an instant. */
function localParts(date) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}${p.month}${p.day}`, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), secs: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}
/** GTFS time origin for a YYYYMMDD service day: local noon minus 12 h (correct across DST). */
function midnightMs(ymd) {
  const utcNoon = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 12);
  const offsetS = localParts(new Date(utcNoon)).secs - 12 * 3600; // e.g. +7200 in CEST
  return utcNoon - offsetS * 1000 - 12 * 3600 * 1000;
}
function prevDay(ymd) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) - 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function activeServices(net, ymd, wd) {
  return net.services.map((s) => (s.remove.has(ymd) ? false : s.add.has(ymd) ? true : !!s.days[wd] && s.start <= ymd && ymd <= s.end));
}

// ---------------------------------------------------------------- search
/**
 * Earliest-arrival search with up to `maxRides` vehicles. Returns up to 3
 * itineraries with different first lines, each as legs.
 */
export function plan(net, { origin, destination, at = new Date(), maxRides = 2 }) {
  if (!net.stops.length) return [];
  const now = localParts(at);
  const days = [{ ymd: now.ymd, wd: now.wd, offset: 0 }];
  // Trips after midnight belong to yesterday's service with times ≥ 24:00.
  if (now.secs < 4 * 3600) days.push({ ymd: prevDay(now.ymd), wd: (now.wd + 6) % 7, offset: -86400 });
  const t0 = now.secs;
  const directWalk = haversine(origin.lat, origin.lon, destination.lat, destination.lon);

  const egress = new Map(nearStops(net, destination.lat, destination.lon, MAX_ACCESS_M).map((s) => [s, walkSecs(haversine(net.stops[s].lat, net.stops[s].lon, destination.lat, destination.lon))]));
  const access = nearStops(net, origin.lat, origin.lon, MAX_ACCESS_M);
  if (!access.length || !egress.size) return [];

  const results = [];
  for (const day of days) {
    const active = activeServices(net, day.ymd, day.wd);
    const n = net.stops.length;
    // label[k][s] = { t, parent } best arrival at stop s after k rides
    let prev = new Map();
    for (const s of access) {
      const w = walkSecs(haversine(origin.lat, origin.lon, net.stops[s].lat, net.stops[s].lon));
      prev.set(s, { t: t0 - day.offset + w, walk: w, parent: null, kind: 'access' });
    }
    const best = new Float64Array(n).fill(Infinity);
    for (const [s, l] of prev) best[s] = Math.min(best[s], l.t);
    for (let k = 1; k <= maxRides; k++) {
      const next = new Map();
      const tripDone = new Map(); // trip → earliest boarding pos already scanned
      for (const [s, lab] of prev) {
        const list = net.stopTrips[s];
        const ready = lab.t + (lab.kind === 'ride' ? MIN_TRANSFER_S : 0);
        for (let i = 0; i < list.length; i += 2) {
          const ti = list[i];
          const pos = list[i + 1];
          const trip = net.trips[ti];
          if (!active[trip.service]) continue;
          const dep = trip.times[pos];
          if (dep < ready || dep > ready + HORIZON_S) continue;
          if (pos >= trip.stops.length - 1) continue;
          const seen = tripDone.get(ti);
          if (seen !== undefined && seen <= pos) continue;
          tripDone.set(ti, pos);
          for (let q = pos + 1; q < trip.stops.length; q++) {
            const s2 = trip.stops[q];
            const arr = trip.times[q];
            if (arr < best[s2]) {
              best[s2] = arr;
              next.set(s2, { t: arr, parent: { from: s, lab, trip: ti, board: pos, alight: q }, kind: 'ride' });
            }
          }
        }
      }
      // walking transfers from stops improved in this round
      for (const [s, lab] of [...next]) {
        const nb = net.nearby[s];
        for (let i = 0; i < nb.length; i += 2) {
          const s2 = nb[i];
          const t = lab.t + nb[i + 1];
          if (t < best[s2]) {
            best[s2] = t;
            next.set(s2, { t, walk: nb[i + 1], parent: { from: s, lab }, kind: 'transfer' });
          }
        }
      }
      // collect arrivals at the destination for this number of rides
      for (const [s, lab] of next) {
        if (!egress.has(s)) continue;
        const eg = egress.get(s);
        results.push({ arrive: lab.t + eg, stop: s, lab, egress: eg, day, rides: k, origin, destination });
      }
      prev = next;
      if (!prev.size) break;
    }
  }
  // Rank by comfort, not only arrival: a change costs 5 min, walking weighs 1.5×.
  const scored = [];
  for (const r of results) {
    const legs = buildLegs(net, r);
    const rides = legs.filter((l) => l.mode === 'TRANSIT');
    if (!rides.length) continue;
    const total = r.arrive - (t0 - r.day.offset);
    const walk = legs.reduce((a, l) => a + (l.mode === 'WALK' ? l.secs : 0), 0);
    // Changing vehicle for a ride of ≤ 2 stops is never worth it.
    if (rides.length > 1 && rides.some((l) => l.alight - l.board <= 2)) continue;
    scored.push({ ...r, legs, total, cost: total + 300 * (rides.length - 1) + 0.5 * walk });
  }
  scored.sort((a, b) => a.cost - b.cost);
  const bestArrive = Math.min(...scored.map((r) => r.arrive));
  const out = [];
  const seen = new Set();
  for (const r of scored) {
    const sig = r.legs.filter((l) => l.mode === 'TRANSIT').map((l) => net.routes[net.trips[l.trip].route].short).join('>');
    if (seen.has(sig)) continue;
    // Transit saves effort even when it is a bit slower (hills, heat, luggage):
    // only drop it for very short hops or when it is clearly slower than walking.
    const walkS = walkSecs(directWalk);
    if (walkS <= 12 * 60 || r.total > walkS * 1.35) continue;
    // …and it must actually spare the guest a good part of the walk.
    const walked = r.legs.reduce((a, l) => a + (l.mode === 'WALK' ? l.secs : 0), 0);
    if (walked > walkS * 0.7) continue;
    // Not faster than walking? Then only a single, comfortable ride is worth offering.
    const nRides = r.legs.filter((l) => l.mode === 'TRANSIT').length;
    if (r.total >= walkS && (nRides > 1 || walked > walkS * 0.45)) continue;
    if (r.arrive > bestArrive + 20 * 60) continue; // much later than the best option
    seen.add(sig);
    out.push(r);
    if (out.length >= 3) break;
  }
  return out.map((r) => toApi(net, r, origin, destination));
}

/** Walking the whole way, in seconds (used when transit is not worth it). */
export function walkOnlySecs(origin, destination) {
  return walkSecs(haversine(origin.lat, origin.lon, destination.lat, destination.lon));
}

function buildLegs(net, r) {
  const { origin, destination } = r;
  const chain = [];
  let lab = r.lab;
  let stop = r.stop;
  while (lab) {
    chain.push({ stop, lab });
    if (!lab.parent) break;
    stop = lab.parent.from;
    lab = lab.parent.lab;
  }
  chain.reverse();
  const legs = [];
  const first = chain[0];
  const s0 = net.stops[first.stop];
  legs.push({ mode: 'WALK', from: origin, to: s0, toName: s0.name, secs: first.lab.walk, startT: first.lab.t - first.lab.walk });
  for (let i = 1; i < chain.length; i++) {
    const { stop: s, lab } = chain[i];
    if (lab.kind === 'ride') {
      const p = lab.parent;
      const trip = net.trips[p.trip];
      legs.push({ mode: 'TRANSIT', trip: p.trip, board: p.board, alight: p.alight, dep: trip.times[p.board], arr: trip.times[p.alight] });
    } else if (lab.kind === 'transfer') {
      const a = net.stops[lab.parent.from];
      legs.push({ mode: 'WALK', from: a, to: net.stops[s], toName: net.stops[s].name, secs: lab.walk, startT: lab.parent.lab.t });
    }
  }
  const last = net.stops[r.stop];
  legs.push({ mode: 'WALK', from: last, to: destination, toName: '', secs: r.egress, startT: r.lab.t });
  // Merge consecutive walks (transfer walk + final walk) into one leg.
  const merged = [];
  for (const l of legs) {
    const prev = merged[merged.length - 1];
    if (l.mode === 'WALK' && prev?.mode === 'WALK') {
      prev.to = l.to;
      prev.toName = l.toName;
      prev.secs += l.secs;
    } else merged.push({ ...l });
  }
  return merged.filter((l) => l.mode === 'TRANSIT' || l.secs > 20);
}

function shapeSlice(net, trip, board, alight) {
  const a = net.stops[trip.stops[board]];
  const b = net.stops[trip.stops[alight]];
  const shape = trip.shape && net.shapes.get(trip.shape);
  if (shape?.length > 1) {
    const nearest = (pt, from = 0) => {
      let bi = from;
      let bd = Infinity;
      for (let i = from; i < shape.length; i++) {
        const d = haversine(pt.lat, pt.lon, shape[i][1], shape[i][0]);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      return [bi, bd];
    };
    const [i0, d0] = nearest(a);
    const [i1, d1] = nearest(b, i0);
    if (d0 < 150 && d1 < 150 && i1 > i0) return shape.slice(i0, i1 + 1);
  }
  const pts = [];
  for (let q = board; q <= alight; q++) {
    const s = net.stops[trip.stops[q]];
    pts.push([s.lon, s.lat]);
  }
  return pts;
}

function toApi(net, r, origin, destination) {
  const base = midnightMs(r.day.ymd);
  const iso = (secs) => new Date(base + secs * 1000).toISOString();
  const legs = r.legs.map((l) => {
    if (l.mode === 'WALK') {
      const dist = Math.round(haversine(l.from.lat, l.from.lon, l.to.lat, l.to.lon) * DETOUR);
      return { mode: 'WALK', durationS: l.secs, distanceM: dist, instruction: l.toName, polyline: [[l.from.lon, l.from.lat], [l.to.lon, l.to.lat]] };
    }
    const trip = net.trips[l.trip];
    const route = net.routes[trip.route];
    const from = net.stops[trip.stops[l.board]];
    const to = net.stops[trip.stops[l.alight]];
    const poly = shapeSlice(net, trip, l.board, l.alight);
    let dist = 0;
    for (let i = 1; i < poly.length; i++) dist += haversine(poly[i - 1][1], poly[i - 1][0], poly[i][1], poly[i][0]);
    return {
      mode: 'TRANSIT',
      durationS: l.arr - l.dep,
      distanceM: Math.round(dist),
      instruction: '',
      polyline: poly,
      transit: {
        line: route.short,
        lineName: route.long,
        vehicle: route.vehicle,
        headsign: trip.headsign || net.stops[trip.stops[trip.stops.length - 1]].name,
        color: route.color,
        textColor: route.text,
        agency: route.agency,
        from: from.name,
        to: to.name,
        fromLoc: { lat: from.lat, lon: from.lon },
        toLoc: { lat: to.lat, lon: to.lon },
        departure: iso(l.dep),
        arrival: iso(l.arr),
        stopCount: l.alight - l.board,
      },
    };
  });
  const firstRide = r.legs.find((l) => l.mode === 'TRANSIT');
  const startT = r.legs[0].mode === 'WALK' ? firstRide.dep - r.legs[0].secs : firstRide.dep;
  return {
    durationS: r.arrive - startT,
    distanceM: legs.reduce((a, l) => a + l.distanceM, 0),
    departure: iso(firstRide.dep),
    leaveAt: iso(startT),
    arrival: iso(r.arrive),
    polyline: legs.flatMap((l) => l.polyline),
    legs,
  };
}

// ---------------------------------------------------------------- service
export function createTransit({ dataDir }) {
  const dir = process.env.CONCIERGE_GTFS_DIR || path.join(dataDir, 'gtfs');
  let net = null;
  let loading = null;
  function load() {
    loading ||= new Promise((resolve) => {
      setImmediate(() => {
        const t = Date.now();
        try {
          net = loadFeeds(dir);
          if (net.feeds.length) console.log(`[gtfs] ${net.feeds.map((f) => `${f.agencies.join('/')}: ${f.trips} trips`).join(' · ')} — loaded in ${Date.now() - t} ms`);
        } catch (error) {
          console.warn('[gtfs] load failed:', error.message);
          net = { feeds: [], stops: [] };
        }
        resolve(net);
      });
    });
    return loading;
  }
  load();

  // Route planning is CPU work: bound it per client.
  const limiter = createLimiter({ windowMs: 60_000, max: 30 });
  function mount(app, { hotelBySlug, admin }) {
    app.post('/h/:slug/transit', limit(limiter, clientIp, 'too many route requests'), async (req, res) => {
      const h = hotelBySlug.get(req.params.slug);
      if (!h) return res.status(404).json({ error: 'hotel not found' });
      const n = await load();
      if (!n.feeds.length) return res.json({ configured: false, source: 'gtfs', routes: [] });
      const { origin, destination } = req.body || {};
      const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
      if (!ok(origin) || !ok(destination)) return res.status(400).json({ error: 'origin/destination {lat, lon} required' });
      const at = req.body.at ? new Date(req.body.at) : new Date();
      const routes = plan(n, { origin, destination, at: Number.isNaN(at.getTime()) ? new Date() : at });
      const walkS = walkOnlySecs(origin, destination);
      const name = String(req.body.destName || '').slice(0, 80);
      for (const r of routes) {
        const last = r.legs[r.legs.length - 1];
        if (last.mode === 'WALK' && !last.instruction) last.instruction = name;
      }
      res.json({ configured: true, source: 'gtfs', routes, walkS, walkBetter: !routes.length && walkS <= 45 * 60 });
    });
    app.get('/admin/transit', admin, async (req, res) => {
      const n = await load();
      res.json({ dir, feeds: n.feeds });
    });
    app.post('/admin/transit/reload', admin, async (req, res) => {
      loading = null;
      const n = await load();
      res.json({ feeds: n.feeds });
    });
  }
  return { mount, load, plan: (args) => load().then((n) => plan(n, args)) };
}
