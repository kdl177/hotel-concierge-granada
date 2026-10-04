import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseCsv, haversine, plan, walkOnlySecs, createTransit } from '../../server/app/gtfs.js';
import { shapeForecast } from '../../server/app/weather.js';

test('CSV parser handles quotes, commas, CRLF and BOM', () => {
  const rows = [];
  parseCsv('﻿stop_id,stop_name\r\n1,"Plaza, Nueva"\r\n2,"Dice ""hola"""\r\n', (r) => rows.push(r));
  const flat = JSON.stringify(rows);
  assert.match(flat, /Plaza, Nueva/);
  assert.match(flat, /Dice \\"hola\\"/);
});

test('haversine: hotel → cathedral is about 1.2 km', () => {
  const d = haversine(37.17654, -3.612782, 37.17635, -3.59926);
  assert.ok(d > 1100 && d < 1300, String(d));
});

test('planner with an empty network returns no routes', () => {
  assert.deepEqual(plan({ stops: [], feeds: [] }, { origin: { lat: 37.17, lon: -3.6 }, destination: { lat: 37.18, lon: -3.59 } }), []);
  assert.ok(walkOnlySecs({ lat: 37.17, lon: -3.6 }, { lat: 37.18, lon: -3.59 }) > 600);
});

const gtfsDir = path.resolve('data/gtfs');
const hasFeeds = existsSync(gtfsDir) && readdirSync(gtfsDir).some((f) => f.endsWith('.zip'));
test('official timetables: hotel → Parque de las Ciencias by Metro/bus on a weekday morning', { skip: !hasFeeds && 'no GTFS zips in data/gtfs' }, async () => {
  const transit = createTransit({ dataDir: path.resolve('data') });
  const net = await transit.load();
  assert.ok(net.feeds.length >= 1);
  // Monday 10:00 Madrid time, inside the feeds' validity.
  const routes = plan(net, { origin: { lat: 37.17654, lon: -3.612782 }, destination: { lat: 37.1626, lon: -3.6050 }, at: new Date('2026-10-05T08:00:00Z') });
  assert.ok(routes.length >= 1);
  const r = routes[0];
  assert.ok(r.legs.some((l) => l.mode === 'TRANSIT'));
  assert.ok(r.durationS > 0 && r.durationS < 3600);
});

test('weather shaping: rain flag, golden hour and hourly window', () => {
  const now = new Date('2026-10-04T16:00:00Z');
  const data = {
    utc_offset_seconds: 7200,
    current: { temperature_2m: 21, weather_code: 61, is_day: 1 },
    daily: { sunset: ['2026-10-04T19:40'], temperature_2m_max: [24], temperature_2m_min: [12] },
    hourly: { time: ['2026-10-04T17:00', '2026-10-04T18:00', '2026-10-04T19:00'], temperature_2m: [21, 20, 18], weather_code: [61, 3, 3], precipitation_probability: [80, 20, 10] },
  };
  const w = shapeForecast(data, now);
  assert.equal(w.flags.rain, true);
  assert.equal(w.flags.minutesToSunset, 100);
  assert.equal(w.flags.golden, true);
  assert.equal(w.hours.length, 3);
  assert.equal(shapeForecast({}, now).flags.rain, false);
});
