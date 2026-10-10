/**
 * Keyless "search anything" around the hotel, on OpenStreetMap data:
 * pharmacies, restaurants, cash machines, supermarkets… and named places.
 *
 *   GET /api/h/:slug/places?q=farmacia&lang=es   → { query, category, places: [...] }
 *   GET /api/h/:slug/places/categories            → quick chips for the UI
 *
 * 1. The query is matched against a multilingual category dictionary
 *    (es/en/fr/de + common synonyms) → OSM tags → Overpass "around" query.
 * 2. Otherwise it is a name ("Bar Los Diamantes") → Overpass name search,
 *    then Nominatim (bounded to the hotel's area) as a fallback.
 * Results are cached 15 min per hotel+query, and sorted by distance.
 */
import { haversine } from './gtfs.js';
import { createLimiter, limit, clientIp } from './security.js';

const RADIUS_M = 2500;
const NAME_RADIUS_M = 6000;
const TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 12_000;
const OVERPASS = process.env.CONCIERGE_OVERPASS_URL
  ? [process.env.CONCIERGE_OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ];

/**
 * Category dictionary. `match` = words a guest may type (lower-case, no accents);
 * `osm` = Overpass tag filters (each entry is one [key=value] selector set).
 */
export const CATEGORIES = [
  {
    key: 'pharmacy',
    icon: 'local_pharmacy',
    osm: ['amenity=pharmacy'],
    label: {
      es: 'Farmacias',
      en: 'Pharmacies',
      fr: 'Pharmacies',
      de: 'Apotheken',
    },
    match: [
      'farmacia',
      'farmacias',
      'pharmacy',
      'pharmacies',
      'pharmacie',
      'apotheke',
      'medicina',
      'medicinas',
      'medicamento',
      'medicine',
      'drugstore',
      'chemist',
    ],
  },
  {
    key: 'eat',
    icon: 'restaurant',
    osm: ['amenity=restaurant', 'amenity=fast_food', 'amenity=food_court'],
    label: {
      es: 'Para comer',
      en: 'Places to eat',
      fr: 'Où manger',
      de: 'Essen',
    },
    match: [
      'comer',
      'comida',
      'restaurante',
      'restaurantes',
      'restaurant',
      'restaurants',
      'cenar',
      'cena',
      'almorzar',
      'almuerzo',
      'eat',
      'food',
      'dinner',
      'lunch',
      'manger',
      'essen',
      'hambre',
      'hungry',
      'pizza',
      'pizzeria',
      'hamburguesa',
      'burger',
      'kebab',
      'sushi',
      'paella',
    ],
  },
  {
    key: 'tapas',
    icon: 'tapas',
    osm: ['amenity=bar', 'amenity=pub'],
    label: {
      es: 'Tapas y bares',
      en: 'Tapas & bars',
      fr: 'Tapas et bars',
      de: 'Tapas & Bars',
    },
    match: [
      'tapas',
      'tapa',
      'bar',
      'bares',
      'bars',
      'pub',
      'cerveza',
      'beer',
      'biere',
      'bier',
      'copas',
      'drinks',
      'vino',
      'wine',
      'bodega',
    ],
  },
  {
    key: 'cafe',
    icon: 'local_cafe',
    osm: ['amenity=cafe', 'shop=bakery', 'shop=pastry', 'amenity=ice_cream'],
    label: {
      es: 'Cafés y desayuno',
      en: 'Cafés & breakfast',
      fr: 'Cafés et petit-déjeuner',
      de: 'Cafés & Frühstück',
    },
    match: [
      'cafe',
      'cafes',
      'cafeteria',
      'coffee',
      'kaffee',
      'desayuno',
      'desayunar',
      'breakfast',
      'petit dejeuner',
      'fruhstuck',
      'churros',
      'chocolate',
      'pasteleria',
      'panaderia',
      'bakery',
      'boulangerie',
      'backerei',
      'helado',
      'helados',
      'ice cream',
      'glace',
      'eis',
      'te',
      'tea',
      'teteria',
    ],
  },
  {
    key: 'supermarket',
    icon: 'local_grocery_store',
    osm: ['shop=supermarket', 'shop=convenience', 'shop=greengrocer'],
    label: {
      es: 'Supermercados',
      en: 'Supermarkets',
      fr: 'Supermarchés',
      de: 'Supermärkte',
    },
    match: [
      'supermercado',
      'supermercados',
      'supermarket',
      'supermarche',
      'supermarkt',
      'tienda',
      'comprar comida',
      'groceries',
      'grocery',
      'fruteria',
      'agua',
      'water',
    ],
  },
  {
    key: 'atm',
    icon: 'local_atm',
    osm: ['amenity=atm', 'amenity=bank'],
    label: {
      es: 'Cajeros y bancos',
      en: 'ATMs & banks',
      fr: 'Distributeurs et banques',
      de: 'Geldautomaten & Banken',
    },
    match: [
      'cajero',
      'cajeros',
      'atm',
      'banco',
      'bancos',
      'bank',
      'banque',
      'geldautomat',
      'dinero',
      'efectivo',
      'cash',
      'money',
      'sacar dinero',
      'withdraw',
    ],
  },
  {
    key: 'hospital',
    icon: 'local_hospital',
    osm: [
      'amenity=hospital',
      'amenity=clinic',
      'amenity=doctors',
      'healthcare=centre',
    ],
    label: {
      es: 'Médico y urgencias',
      en: 'Doctor & emergency',
      fr: 'Médecin et urgences',
      de: 'Arzt & Notaufnahme',
    },
    match: [
      'hospital',
      'urgencias',
      'medico',
      'doctor',
      'clinica',
      'clinic',
      'emergency',
      'hopital',
      'krankenhaus',
      'arzt',
      'centro de salud',
      'ambulatorio',
      'enfermo',
      'sick',
    ],
  },
  {
    key: 'dentist',
    icon: 'dentistry',
    osm: ['amenity=dentist'],
    label: {
      es: 'Dentistas',
      en: 'Dentists',
      fr: 'Dentistes',
      de: 'Zahnärzte',
    },
    match: ['dentista', 'dentist', 'dentiste', 'zahnarzt', 'muela', 'tooth'],
  },
  {
    key: 'taxi',
    icon: 'local_taxi',
    osm: ['amenity=taxi'],
    label: {
      es: 'Paradas de taxi',
      en: 'Taxi ranks',
      fr: 'Stations de taxi',
      de: 'Taxistände',
    },
    match: ['taxi', 'taxis', 'parada de taxi'],
  },
  {
    key: 'parking',
    icon: 'local_parking',
    osm: ['amenity=parking][parking!=street_side][access!=private'],
    label: {
      es: 'Aparcamientos',
      en: 'Car parks',
      fr: 'Parkings',
      de: 'Parkplätze',
    },
    match: [
      'parking',
      'aparcamiento',
      'aparcar',
      'garaje',
      'car park',
      'parkplatz',
      'parkhaus',
      'coche',
      'car',
    ],
  },
  {
    key: 'fuel',
    icon: 'local_gas_station',
    osm: ['amenity=fuel'],
    label: {
      es: 'Gasolineras',
      en: 'Petrol stations',
      fr: 'Stations-service',
      de: 'Tankstellen',
    },
    match: [
      'gasolinera',
      'gasolina',
      'fuel',
      'petrol',
      'gas station',
      'station service',
      'tankstelle',
      'repostar',
    ],
  },
  {
    key: 'post',
    icon: 'local_post_office',
    osm: ['amenity=post_office', 'amenity=post_box'],
    label: { es: 'Correos', en: 'Post office', fr: 'Poste', de: 'Post' },
    match: [
      'correos',
      'post',
      'post office',
      'poste',
      'sello',
      'sellos',
      'stamps',
      'postal',
      'carta',
      'buzon',
    ],
  },
  {
    key: 'shopping',
    icon: 'shopping_bag',
    osm: [
      'shop=clothes',
      'shop=shoes',
      'shop=mall',
      'shop=department_store',
      'shop=gift',
      'shop=souvenir',
    ],
    label: { es: 'Compras', en: 'Shopping', fr: 'Shopping', de: 'Einkaufen' },
    match: [
      'compras',
      'comprar',
      'tienda de ropa',
      'ropa',
      'zapatos',
      'shopping',
      'shop',
      'clothes',
      'shoes',
      'centro comercial',
      'mall',
      'souvenir',
      'souvenirs',
      'regalo',
      'regalos',
      'gift',
      'gifts',
      'cadeau',
      'geschenk',
      'einkaufen',
      'kleidung',
    ],
  },
  {
    key: 'market',
    icon: 'storefront',
    osm: ['amenity=marketplace'],
    label: { es: 'Mercados', en: 'Markets', fr: 'Marchés', de: 'Märkte' },
    match: ['mercado', 'mercados', 'market', 'marche', 'markt', 'mercadillo'],
  },
  {
    key: 'laundry',
    icon: 'local_laundry_service',
    osm: ['shop=laundry', 'shop=dry_cleaning'],
    label: { es: 'Lavanderías', en: 'Laundry', fr: 'Laverie', de: 'Wäscherei' },
    match: [
      'lavanderia',
      'lavar ropa',
      'laundry',
      'laundromat',
      'laverie',
      'waschsalon',
      'tintoreria',
      'dry cleaning',
    ],
  },
  {
    key: 'phone',
    icon: 'smartphone',
    osm: ['shop=mobile_phone', 'shop=electronics', 'shop=computer'],
    label: {
      es: 'Móviles y electrónica',
      en: 'Phones & electronics',
      fr: 'Téléphones et électronique',
      de: 'Handys & Elektronik',
    },
    match: [
      'movil',
      'telefono',
      'cargador',
      'tarjeta sim',
      'sim',
      'phone',
      'charger',
      'electronica',
      'electronics',
      'ordenador',
      'computer',
      'handy',
      'ladegerat',
    ],
  },
  {
    key: 'tobacco',
    icon: 'smoking_rooms',
    osm: ['shop=tobacco'],
    label: {
      es: 'Estancos',
      en: 'Tobacconists',
      fr: 'Tabacs',
      de: 'Tabakläden',
    },
    match: [
      'estanco',
      'tabaco',
      'tobacco',
      'cigarettes',
      'cigarrillos',
      'tabac',
      'zigaretten',
    ],
  },
  {
    key: 'bikes',
    icon: 'pedal_bike',
    osm: ['amenity=bicycle_rental', 'shop=bicycle'],
    label: {
      es: 'Alquiler de bicis',
      en: 'Bike rental',
      fr: 'Location de vélos',
      de: 'Fahrradverleih',
    },
    match: [
      'bici',
      'bicicleta',
      'alquiler de bici',
      'bike',
      'bicycle',
      'velo',
      'fahrrad',
    ],
  },
  {
    key: 'museum',
    icon: 'museum',
    osm: ['tourism=museum', 'tourism=gallery'],
    label: { es: 'Museos', en: 'Museums', fr: 'Musées', de: 'Museen' },
    match: [
      'museo',
      'museos',
      'museum',
      'museums',
      'musee',
      'galeria',
      'gallery',
      'exposicion',
      'exhibition',
    ],
  },
  {
    key: 'viewpoint',
    icon: 'landscape',
    osm: ['tourism=viewpoint'],
    label: {
      es: 'Miradores',
      en: 'Viewpoints',
      fr: 'Points de vue',
      de: 'Aussichtspunkte',
    },
    match: [
      'mirador',
      'miradores',
      'viewpoint',
      'vistas',
      'views',
      'point de vue',
      'aussicht',
      'atardecer',
      'sunset',
    ],
  },
  {
    key: 'park',
    icon: 'park',
    osm: ['leisure=park', 'leisure=garden'],
    label: {
      es: 'Parques y jardines',
      en: 'Parks & gardens',
      fr: 'Parcs et jardins',
      de: 'Parks & Gärten',
    },
    match: [
      'parque',
      'parques',
      'jardin',
      'jardines',
      'park',
      'parks',
      'garden',
      'gardens',
      'parc',
      'garten',
    ],
  },
  {
    key: 'flamenco',
    icon: 'music_note',
    osm: ['amenity=theatre', 'amenity=nightclub', 'amenity=music_venue'],
    label: {
      es: 'Espectáculos y noche',
      en: 'Shows & nightlife',
      fr: 'Spectacles et vie nocturne',
      de: 'Shows & Nachtleben',
    },
    match: [
      'flamenco',
      'espectaculo',
      'show',
      'teatro',
      'theatre',
      'theater',
      'concierto',
      'concert',
      'discoteca',
      'club',
      'nightclub',
      'noche',
      'nightlife',
      'salir',
    ],
  },
  {
    key: 'spa',
    icon: 'spa',
    osm: [
      'leisure=spa',
      'amenity=public_bath',
      'shop=massage',
      'shop=beauty',
      'shop=hairdresser',
    ],
    label: {
      es: 'Spa, baños y belleza',
      en: 'Spa, baths & beauty',
      fr: 'Spa, bains et beauté',
      de: 'Spa, Bäder & Beauty',
    },
    match: [
      'spa',
      'hammam',
      'banos arabes',
      'arab baths',
      'masaje',
      'massage',
      'peluqueria',
      'hairdresser',
      'coiffeur',
      'friseur',
      'belleza',
      'beauty',
      'unas',
      'nails',
    ],
  },
  {
    key: 'church',
    icon: 'church',
    osm: ['amenity=place_of_worship'],
    label: {
      es: 'Iglesias y templos',
      en: 'Churches & temples',
      fr: 'Églises et temples',
      de: 'Kirchen & Tempel',
    },
    match: [
      'iglesia',
      'iglesias',
      'misa',
      'church',
      'mass',
      'eglise',
      'kirche',
      'mezquita',
      'mosque',
      'sinagoga',
      'synagogue',
      'catedral',
      'cathedral',
    ],
  },
  {
    key: 'toilets',
    icon: 'wc',
    osm: ['amenity=toilets'],
    label: {
      es: 'Aseos públicos',
      en: 'Public toilets',
      fr: 'Toilettes publiques',
      de: 'Öffentliche Toiletten',
    },
    match: [
      'aseo',
      'aseos',
      'bano',
      'banos',
      'servicio',
      'wc',
      'toilet',
      'toilets',
      'restroom',
      'toilettes',
      'toilette',
    ],
  },
  {
    key: 'police',
    icon: 'local_police',
    osm: ['amenity=police'],
    label: { es: 'Policía', en: 'Police', fr: 'Police', de: 'Polizei' },
    match: [
      'policia',
      'police',
      'comisaria',
      'polizei',
      'denuncia',
      'robo',
      'theft',
      'stolen',
      'perdido',
      'lost',
    ],
  },
  {
    key: 'exchange',
    icon: 'currency_exchange',
    osm: ['amenity=bureau_de_change'],
    label: {
      es: 'Cambio de moneda',
      en: 'Currency exchange',
      fr: 'Bureau de change',
      de: 'Geldwechsel',
    },
    match: [
      'cambio de moneda',
      'cambio',
      'exchange',
      'currency',
      'change',
      'wechselstube',
      'divisas',
      'euros',
      'dolares',
    ],
  },
  {
    key: 'gym',
    icon: 'fitness_center',
    osm: [
      'leisure=fitness_centre',
      'leisure=swimming_pool',
      'leisure=sports_centre',
    ],
    label: {
      es: 'Gimnasios y piscinas',
      en: 'Gyms & pools',
      fr: 'Salles de sport et piscines',
      de: 'Fitness & Schwimmbäder',
    },
    match: [
      'gimnasio',
      'gym',
      'fitness',
      'piscina',
      'pool',
      'swimming',
      'piscine',
      'schwimmbad',
      'deporte',
      'sport',
      'correr',
      'running',
    ],
  },
  {
    key: 'books',
    icon: 'menu_book',
    osm: ['shop=books', 'amenity=library', 'shop=newsagent'],
    label: {
      es: 'Librerías y prensa',
      en: 'Books & newspapers',
      fr: 'Librairies et presse',
      de: 'Bücher & Zeitungen',
    },
    match: [
      'libreria',
      'libros',
      'bookshop',
      'books',
      'librairie',
      'buchhandlung',
      'biblioteca',
      'library',
      'periodico',
      'newspaper',
      'prensa',
      'kiosko',
      'kiosk',
    ],
  },
  {
    key: 'transport',
    icon: 'directions_bus',
    osm: [
      'amenity=bus_station',
      'railway=station',
      'railway=tram_stop',
      'public_transport=station',
    ],
    label: { es: 'Estaciones', en: 'Stations', fr: 'Gares', de: 'Bahnhöfe' },
    match: [
      'estacion',
      'estacion de autobuses',
      'estacion de tren',
      'bus station',
      'train station',
      'gare',
      'bahnhof',
      'metro',
      'tren',
      'train',
      'autobus',
      'renfe',
      'alsa',
      'aeropuerto',
      'airport',
      'flughafen',
      'aeroport',
    ],
  },
  {
    key: 'wifi',
    icon: 'wifi',
    osm: [
      'internet_access=wlan][amenity=cafe',
      'amenity=internet_cafe',
      'amenity=coworking_space',
    ],
    label: {
      es: 'Wifi y coworking',
      en: 'Wi-Fi & coworking',
      fr: 'Wi-Fi et coworking',
      de: 'WLAN & Coworking',
    },
    match: ['wifi', 'internet', 'coworking', 'trabajar', 'work'],
  },
];

export const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(
  'de del la las el los un una unos unas y o a en por para con sin cerca cercano cercana aqui donde quiero busco necesito algo sitio lugar mi me the of near nearby here where want need some place my a an to for in on and or zum zur in der die das ein eine ich mich nahe hier le la les des du un une pres ici je veux'.split(
    ' ',
  ),
);

/** Category whose synonym is the whole query, a word of it, or a prefix of a word. */
export function matchCategory(query) {
  return matchCategoryDetailed(query)?.category || null;
}
/** Also says whether the query carries a proper name besides the category ("bar los diamantes"). */
export function matchCategoryDetailed(query) {
  const q = norm(query);
  if (!q) return null;
  const words = q.split(' ');
  let best = null;
  for (const c of CATEGORIES) {
    for (const m of c.match) {
      const mn = norm(m);
      let score = 0;
      if (q === mn) score = 100;
      else if (mn.includes(' ') ? q.includes(mn) : words.includes(mn))
        score = 60 + mn.length;
      else if (
        mn.length >= 5 &&
        words.some(
          (w) => w.length >= 4 && (mn.startsWith(w) || w.startsWith(mn)),
        )
      )
        score = 30 + mn.length;
      if (score > (best?.score || 0))
        best = { score, category: c, synonym: mn };
    }
  }
  if (!best) return null;
  const extra = words.filter(
    (w) =>
      !STOP.has(w) &&
      !best.synonym.split(' ').includes(w) &&
      !(
        w.length >= 4 &&
        (best.synonym.startsWith(w) || w.startsWith(best.synonym))
      ),
  );
  return { category: best.category, hasName: extra.length > 0 };
}

function overpassQuery(h, category, name) {
  const around = `around:${category ? RADIUS_M : NAME_RADIUS_M},${h.lat.toFixed(5)},${h.lon.toFixed(5)}`;
  let body;
  if (category) {
    body = category.osm.map((sel) => `nwr[${sel}](${around});`).join('');
  } else {
    const safe = norm(name).replace(/[^a-z0-9 ]/g, '');
    // Case/accent-insensitive regex on the name; Overpass has no NFD, so match letter-by-letter with accent classes.
    const re = safe
      .split('')
      .map(
        (ch) =>
          ({
            a: '[aáàâä]',
            e: '[eéèêë]',
            i: '[iíìîï]',
            o: '[oóòôö]',
            u: '[uúùûü]',
            n: '[nñ]',
            c: '[cç]',
            ' ': '.{0,3}',
          })[ch] || ch,
      )
      .join('');
    body = `nwr["name"~"${re}",i](${around});`;
  }
  return `[out:json][timeout:10];(${body});out center tags 60;`;
}

function shape(el, h, category) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = t.name || t['name:es'] || t.brand || t.operator || '';
  if (!name && !category) return null;
  const street = t['addr:street']
    ? `${t['addr:street']}${t['addr:housenumber'] ? ` ${t['addr:housenumber']}` : ''}`
    : '';
  const kind =
    t.amenity ||
    t.shop ||
    t.tourism ||
    t.leisure ||
    t.healthcare ||
    t.railway ||
    t.public_transport ||
    '';
  return {
    id: `osm:${el.type}/${el.id}`,
    name: name || (category ? '' : kind),
    kind,
    category: category?.key || null,
    icon: category?.icon || 'place',
    lat,
    lon,
    address: street,
    hours: t.opening_hours || '',
    phone: t.phone || t['contact:phone'] || '',
    website: t.website || t['contact:website'] || '',
    cuisine: t.cuisine ? t.cuisine.split(';')[0].replace(/_/g, ' ') : '',
    wheelchair: t.wheelchair === 'yes',
    distanceM: Math.round(haversine(h.lat, h.lon, lat, lon)),
  };
}

export function createPlaces({
  fetchImpl = (...a) => fetch(...a),
  nominatimFetch,
} = {}) {
  const cache = new Map();
  const limiter = createLimiter({ windowMs: 60_000, max: 30 });

  async function overpass(query) {
    let lastError;
    for (const url of OVERPASS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'hotel-concierge',
          },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`overpass ${res.status}`);
        return (await res.json()).elements || [];
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('overpass unavailable');
  }

  async function nominatim(h, name) {
    const fetcher = nominatimFetch || fetchImpl;
    const box = `${h.lon - 0.08},${h.lat + 0.06},${h.lon + 0.08},${h.lat - 0.06}`;
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&bounded=1&viewbox=${box}&q=${encodeURIComponent(name)}`;
    const res = await fetcher(url, {
      headers: {
        'User-Agent': 'hotel-concierge (guest search)',
        'Accept-Language': 'es',
      },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      return {
        id: `osm:${r.osm_type}/${r.osm_id}`,
        name: r.name || r.display_name.split(',')[0],
        kind: r.type || '',
        category: null,
        icon: 'place',
        lat,
        lon,
        address: r.display_name.split(',').slice(1, 3).join(',').trim(),
        hours: '',
        phone: '',
        website: '',
        cuisine: '',
        wheelchair: false,
        distanceM: Math.round(haversine(h.lat, h.lon, lat, lon)),
      };
    });
  }

  async function search(h, q) {
    const key = `${h.id}|${norm(q)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
    const detailed = matchCategoryDetailed(q);
    const category = detailed?.category || null;
    let places = [];
    let source = 'osm';
    try {
      // "bar los diamantes": the name first; the category only if nothing is called that.
      if (detailed?.hasName)
        places = (await overpass(overpassQuery(h, null, q)))
          .map((el) => shape(el, h, category))
          .filter(Boolean);
      if (!places.length)
        places = (await overpass(overpassQuery(h, category, q)))
          .map((el) => shape(el, h, category))
          .filter(Boolean);
    } catch (error) {
      source = 'error';
      if (!category) {
        try {
          places = await nominatim(h, q);
          source = 'osm';
        } catch {}
      }
    }
    if (!category && !places.length && source !== 'error') {
      try {
        places = await nominatim(h, q);
      } catch {}
    }
    // Dedupe by name+rounded position, nearest first, cap.
    const seen = new Set();
    places = places
      .sort((a, b) => a.distanceM - b.distanceM)
      .filter((p) => {
        const k = `${norm(p.name)}|${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 25);
    const data = {
      query: q,
      category: category
        ? { key: category.key, icon: category.icon, label: category.label }
        : null,
      places,
      source,
    };
    if (source !== 'error') cache.set(key, { at: Date.now(), data });
    return data;
  }

  function mount(app, { hotelBySlug }) {
    app.get('/h/:slug/places/categories', (req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json({
        categories: CATEGORIES.map((c) => ({
          key: c.key,
          icon: c.icon,
          label: c.label,
          example: c.match[0],
        })),
      });
    });
    app.get(
      '/h/:slug/places',
      limit(limiter, clientIp, 'too many searches'),
      async (req, res) => {
        const h = hotelBySlug.get(req.params.slug);
        if (!h) return res.status(404).json({ error: 'hotel not found' });
        const q = String(req.query.q || '')
          .trim()
          .slice(0, 80);
        if (q.length < 2)
          return res.json({
            query: q,
            category: null,
            places: [],
            source: 'osm',
          });
        const data = await search(h, q);
        if (data.source === 'error' && !data.places.length)
          return res.status(503).json({ ...data, error: 'places unavailable' });
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json(data);
      },
    );
  }
  return { mount, search, matchCategory };
}
