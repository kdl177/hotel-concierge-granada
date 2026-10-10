import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaces, matchCategory, CATEGORIES } from '../../server/app/places.js';

const HOTEL = { id: 'h1', lat: 37.17654, lon: -3.612782 };
const osm = (elements) => async (url, init) => ({ ok: true, json: async () => ({ elements }), _q: decodeURIComponent(String(init?.body || '')) });

test('the dictionary understands guests in four languages', () => {
  const cases = { farmacia: 'pharmacy', 'para comer': 'eat', 'where to eat': 'eat', Apotheke: 'pharmacy', pharmacie: 'pharmacy', cajero: 'atm', 'sacar dinero': 'atm', supermercado: 'supermarket', médico: 'hospital', tapas: 'tapas', 'alquiler de bici': 'bikes', 'bus station': 'transport', Alhambra: null, 'xyz': null };
  for (const [q, k] of Object.entries(cases)) assert.equal(matchCategory(q)?.key ?? null, k, q);
  assert.ok(CATEGORIES.every((c) => c.label.es && c.label.en && c.label.fr && c.label.de && c.icon));
});

test('a category search returns places sorted by distance with hours and phone', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(decodeURIComponent(init.body));
    return { ok: true, json: async () => ({ elements: [
      { type: 'node', id: 1, lat: 37.18, lon: -3.61, tags: { amenity: 'pharmacy', name: 'Farmacia Lejos', opening_hours: 'Mo-Fr 09:00-20:00' } },
      { type: 'node', id: 2, lat: 37.1768, lon: -3.6125, tags: { amenity: 'pharmacy', name: 'Farmacia Cerca', phone: '+34 958 000 000', 'addr:street': 'Calle Real', 'addr:housenumber': '5' } },
      { type: 'way', id: 3, center: { lat: 37.177, lon: -3.613 }, tags: { amenity: 'pharmacy' } },
    ] }) };
  };
  const places = createPlaces({ fetchImpl });
  const r = await places.search(HOTEL, 'farmacia');
  assert.equal(r.category.key, 'pharmacy');
  assert.ok(calls[0].includes('amenity=pharmacy') && calls[0].includes('around:2500'));
  assert.deepEqual(r.places.map((p) => p.name), ['Farmacia Cerca', '', 'Farmacia Lejos']);
  assert.equal(r.places[0].address, 'Calle Real 5');
  assert.equal(r.places[0].phone, '+34 958 000 000');
  assert.equal(r.places[2].hours, 'Mo-Fr 09:00-20:00');
  assert.ok(r.places[0].distanceM < r.places[2].distanceM);
  const again = await places.search(HOTEL, 'FARMACIA');
  assert.equal(calls.length, 1, 'cached, accent/case-insensitive');
  assert.equal(again.places.length, 3);
});

test('a named place is searched by name first, by category only as a fallback', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const q = decodeURIComponent(init.body);
    calls.push(q);
    if (q.includes('"name"~')) return { ok: true, json: async () => ({ elements: [{ type: 'node', id: 9, lat: 37.175, lon: -3.6, tags: { amenity: 'bar', name: 'Bar Los Diamantes' } }] }) };
    return { ok: true, json: async () => ({ elements: [] }) };
  };
  const r = await createPlaces({ fetchImpl }).search(HOTEL, 'bar los diamantes');
  assert.equal(r.places[0].name, 'Bar Los Diamantes');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /d\[iíìîï\]\[aáàâä\]m/);
});

test('unknown words fall back to Nominatim; outages are reported, never cached', async () => {
  let overpassDown = true;
  const fetchImpl = async (url) => {
    if (url.includes('nominatim')) return { ok: true, json: async () => [{ osm_type: 'node', osm_id: 5, lat: '37.17', lon: '-3.6', name: 'Carmen de los Mártires', display_name: 'Carmen de los Mártires, Realejo, Granada', type: 'garden' }] };
    if (overpassDown) return { ok: false, status: 504 };
    return { ok: true, json: async () => ({ elements: [] }) };
  };
  const places = createPlaces({ fetchImpl });
  const r = await places.search(HOTEL, 'carmen de los martires');
  assert.equal(r.places[0].name, 'Carmen de los Mártires');
  const cat = await places.search(HOTEL, 'farmacia');
  assert.equal(cat.source, 'error');
  assert.equal(cat.places.length, 0);
  overpassDown = false;
  const cat2 = await places.search(HOTEL, 'farmacia');
  assert.equal(cat2.source, 'osm', 'the failed answer was not cached');
});
