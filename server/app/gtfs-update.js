/**
 * Keeps the GTFS timetables fresh from Spain's National Access Point
 * (nap.transportes.gob.es): downloads each configured file with the account's
 * ApiKey, checks it is a real feed, and only replaces the local copy when the
 * new one is valid at least as long as the old one. Never leaves a broken or
 * older feed behind.
 *
 *   NAP_API_KEY=…                       your key (free account at nap.transportes.gob.es)
 *   GTFS_NAP_FILES=1367:bus-urbano-granada,1370:metro-granada   (default: these two)
 *   GTFS_UPDATE_DAYS=7                  how often the server checks (0 = never, only manual)
 *
 *   npm run gtfs:update                 same thing from the command line
 *   POST /api/admin/transit/update      same thing from Admin (superadmin)
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseCsv, unzip } from './gtfs.js';

export const NAP_DOWNLOAD =
  'https://nap.transportes.gob.es/api/Fichero/download/';
export const DEFAULT_FILES = '1367:bus-urbano-granada,1370:metro-granada';
const MAX_BYTES = 80 * 1024 * 1024;

/** "1367:bus-urbano-granada,1370:metro-granada" → [{ id, name }] */
export function parseFileList(spec = DEFAULT_FILES) {
  return String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, name] = s.split(':');
      if (!/^\d+$/.test(id))
        throw new Error(`GTFS_NAP_FILES: bad file id "${s}"`);
      return {
        id,
        name: (name || `nap-${id}`).replace(/[^a-z0-9_-]/gi, '-').toLowerCase(),
      };
    });
}

/** Agencies and validity of a GTFS zip buffer; throws when it is not a usable feed. */
export function inspectFeed(buf) {
  const z = unzip(buf);
  const txt = (n) => (z[n] ? z[n].toString('utf8') : '');
  for (const f of ['stops.txt', 'trips.txt', 'stop_times.txt'])
    if (!txt(f)) throw new Error(`not a GTFS feed (missing ${f})`);
  const agencies = [];
  parseCsv(txt('agency.txt'), (a) => agencies.push(a.agency_name));
  let validTo = '0';
  let trips = 0;
  parseCsv(txt('calendar.txt'), (c) => {
    if (c.end_date > validTo) validTo = c.end_date;
  });
  parseCsv(txt('calendar_dates.txt'), (c) => {
    if (c.exception_type === '1' && c.date > validTo) validTo = c.date;
  });
  parseCsv(txt('trips.txt'), () => trips++);
  if (!trips) throw new Error('not a GTFS feed (no trips)');
  return { agencies, validTo, trips };
}

/** Current local feeds: [{ file, agencies, validTo }] (unreadable zips reported with error). */
function localFeeds(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .map((file) => {
      try {
        return { file, ...inspectFeed(readFileSync(path.join(dir, file))) };
      } catch (error) {
        return { file, error: error.message, agencies: [], validTo: '0' };
      }
    });
}

const sameAgencies = (a, b) =>
  a.length && a.length === b.length && a.every((x) => b.includes(x));

/**
 * Downloads every configured file and returns a report:
 *   [{ id, name, file, status: 'updated'|'unchanged'|'kept'|'error', validTo, trips, reason? }]
 * `updated` — a newer feed replaced the local one (or none existed);
 * `unchanged` — same validity as the local copy; `kept` — the download is valid
 * for less time than the local copy, so the local one stays; `error` — download
 * or validation failed, local copy untouched.
 */
export async function updateFeeds({
  dir,
  apiKey,
  files = DEFAULT_FILES,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  if (!apiKey) throw new Error('NAP_API_KEY not set');
  const list = parseFileList(files);
  mkdirSync(dir, { recursive: true });
  const report = [];
  for (const { id, name } of list) {
    const entry = {
      id,
      name,
      file: `${name}.zip`,
      status: 'error',
      validTo: null,
      trips: 0,
    };
    report.push(entry);
    try {
      const res = await fetchImpl(NAP_DOWNLOAD + id, {
        headers: { ApiKey: apiKey, Accept: 'application/zip, */*' },
        redirect: 'follow',
      });
      if (!res.ok)
        throw new Error(
          res.status === 401 || res.status === 403
            ? `NAP rejected the ApiKey (${res.status})`
            : `NAP returned ${res.status}`,
        );
      const len = Number(res.headers?.get?.('content-length') || 0);
      if (len > MAX_BYTES) throw new Error('file too large');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error('file too large');
      const info = inspectFeed(buf);
      entry.validTo = info.validTo;
      entry.trips = info.trips;
      // Replace the file that holds the same operator (whatever its name), else <name>.zip.
      const current = localFeeds(dir);
      const twin =
        current.find((f) => sameAgencies(f.agencies, info.agencies)) ||
        current.find((f) => f.file === entry.file);
      if (twin) entry.file = twin.file;
      const target = path.join(dir, entry.file);
      if (twin && !twin.error) {
        if (info.validTo < twin.validTo) {
          entry.status = 'kept';
          entry.reason = `local feed valid until ${twin.validTo}, download only until ${info.validTo}`;
          log(`[gtfs] ${entry.file}: kept (${entry.reason})`);
          continue;
        }
        if (
          info.validTo === twin.validTo &&
          existsSync(target) &&
          readFileSync(target).equals(buf)
        ) {
          entry.status = 'unchanged';
          log(`[gtfs] ${entry.file}: unchanged (valid until ${info.validTo})`);
          continue;
        }
      }
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, target);
      // A previous file for the same operator under another name would load twice.
      for (const f of current)
        if (f.file !== entry.file && sameAgencies(f.agencies, info.agencies)) {
          try {
            unlinkSync(path.join(dir, f.file));
          } catch {}
        }
      entry.status = 'updated';
      log(
        `[gtfs] ${entry.file}: updated — ${info.agencies.join('/')}, ${info.trips} trips, valid until ${info.validTo}`,
      );
    } catch (error) {
      entry.reason = error.message;
      log(`[gtfs] ${entry.file}: ${error.message}`);
    }
  }
  return report;
}
