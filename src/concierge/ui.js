/**
 * Guest interface over the 3D map.
 *
 * Two surfaces:
 *  - Explore panel (bottom sheet on phones, left panel on kiosks): home,
 *    search, place detail with in-app directions and a step-by-step guide.
 *  - Tasks panel (right panel on kiosks, a tab on phones): the hotel's quick
 *    actions (call, book, request) and the guest's own plan with checklists
 *    and booking buttons per place.
 */
import { POI_CATEGORIES } from './data/pois.js';
import { LANGS, LANG_LABELS, getLang, setLang, t, L } from './i18n.js';
import {
  searchPlaces,
  fetchSearchCategories,
  fetchRoute,
  fetchTransit,
  distanceFromHotelM,
  dayMoment,
  isOpenNow,
  formatDistance,
  formatDuration,
  formatTime,
  submitRequest,
  fetchRequests,
  fetchChat,
  sendChat,
  fetchWeather,
  track,
} from './services.js';
import { glyph } from '../design/icons.js';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
// Icon names are ligatures of the symbol font: only [a-z0-9_] ever reaches the DOM.
const icon = (name, cls = '') =>
  `<span class="msym ${esc(cls)}" aria-hidden="true">${glyph(name)}</span>`;
const telHref = (n) => `tel:${String(n ?? '').replace(/[^0-9+]/g, '')}`;

/** Custom eight-point "Nasrid star" seal used on verified data (official timetables). */
const sealSvg = () =>
  '<svg class="seal-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l2.6 4.2 4.8-1.1-1.1 4.8 4.2 2.6-4.2 2.6 1.1 4.8-4.8-1.1L12 22.5l-2.6-4.2-4.8 1.1 1.1-4.8L1.5 12l4.2-2.6-1.1-4.8 4.8 1.1z" fill="currentColor"/><path d="M8.2 12.3l2.4 2.4 5.2-5.2" fill="none" stroke="var(--seal-ink,#14110a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const VEHICLE_ICON = {
  BUS: 'directions_bus',
  SUBWAY: 'subway',
  TRAM: 'tram',
  LIGHT_RAIL: 'tram',
  RAIL: 'train',
  HEAVY_RAIL: 'train',
  METRO_RAIL: 'subway',
};
const SNAPS = ['collapsed', 'half', 'full'];

export function createUi({ root, globe, config, room = null }) {
  const HOTEL = config.hotel;
  const HOTEL_SERVICES = config.services;
  const HOTEL_ACTIONS = config.actions;
  const POIS = config.pois;
  const LANGS_ON = HOTEL.langs?.length
    ? LANGS.filter((l) => HOTEL.langs.includes(l))
    : LANGS;
  const state = {
    view: { name: 'home' },
    stack: [],
    sheet: 'half',
    tab: 'explore', // explore | tasks (phones)
    routeMode: 'walk',
    routeCache: new Map(),
    abort: null,
    searchTimer: null,
    searchResults: null,
    searchCategory: null,
    searchError: null,
    quickCats: [],
    tick: null,
    guideTimer: null,
    guide: null, // { steps: [{lat,lon,text}], i }
    done: loadSet('concierge.done'),
    plan: loadSet('concierge.plan'),
    requestForm: null, // { type, title, fields, preset }
    requests: loadList('concierge.requests'), // [{id, type, status, ...}]
    requestsTick: null,
    chat: {
      open: false,
      messages: [],
      lastId: 0,
      unread: 0,
      requestId: null,
      sending: false,
    },
    weather: null,
    // From the room QR: room number only; the name is what this device typed before for that same room.
    guest: room
      ? {
          room: room.number,
          name:
            loadObj('concierge.guest')?.room === room.number
              ? loadObj('concierge.guest').name || ''
              : '',
        }
      : loadObj('concierge.guest'), // { room, name }
  };

  root.innerHTML = `
    <header class="cg-top">
      <div class="cg-brand">
        <span class="cg-logo">${icon('hotel')}</span>
        <div><div class="cg-hotel">${esc(HOTEL.name)}</div><div class="cg-city">${esc(HOTEL.city || '')}${room ? ` · ${esc(t('room'))} ${esc(room.number)}` : ''}</div></div>
      </div>
      <div class="cg-langs" role="group" aria-label="Idioma · Language">
        ${LANGS_ON.map((l) => `<button data-lang="${l}" class="${l === getLang() ? 'on' : ''}" aria-pressed="${l === getLang()}" lang="${l}">${LANG_LABELS[l]}</button>`).join('')}
      </div>
    </header>
    <div class="cg-map-actions">
      <button class="cg-fab" data-action="home-view" title="${esc(HOTEL.name)}">${icon('hotel')}</button>
    </div>
    <section class="cg-sheet" data-sheet="half">
      <button type="button" class="cg-grip" data-action="sheet-cycle" aria-label="${esc(t('explore'))}: ↕" aria-expanded="false"><span class="cg-handle"></span></button>
      <div class="cg-panel"></div>
    </section>
    <aside class="cg-side">
      <div class="cg-side-panel"></div>
    </aside>
    <nav class="cg-tabs">
      <button data-tab="explore" class="on" aria-pressed="true">${icon('explore')}<span>${esc(t('explore'))}</span></button>
      <button data-tab="tasks" aria-pressed="false">${icon('checklist')}<span>${esc(t('tasks'))}</span></button>
    </nav>
    <div class="cg-guide" hidden></div>
  `;
  const sheet = root.querySelector('.cg-sheet');
  const panel = root.querySelector('.cg-panel');
  const side = root.querySelector('.cg-side');
  const sidePanel = root.querySelector('.cg-side-panel');
  const tabs = root.querySelector('.cg-tabs');
  const guideBar = root.querySelector('.cg-guide');

  globe.addMarker({
    id: 'hotel',
    lat: HOTEL.lat,
    lon: HOTEL.lon,
    label: HOTEL.name,
    kind: 'hotel',
  });
  for (const p of POIS)
    globe.addMarker({
      id: p.id,
      lat: p.lat,
      lon: p.lon,
      label: L(p.name),
      kind: 'poi',
    });

  /** Guest-friendly text for a failed send (rate limit, blocked device, bad room…). */
  function failText(error) {
    const m = String(error?.message || '');
    if (/too many|limit/.test(m)) return t('tooMany');
    if (m === 'blocked') return t('blockedMsg');
    if (/room/.test(m)) return t('invalidRoom');
    return t('requestFailed');
  }

  // ---------- navigation ----------
  function go(view, { push = true } = {}) {
    if (push) state.stack.push(state.view);
    state.view = view;
    state.abort?.abort();
    stopGuide();
    render();
    focusHeading();
  }
  /** After navigating, move keyboard/screen-reader focus to the new view's title. */
  function focusHeading() {
    const h = panel.querySelector('h1, h2');
    if (
      !h ||
      (!panel.contains(document.activeElement) &&
        document.activeElement !== document.body)
    )
      return;
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }
  function back() {
    state.view = state.stack.pop() || { name: 'home' };
    state.abort?.abort();
    stopGuide();
    if (state.view.name === 'home') {
      globe.clearRoute();
      globe.setSelected(null);
      globe.removeMarkers('result');
      globe.removeMarkers('stop');
    }
    render();
    focusHeading();
  }
  function setSheet(mode) {
    state.sheet = mode;
    sheet.dataset.sheet = mode;
    sheet.style.transform = '';
    sheet
      .querySelector('.cg-grip')
      ?.setAttribute('aria-expanded', String(mode === 'full'));
  }
  function setTab(tab) {
    state.tab = tab;
    root.dataset.panel = tab;
    tabs.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === tab);
      b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    });
    if (tab === 'tasks') renderTasks();
  }

  // ---------- rendering ----------
  function render() {
    const v = state.view;
    let html = '';
    if (v.name === 'home') html = renderHome();
    else if (v.name === 'search') html = renderSearch(v);
    else if (v.name === 'catalog') html = renderCatalog(v);
    else if (v.name === 'place') html = renderPlace(v);
    else if (v.name === 'hotel') html = renderHotel();
    else if (v.name === 'service') html = renderService(v);
    panel.innerHTML = html;
    panel.scrollTop = 0;
    if (v.name === 'place') loadRoute(v);
    renderTasks();
    tabs.querySelector('[data-tab="explore"] span:not(.msym)').textContent =
      t('explore');
    tabs.querySelector('[data-tab="tasks"] span:not(.msym)').textContent =
      t('tasks');
  }

  function header(title, sub = '', extra = '') {
    return `<div class="cg-head">
      <button class="cg-back" data-action="back" aria-label="${esc(t('back'))}">${icon('arrow_back')}</button>
      <div class="cg-head-text"><h2>${esc(title)}</h2>${sub ? `<div class="cg-sub">${esc(sub)}</div>` : ''}</div>
      ${extra}
    </div>`;
  }

  function searchBox(value = '') {
    return `<label class="cg-search">${icon('search')}
      <input type="search" data-role="search" placeholder="${esc(t('searchPlaceholder'))}" value="${esc(value)}" autocomplete="off" />
    </label>`;
  }

  /** Seals shown on places: each one is backed by real data (see DECISIONES D-01). */
  function poiBadges(p, moment = dayMoment()) {
    const out = [];
    if (p.best?.includes(moment))
      out.push(
        `<span class="cg-seal ideal">${icon('schedule')}${esc(t('badgeIdeal'))}</span>`,
      );
    if (p.indoor)
      out.push(
        `<span class="cg-seal indoor">${icon('roofing')}${esc(t('badgeIndoor'))}</span>`,
      );
    return out.length ? `<div class="cg-seals">${out.join('')}</div>` : '';
  }
  function poiCard(p, { wide = false, badges = false } = {}) {
    const cat = POI_CATEGORIES[p.cat] || { icon: 'place' };
    const d = distanceFromHotelM(p);
    return `<button class="cg-card ${wide ? 'wide' : ''} ${p.photo ? 'has-photo' : ''}" data-action="open-poi" data-id="${esc(p.id)}">
      ${p.photo ? `<img class="cg-card-photo" src="${esc(p.photo)}" alt="" loading="lazy" />` : `<div class="cg-card-icon">${icon(cat?.icon || 'place')}</div>`}
      <div class="cg-card-body">
        <div class="cg-card-title">${esc(L(p.name))}</div>
        <div class="cg-card-meta"><span class="cg-tag">${esc(L(p.tag))}</span> · ${esc(formatDistance(d, t))} · ${esc(formatDuration(p.minutes * 60, t))}</div>
        ${badges ? poiBadges(p) : ''}
      </div>
      ${state.plan.has(p.id) ? icon('bookmark', 'cg-plan-ico') : ''}${icon('chevron_right', 'cg-chev')}
    </button>`;
  }

  // ---------- weather ----------
  const WX = (code, isDay = true) => {
    if (code === 0) return ['clear', isDay ? 'sunny' : 'clear_night'];
    if (code <= 2)
      return ['partly', isDay ? 'partly_cloudy_day' : 'partly_cloudy_night'];
    if (code === 3) return ['cloudy', 'cloud'];
    if (code === 45 || code === 48) return ['fog', 'foggy'];
    if (code >= 51 && code <= 57) return ['drizzle', 'rainy_light'];
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82))
      return ['rain', 'rainy'];
    if ((code >= 71 && code <= 77) || code === 85 || code === 86)
      return ['snow', 'weather_snowy'];
    if (code >= 95) return ['storm', 'thunderstorm'];
    return ['cloudy', 'cloud'];
  };
  function weatherHint(w) {
    const f = w.flags || {};
    if (f.rain) return ['umbrella', t('hintRain')];
    if (f.hot && dayMoment() !== 'night')
      return ['device_thermostat', t('hintHot')];
    if (f.golden)
      return ['wb_twilight', t('hintSunset', { t: hhmm(w.today.sunset) })];
    if (f.cold) return ['ac_unit', t('hintCold')];
    return ['directions_walk', t('hintNice')];
  }
  const hhmm = (localIso) => (localIso ? localIso.slice(11, 16) : '');
  function weatherCard() {
    const w = state.weather;
    if (!w?.current) return '';
    const [cond, ic] = WX(w.current.code, w.current.isDay);
    const [hic, hint] = weatherHint(w);
    const next = (w.hours || []).slice(1, 6);
    return `<section class="cg-weather">
      <div class="cg-wx-main">
        ${icon(ic, 'cg-wx-ico')}
        <div class="cg-wx-temp">${Math.round(w.current.temp)}°</div>
        <div class="cg-wx-txt"><b>${esc(t('wx_' + cond))}</b><span>${esc(t('weatherNow', { city: HOTEL.city || '' }))} · ${Math.round(w.today.min)}° / ${Math.round(w.today.max)}°</span></div>
      </div>
      <div class="cg-wx-hours">${next
        .map(
          (h) =>
            `<div><span>${esc(hhmm(h.time))}</span>${icon(WX(h.code, true)[1])}<b>${Math.round(h.temp)}°</b>${h.pop >= 30 ? `<small>${h.pop}%</small>` : ''}</div>`,
        )
        .join('')}
        ${w.today.sunset ? `<div class="sun"><span>${esc(t('sunset'))}</span>${icon('wb_twilight')}<b>${esc(hhmm(w.today.sunset))}</b></div>` : ''}
      </div>
      <div class="cg-wx-hint">${icon(hic)} ${esc(hint)}</div>
    </section>`;
  }
  /** Rank places for "now": time of day, then weather (rain → indoors, sunset → viewpoints). */
  function suggestScore(p, moment) {
    let s = p.priority + (p.best.includes(moment) ? 4 : -2);
    const f = state.weather?.flags;
    if (f) {
      if (f.rain) s += p.indoor ? 7 : -5;
      if (f.hot && (moment === 'afternoon' || moment === 'morning'))
        s += p.indoor ? 4 : -2;
      if (f.cold) s += p.indoor ? 2 : 0;
      if (f.golden && !f.rain)
        s += p.cat === 'viewpoint' ? 7 : p.cat === 'walk' ? 3 : 0;
    }
    return s;
  }
  async function refreshWeather() {
    try {
      state.weather = await fetchWeather();
      if (state.view.name === 'home' && !panel.contains(document.activeElement))
        render();
    } catch {}
  }

  function renderHome() {
    const moment = dayMoment();
    const suggested = [...POIS]
      .map((p) => [p, suggestScore(p, moment)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([p]) => p);
    const nearby = [...POIS]
      .sort((a, b) => distanceFromHotelM(a) - distanceFromHotelM(b))
      .slice(0, 4);
    const openNow = HOTEL_SERVICES.filter((s) => isOpenNow(s) === true).slice(
      0,
      4,
    );
    const cats = Object.entries(POI_CATEGORIES).filter(([k]) =>
      POIS.some((p) => p.cat === k),
    );
    return `
      <div class="cg-hero"><h1>${esc(t('welcome'))}</h1><p>${esc(t('tagline'))}</p></div>
      ${weatherCard()}
      ${searchBox()}
      ${state.quickCats.length ? `<div class="cg-quick">${quickSearch(6)}</div>` : ''}
      <h2 class="cg-sec">${esc(t('suggestions'))} <span class="cg-moment">· ${esc(t(moment))}</span></h2>
      <div class="cg-row">${suggested.map((p) => poiCard(p)).join('')}</div>
      <h2 class="cg-sec">${esc(t('hotel'))} ${openNow.length ? `<span class="cg-moment">· ${esc(t('openNow'))}</span>` : ''}</h2>
      <div class="cg-chips">
        ${openNow.map((s) => `<button class="cg-chip" data-action="open-service" data-id="${esc(s.id)}">${icon(s.icon)} ${esc(L(s.name))}</button>`).join('')}
        <button class="cg-chip accent" data-action="open-hotel">${icon('room_service')} ${esc(t('all'))}</button>
      </div>
      <h2 class="cg-sec">${esc(t('explore'))}</h2>
      <div class="cg-chips">
        <button class="cg-chip accent" data-action="filter-cat" data-cat="all">${icon('apps')} ${esc(t('allPlaces'))} <span class="cg-count">${POIS.length}</span></button>
        ${cats.map(([k, c]) => `<button class="cg-chip" data-action="filter-cat" data-cat="${esc(k)}">${icon(c.icon)} ${esc(L(c.label))}</button>`).join('')}
      </div>
      <h2 class="cg-sec">${esc(t('nearHotel'))}</h2>
      <div class="cg-list">${nearby.map((p) => poiCard(p, { wide: true })).join('')}</div>
      <div class="cg-foot">${esc(L(HOTEL.reception))} · <a href="${telHref(HOTEL.phone)}">${esc(HOTEL.phone)}</a></div>
    `;
  }

  function renderCatalog(v) {
    const moment = dayMoment();
    const cats = Object.entries(POI_CATEGORIES).filter(([k]) =>
      POIS.some((p) => p.cat === k),
    );
    let list = POIS.filter(
      (p) =>
        (v.cat === 'all' || p.cat === v.cat) &&
        (!v.now || p.best?.includes(moment)) &&
        (!v.indoor || p.indoor),
    );
    list =
      v.sort === 'dist'
        ? list.sort((a, b) => distanceFromHotelM(a) - distanceFromHotelM(b))
        : list
            .map((p) => [p, suggestScore(p, moment)])
            .sort((a, b) => b[1] - a[1])
            .map(([p]) => p);
    const chip = (cat, label, ic) =>
      `<button class="cg-chip ${v.cat === cat ? 'on' : ''}" data-action="catalog-cat" data-cat="${esc(cat)}" aria-pressed="${v.cat === cat}">${icon(ic)} ${esc(label)}</button>`;
    const toggle = (key, label, ic) =>
      `<button class="cg-chip toggle ${v[key] ? 'on' : ''}" data-action="catalog-toggle" data-key="${key}" aria-pressed="${!!v[key]}">${icon(ic)} ${esc(label)}</button>`;
    const filtered = v.cat !== 'all' || v.now || v.indoor;
    const title =
      v.cat === 'all'
        ? t('allPlaces')
        : L(POI_CATEGORIES[v.cat]?.label) || t('allPlaces');
    return `${header(title, t('nPlaces', { n: list.length }))}
      <div class="cg-filters" role="group" aria-label="${esc(t('category'))}">
        ${chip('all', t('all'), 'apps')}${cats.map(([k, c]) => chip(k, L(c.label), c.icon)).join('')}
      </div>
      <div class="cg-filters" role="group" aria-label="${esc(t('filters'))}">
        ${toggle('now', t('filterNow'), 'schedule')}${toggle('indoor', t('filterIndoor'), 'roofing')}
        <span class="cg-seg" role="group" aria-label="${esc(t('sortReco'))} / ${esc(t('sortDist'))}">
          <button class="${v.sort !== 'dist' ? 'on' : ''}" data-action="catalog-sort" data-sort="reco" aria-pressed="${v.sort !== 'dist'}">${esc(t('sortReco'))}</button><button class="${v.sort === 'dist' ? 'on' : ''}" data-action="catalog-sort" data-sort="dist" aria-pressed="${v.sort === 'dist'}">${esc(t('sortDist'))}</button>
        </span>
      </div>
      ${
        list.length
          ? `<div class="cg-list" aria-live="polite">${list.map((p) => poiCard(p, { wide: true, badges: true })).join('')}</div>`
          : `<div class="cg-empty">${icon('travel_explore')}<p>${esc(t('noMatches'))}</p>${filtered ? `<button class="cg-btn ghost" data-action="catalog-clear">${esc(t('clearFilters'))}</button>` : ''}</div>`
      }`;
  }

  /** Card for an OpenStreetMap result (pharmacy, bar, shop…). */
  function placeCard(r) {
    const meta = [
      r.cuisine,
      r.address,
      formatDistance(r.distanceM ?? distanceFromHotelM(r), t),
    ].filter(Boolean);
    return `<button class="cg-card wide" data-action="open-place" data-id="${esc(r.id)}">
        <div class="cg-card-icon">${icon(r.icon || 'place')}</div>
        <div class="cg-card-body"><div class="cg-card-title">${esc(r.name || t('unnamedPlace'))}</div>
        <div class="cg-card-meta">${esc(meta.join(' · '))}</div>
        ${r.hours ? `<div class="cg-card-hours">${icon('schedule')} ${esc(r.hours)}</div>` : ''}</div>
        ${icon('chevron_right', 'cg-chev')}
      </button>`;
  }

  function renderSearch(v) {
    let body;
    if (v.cat) {
      body = `<div class="cg-list">${POIS.filter((p) => p.cat === v.cat)
        .map((p) => poiCard(p, { wide: true }))
        .join('')}</div>`;
    } else if (state.searchResults === 'loading') {
      body = `<div class="cg-list" aria-busy="true"><div class="cg-skel"></div><div class="cg-skel"></div><div class="cg-skel"></div></div><p class="cg-muted">${esc(t('searching'))}</p>`;
    } else if (state.searchError && !state.searchResults?.length) {
      body = `<div class="cg-empty">${icon('cloud_off')}<p>${esc(t('searchOffline'))}</p><button class="cg-btn ghost" data-action="search-retry">${esc(t('retry'))}</button></div>`;
    } else if (!state.searchResults?.length) {
      body = v.q
        ? `<div class="cg-empty">${icon('search_off')}<p>${esc(t('noResultsNear'))}</p></div>`
        : quickSearch();
    } else {
      const cat = state.searchCategory;
      const n = state.searchResults.length;
      body = `${cat ? `<div class="cg-search-head">${icon(cat.icon)} <b>${esc(L(cat.label))}</b> <span class="cg-muted">· ${esc(t('nNearby', { n }))}</span></div>` : ''}
        <div class="cg-list" aria-live="polite">${state.searchResults
          .map((r) =>
            r.kind === 'poi' ? poiCard(r.poi, { wide: true }) : placeCard(r),
          )
          .join('')}</div>
        <p class="cg-src-note">${icon('public')} ${esc(t('osmNote'))}</p>`;
    }
    const title = v.cat ? L(POI_CATEGORIES[v.cat].label) : t('searchResults');
    return `${header(title)}${v.cat ? '' : searchBox(v.q || '')}<div data-role="results">${body}</div>`;
  }

  /** Quick chips: what guests ask most. */
  function quickSearch(limit = 8) {
    const cats = state.quickCats.slice(0, limit);
    if (!cats.length) return `<p class="cg-muted">${esc(t('tapPlace'))}</p>`;
    return `<div class="cg-chips">${cats
      .map(
        (c) =>
          `<button class="cg-chip" data-action="quick-search" data-q="${esc(L(c.label))}">${icon(c.icon)} ${esc(L(c.label))}</button>`,
      )
      .join('')}</div>`;
  }

  function placeOf(v) {
    if (v.poi) return { ...v.poi, title: L(v.poi.name) };
    return { ...v.place, title: v.place.name };
  }

  function actionButton(a, poi) {
    const label = esc(L(a.label));
    if (a.url && /^https?:\/\//i.test(a.url))
      return `<a class="cg-act" target="_blank" rel="noopener noreferrer" href="${esc(a.url)}">${icon(a.icon || 'open_in_new')}<span>${label}</span>${icon('open_in_new', 'cg-act-ext')}</a>`;
    if (a.request)
      return `<button class="cg-act" data-action="request" data-type="${esc(a.request)}" data-preset="${esc(a.request === 'tickets' ? `${t('ticketsVia')} ${L(poi.name)}` : L(poi.name))}">${icon(a.icon || 'support_agent')}<span>${label}</span></button>`;
    if (a.tel)
      return `<a class="cg-act" href="${telHref(HOTEL.phone)}">${icon(a.icon || 'call')}<span>${label}</span><small>${esc(HOTEL.phone)}</small></a>`;
    if (a.mode)
      return `<button class="cg-act" data-action="open-poi-mode" data-id="${esc(poi.id)}" data-mode="${esc(a.mode)}">${icon(a.icon || 'directions')}<span>${label}</span></button>`;
    return '';
  }

  function tasksChecklist(poi) {
    const tasks = L(poi.tasks) || [];
    return `<ul class="cg-tasks">${tasks
      .map((task, i) => {
        const key = `${poi.id}:${i}`;
        return `<li><label><input type="checkbox" data-role="task" data-key="${key}" ${state.done.has(key) ? 'checked' : ''}/><span>${esc(task)}</span></label></li>`;
      })
      .join('')}</ul>`;
  }

  function renderPlace(v) {
    const p = placeOf(v);
    const d = distanceFromHotelM(p);
    const modes = [
      ['walk', 'directions_walk', t('walk')],
      ['transit', 'directions_bus', t('transit')],
      ['bike', 'directions_bike', t('bike')],
    ];
    const inPlan = v.poi && state.plan.has(v.poi.id);
    return `
      ${header(p.title, v.poi ? L(v.poi.tag) : v.place.address || '', v.poi ? `<button class="cg-plan-btn ${inPlan ? 'on' : ''}" data-action="toggle-plan" data-id="${esc(v.poi.id)}" title="${esc(inPlan ? t('removeFromPlan') : t('addToPlan'))}" aria-label="${esc(inPlan ? t('removeFromPlan') : t('addToPlan'))}" aria-pressed="${inPlan}">${icon(inPlan ? 'bookmark' : 'bookmark_add')}</button>` : '')}
      ${v.poi?.photo ? `<img class="cg-hero-photo" src="${esc(v.poi.photo)}" alt="${esc(p.title)}" />` : ''}
      ${v.poi ? `<p class="cg-desc">${esc(L(v.poi.desc))}</p>` : ''}
      <div class="cg-facts">
        ${v.place?.hours ? `<span>${icon('schedule')} <b>${esc(v.place.hours)}</b></span>` : ''}
        ${v.place?.cuisine ? `<span>${icon('restaurant')} <b>${esc(v.place.cuisine)}</b></span>` : ''}
        ${v.place?.wheelchair ? `<span>${icon('accessible')} <b>${esc(t('accessible'))}</b></span>` : ''}
        ${v.poi?.indoor ? `<span>${icon('roofing')} <b>${esc(t('indoor'))}</b></span>` : ''}
        <span>${icon('hotel')} ${esc(t('fromHotel'))}: <b>${esc(formatDistance(d, t))}</b></span>
        ${v.poi ? `<span>${icon('schedule')} ${esc(t('visit'))}: <b>${esc(formatDuration(v.poi.minutes * 60, t))}</b></span>` : ''}
      </div>
      ${v.poi?.actions?.length ? `<div class="cg-acts">${v.poi.actions.map((a) => actionButton(a, v.poi)).join('')}</div>` : ''}
      ${
        v.place && (v.place.phone || v.place.website)
          ? `<div class="cg-acts">
        ${v.place.phone ? `<a class="cg-act" href="${telHref(v.place.phone)}">${icon('call')}<span>${esc(t('call'))}</span><small>${esc(v.place.phone)}</small></a>` : ''}
        ${/^https?:\/\//i.test(v.place.website || '') ? `<a class="cg-act" target="_blank" rel="noopener noreferrer" href="${esc(v.place.website)}">${icon('language')}<span>${esc(t('website'))}</span>${icon('open_in_new', 'cg-act-ext')}</a>` : ''}
      </div>`
          : ''
      }
      ${
        v.poi
          ? `<h3>${esc(t('thingsToDo'))}</h3>${tasksChecklist(v.poi)}
      <button class="cg-btn ${inPlan ? 'ghost' : ''}" data-action="toggle-plan" data-id="${v.poi.id}">${icon(inPlan ? 'bookmark_remove' : 'bookmark_add')} ${esc(inPlan ? t('removeFromPlan') : t('addToPlan'))}</button>`
          : ''
      }
      <h3>${esc(t('howToGetThere'))}</h3>
      <div class="cg-modes">${modes
        .map(
          ([m, ic, label]) =>
            `<button class="cg-mode ${state.routeMode === m ? 'on' : ''}" data-action="mode" data-mode="${m}">${icon(ic)} ${esc(label)}</button>`,
        )
        .join('')}</div>
      <div class="cg-route" data-role="route"><p class="cg-muted">${esc(t('loading'))}</p></div>
    `;
  }

  function renderHotel() {
    const groups = new Map();
    for (const s of HOTEL_SERVICES) {
      if (!groups.has(s.category)) groups.set(s.category, []);
      groups.get(s.category).push(s);
    }
    return `
      ${header(t('hotel'), HOTEL.address)}
      ${[...groups.values()]
        .map(
          (list) =>
            `<div class="cg-list">${list
              .map((s) => {
                const open = isOpenNow(s);
                return `<button class="cg-card wide" data-action="open-service" data-id="${esc(s.id)}">
                ${s.photo ? `<img class="cg-card-photo" src="${esc(s.photo)}" alt="" loading="lazy" />` : `<div class="cg-card-icon">${icon(s.icon)}</div>`}
                <div class="cg-card-body"><div class="cg-card-title">${esc(L(s.name))}</div>
                <div class="cg-card-meta">${open === null ? esc(L(s.hours)) : `<span class="cg-dot ${open ? 'open' : 'closed'}"></span>${esc(open ? t('openNow') : t('closedNow'))} · ${esc(L(s.hours))}`}</div></div>
                ${icon('chevron_right', 'cg-chev')}
              </button>`;
              })
              .join('')}</div>`,
        )
        .join('')}
      <div class="cg-foot">${esc(L(HOTEL.wifi))}<br/>${esc(L(HOTEL.reception))}</div>
    `;
  }

  function renderService(v) {
    const s = v.service;
    const open = isOpenNow(s);
    return `
      ${header(L(s.name), open === null ? '' : open ? t('openNow') : t('closedNow'))}
      ${s.photo ? `<img class="cg-hero-photo" src="${esc(s.photo)}" alt="${esc(L(s.name))}" />` : `<div class="cg-service-icon">${icon(s.icon)}</div>`}
      <p class="cg-desc">${esc(L(s.desc))}</p>
      ${L(s.hours) ? `<div class="cg-facts"><span>${icon('schedule')} ${esc(t('hours'))}: <b>${esc(L(s.hours))}</b></span></div>` : ''}
      ${s.bookable ? `<a class="cg-btn" href="${telHref(HOTEL.phone)}">${icon('call')} ${esc(t('bookAtReception'))}</a>` : ''}
      <div class="cg-foot">${esc(L(HOTEL.reception))}</div>
    `;
  }

  // ---------- tasks panel ----------
  /** Re-rendering the side panel (polling, language…) must never wipe what the guest is typing. */
  function renderTasks() {
    const snap = [
      ...sidePanel.querySelectorAll(
        'form input[name], form textarea[name], form select[name]',
      ),
    ].map((el) => [el.closest('form')?.dataset.role, el.name, el.value]);
    const active =
      document.activeElement && sidePanel.contains(document.activeElement)
        ? [
            document.activeElement.closest('form')?.dataset.role,
            document.activeElement.name,
            document.activeElement.selectionStart,
          ]
        : null;
    renderTasksNow();
    for (const [role, name, value] of snap) {
      const el = sidePanel.querySelector(
        `form[data-role="${role}"] [name="${CSS.escape(name)}"]`,
      );
      if (el && value !== '' && el.value !== value) el.value = value;
    }
    if (active?.[1]) {
      const el = sidePanel.querySelector(
        `form[data-role="${active[0]}"] [name="${CSS.escape(active[1])}"]`,
      );
      if (el) {
        el.focus({ preventScroll: true });
        if (Number.isInteger(active[2]))
          try {
            el.setSelectionRange(active[2], active[2]);
          } catch {}
      }
    }
  }
  function renderTasksNow() {
    if (state.chat.open) return renderChat();
    const planPois = POIS.filter((p) => state.plan.has(p.id));
    const suggestions = POIS.filter((p) => !state.plan.has(p.id))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 3);
    sidePanel.innerHTML = `
      <div class="cg-side-head"><h2>${esc(t('tasks'))}</h2><div class="cg-sub">${esc(HOTEL.name)}</div></div>
      ${state.requestForm ? renderRequestForm() : ''}
      <button class="cg-chatcard" data-action="chat-open">
        <span class="cg-chatcard-ico">${icon('forum')}${state.chat.unread ? `<i class="cg-badge">${state.chat.unread}</i>` : ''}</span>
        <span class="cg-chatcard-body"><b>${esc(t('chatTitle'))}</b><small>${esc(lastChatPreview() || t('chatHint'))}</small></span>
        ${icon('chevron_right', 'cg-chev')}
      </button>
      <h3>${esc(t('quickActions'))}</h3>
      <div class="cg-grid">
        ${HOTEL_ACTIONS.map((a) =>
          a.fields?.length
            ? `<button class="cg-tile" data-action="request" data-type="${esc(a.key)}">${icon(a.icon)}<span>${esc(L(a.name))}</span>${L(a.sub) ? `<small>${esc(L(a.sub))}</small>` : ''}</button>`
            : `<a class="cg-tile" href="${telHref(a.tel || HOTEL.phone)}">${icon(a.icon)}<span>${esc(L(a.name))}</span><small>${esc(a.tel || HOTEL.phone)}</small></a>`,
        ).join('')}
      </div>
      ${renderMyRequests()}
      <h3>${esc(t('myPlan'))}</h3>
      ${
        planPois.length
          ? planPois
              .map((p) => {
                const tasks = L(p.tasks) || [];
                const done = tasks.filter((_, i) =>
                  state.done.has(`${p.id}:${i}`),
                ).length;
                return `<section class="cg-plan-item">
                <div class="cg-plan-top">
                  <button class="cg-plan-title" data-action="open-poi" data-id="${esc(p.id)}">${icon(POI_CATEGORIES[p.cat]?.icon || 'place')}<b>${esc(L(p.name))}</b></button>
                  <span class="cg-muted">${esc(t('doneCount', { d: done, n: tasks.length }))}</span>
                  <button class="cg-x" data-action="toggle-plan" data-id="${esc(p.id)}" title="${esc(t('removeFromPlan'))}" aria-label="${esc(t('removeFromPlan'))}: ${esc(L(p.name))}">${icon('close')}</button>
                </div>
                ${p.actions?.length ? `<div class="cg-acts">${p.actions.map((a) => actionButton(a, p)).join('')}</div>` : ''}
                ${tasksChecklist(p)}
                <button class="cg-linkbtn" data-action="open-poi-mode" data-id="${p.id}" data-mode="${state.routeMode}">${icon('directions')} ${esc(t('howToGetThere'))}</button>
              </section>`;
              })
              .join('')
          : `<p class="cg-muted">${esc(t('planEmpty'))}</p>`
      }
      <h3>${esc(t('suggestedForPlan'))}</h3>
      <div class="cg-list">${suggestions
        .map(
          (p) => `<div class="cg-card wide static">
            <div class="cg-card-icon">${icon(POI_CATEGORIES[p.cat]?.icon || 'place')}</div>
            <div class="cg-card-body"><div class="cg-card-title">${esc(L(p.name))}</div><div class="cg-card-meta">${esc(L(p.tag))}</div></div>
            <button class="cg-mini" data-action="toggle-plan" data-id="${esc(p.id)}" aria-label="${esc(t('addToPlan'))}: ${esc(L(p.name))}" title="${esc(t('addToPlan'))}">${icon('add')}</button>
          </div>`,
        )
        .join('')}</div>
    `;
  }

  // ---------- guest requests ----------
  const FIELD_ICON = {
    when: 'schedule',
    people: 'group',
    destination: 'place',
    details: 'notes',
  };
  function renderRequestForm() {
    const f = state.requestForm;
    const action = HOTEL_ACTIONS.find((a) => a.key === f.type);
    const fields =
      f.fields ||
      (action?.fields?.length ? action.fields : ['when', 'details']);
    const g = state.guest || {};
    return `<form class="cg-form" data-role="request-form">
      <div class="cg-form-head">${icon(action?.icon || 'support_agent')}<b>${esc(f.title)}</b>
        <button type="button" class="cg-x" data-action="request-cancel" aria-label="${esc(t('cancel'))}">${icon('close')}</button></div>
      ${f.preset ? `<div class="cg-form-preset">${esc(f.preset)}</div>` : ''}
      <div class="cg-form-row">
        <label>${icon('door_front')}<input name="room" inputmode="numeric" required aria-label="${esc(t('room'))}" placeholder="${esc(t('room'))}" value="${esc(g.room || '')}" /></label>
        <label>${icon('person')}<input name="name" aria-label="${esc(t('yourName'))}" placeholder="${esc(t('yourName'))} (${esc(t('optional'))})" value="${esc(g.name || '')}" /></label>
      </div>
      ${fields
        .map((k) =>
          k === 'details'
            ? `<label class="cg-form-full">${icon('notes')}<textarea name="details" rows="2" aria-label="${esc(t('details'))}" placeholder="${esc(t('details'))} (${esc(t('optional'))})"></textarea></label>`
            : k === 'when'
              ? `<label>${icon('schedule')}<input name="when" type="datetime-local" aria-label="${esc(t('when'))}" /></label>`
              : k === 'people'
                ? `<label>${icon('group')}<input name="people" type="number" min="1" max="20" aria-label="${esc(t('people'))}" placeholder="${esc(t('people'))}" /></label>`
                : `<label class="cg-form-full">${icon(FIELD_ICON[k] || 'edit')}<input name="${esc(k)}" aria-label="${esc(t(k))}" placeholder="${esc(t(k))}" /></label>`,
        )
        .join('')}
      <div class="cg-form-msg" data-role="form-msg"></div>
      <button class="cg-btn" type="submit">${icon('send')} ${esc(t('send'))}</button>
    </form>`;
  }

  const STATUS_ICON = {
    pending: 'hourglass_top',
    confirmed: 'check_circle',
    done: 'task_alt',
    rejected: 'cancel',
  };
  function renderMyRequests() {
    if (!state.requests.length) return '';
    return `<h3>${esc(t('myRequests'))}</h3>
      <div class="cg-list">${state.requests
        .slice(0, 8)
        .map((r) => {
          const action = HOTEL_ACTIONS.find((a) => a.key === r.type);
          const title = action ? L(action.name) : r.details || r.type;
          const st = r.status || 'pending';
          return `<div class="cg-req ${st}">
            <div class="cg-card-icon">${icon(action?.icon || 'confirmation_number')}</div>
            <div class="cg-card-body"><div class="cg-card-title">${esc(title)}</div>
              <div class="cg-card-meta">${esc(t('room'))} ${esc(r.room)}${r.when ? ` · ${esc(fmtWhen(r.when))}` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</div></div>
            <div class="cg-req-side"><span class="cg-status ${st}">${icon(STATUS_ICON[st])} ${esc(t('status' + st[0].toUpperCase() + st.slice(1)))}</span>
              <button class="cg-linkbtn sm" data-action="chat-open" data-request="${esc(r.id)}">${icon('chat')} ${esc(t('write'))}</button></div>
          </div>`;
        })
        .join('')}</div>`;
  }
  function fmtWhen(v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? v
      : d.toLocaleString(getLang(), {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
  }
  function openRequest(type, { preset = '', fields } = {}) {
    const action = HOTEL_ACTIONS.find((a) => a.key === type);
    state.chat.open = false;
    state.requestForm = {
      type,
      title: action ? L(action.name) : preset || type,
      preset,
      fields: fields || (action ? null : ['when', 'people', 'details']),
    };
    setTab('tasks');
    renderTasks();
    sidePanel.scrollTop = 0;
    sidePanel.querySelector('[name="room"]')?.focus();
  }
  async function pollRequests() {
    if (document.hidden) return; // no polling in background tabs
    const ids = state.requests.map((r) => r.id);
    if (!ids.length) return;
    try {
      const fresh = await fetchRequests(ids);
      let changed = false;
      for (const f of fresh) {
        const mine = state.requests.find((r) => r.id === f.id);
        if (mine && (mine.status !== f.status || mine.note !== f.note)) {
          Object.assign(mine, f);
          changed = true;
        }
      }
      if (changed) {
        saveList('concierge.requests', state.requests);
        renderTasks();
      }
    } catch {}
  }
  state.requestsTick = setInterval(pollRequests, 20000);
  pollRequests();

  // ---------- chat with reception ----------
  const requestTitle = (id) => {
    const r = state.requests.find((x) => x.id === id);
    if (!r) return '';
    const a = HOTEL_ACTIONS.find((x) => x.key === r.type);
    return a ? L(a.name) : r.details || r.type;
  };
  function lastChatPreview() {
    const m = [...state.chat.messages]
      .reverse()
      .find((x) => x.author !== 'system');
    return m
      ? `${m.author === 'guest' ? t('you') : t('reception')}: ${m.body}`
      : '';
  }
  function chatBubble(m) {
    const time = new Date(m.at.replace(' ', 'T') + 'Z').toLocaleTimeString(
      getLang(),
      { hour: '2-digit', minute: '2-digit' },
    );
    if (m.author === 'system') {
      const label =
        m.body === 'created'
          ? t('sysCreated')
          : t('sysStatus_' + m.body.split(':')[1]);
      const title = requestTitle(m.requestId);
      return `<div class="cg-msg sys">${icon(m.body === 'created' ? 'send' : 'info')} ${esc(label)}${title ? ` · <b>${esc(title)}</b>` : ''} <span>${esc(time)}</span></div>`;
    }
    const mine = m.author === 'guest';
    return `<div class="cg-msg ${mine ? 'me' : 'them'}">
      ${!mine ? `<div class="cg-msg-who">${esc(m.staffName || t('reception'))}</div>` : ''}
      ${m.requestId && requestTitle(m.requestId) ? `<div class="cg-msg-ref">${icon('reply')} ${esc(requestTitle(m.requestId))}</div>` : ''}
      <div class="cg-msg-body">${esc(m.body)}</div><div class="cg-msg-time">${esc(time)}</div></div>`;
  }
  function renderChat() {
    const c = state.chat;
    sidePanel.innerHTML = `
      <div class="cg-head"><button class="cg-back" data-action="chat-close" aria-label="${esc(t('back'))}">${icon('arrow_back')}</button>
        <div class="cg-head-text"><h2>${esc(t('chatTitle'))}</h2><div class="cg-sub">${esc(HOTEL.name)}</div></div></div>
      <div class="cg-chat" data-role="chat-list">${c.messages.length ? c.messages.map(chatBubble).join('') : `<p class="cg-muted">${esc(t('chatEmpty'))}</p>`}</div>
      <form class="cg-chat-form" data-role="chat-form">
        ${c.requestId && requestTitle(c.requestId) ? `<div class="cg-chat-ctx">${icon('reply')} ${esc(t('about'))} <b>${esc(requestTitle(c.requestId))}</b><button type="button" class="cg-x" data-action="chat-ctx-clear" aria-label="${esc(t('cancel'))}">${icon('close')}</button></div>` : ''}
        <div class="cg-chat-row"><textarea name="body" rows="1" maxlength="1000" placeholder="${esc(t('chatPlaceholder'))}"></textarea>
        <button class="cg-send" type="submit" aria-label="${esc(t('send'))}">${icon('send')}</button></div>
      </form>`;
    const list = sidePanel.querySelector('[data-role="chat-list"]');
    list.scrollTop = list.scrollHeight;
  }
  function appendMessages(msgs) {
    const c = state.chat;
    const known = new Set(c.messages.map((m) => m.id));
    const fresh = msgs.filter((m) => !known.has(m.id));
    if (!fresh.length) return [];
    c.messages.push(...fresh);
    c.lastId = Math.max(c.lastId, ...fresh.map((m) => m.id));
    return fresh;
  }
  async function pollChat() {
    const c = state.chat;
    try {
      const visible =
        c.open &&
        (state.tab === 'tasks' ||
          window.matchMedia('(min-width: 900px)').matches);
      const { messages, unread } = await fetchChat(c.lastId, visible);
      const fresh = appendMessages(messages);
      const incoming = fresh.filter((m) => m.author !== 'guest');
      const unreadChanged = c.unread !== (visible ? 0 : unread);
      c.unread = visible ? 0 : unread;
      if (
        incoming.length &&
        !visible &&
        c.lastId &&
        incoming.some(
          (m) => m.author === 'staff' || m.body.startsWith('status:'),
        )
      ) {
        showToast(t('chatReply'));
        if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(120);
      }
      if (fresh.length || (!visible && unreadChanged)) {
        if (c.open) {
          const list = sidePanel.querySelector('[data-role="chat-list"]');
          const input = sidePanel.querySelector(
            '[data-role="chat-form"] textarea',
          );
          if (list && input) {
            const draft = input.value;
            const focused = document.activeElement === input;
            renderChat();
            const ni = sidePanel.querySelector(
              '[data-role="chat-form"] textarea',
            );
            ni.value = draft;
            if (focused) ni.focus();
          } else renderChat();
        } else renderTasks();
      }
      updateTabBadge();
    } catch {}
  }
  function updateTabBadge() {
    const btn = tabs.querySelector('[data-tab="tasks"]');
    let b = btn.querySelector('.cg-badge');
    if (state.chat.unread) {
      if (!b) btn.insertAdjacentHTML('beforeend', '<i class="cg-badge"></i>');
      btn.querySelector('.cg-badge').textContent = state.chat.unread;
    } else b?.remove();
  }
  function showToast(text) {
    const banner = document.createElement('div');
    banner.className = 'cg-toast';
    banner.setAttribute('role', 'status');
    banner.textContent = text;
    root.appendChild(banner);
    setTimeout(() => banner.remove(), 4000);
  }
  let chatTimer = null;
  function scheduleChat() {
    clearTimeout(chatTimer);
    chatTimer = setTimeout(
      async () => {
        await pollChat();
        scheduleChat();
      },
      document.hidden ? 60000 : state.chat.open ? 4000 : 15000,
    );
  }
  function openChat(requestId = null) {
    state.chat.open = true;
    state.chat.requestId = requestId;
    state.requestForm = null;
    setTab('tasks');
    renderChat();
    track('chat_open');
    pollChat();
    scheduleChat();
    sidePanel.querySelector('[data-role="chat-form"] textarea')?.focus();
  }
  pollChat().then(scheduleChat);

  // ---------- routing ----------
  async function loadRoute(v) {
    state.abort?.abort();
    const controller = new AbortController();
    state.abort = controller;
    const p = placeOf(v);
    const box = panel.querySelector('[data-role="route"]');
    const mode = state.routeMode;
    const quiet = state.quietRoute;
    state.quietRoute = false;
    state.noFly = quiet;
    if (!quiet) track('route', mode);
    const key = `${mode}|${p.lat},${p.lon}|${getLang()}`;
    try {
      let result = state.routeCache.get(key);
      if (!result) {
        result =
          mode === 'transit'
            ? await fetchTransit(HOTEL, p, getLang(), {
                signal: controller.signal,
                destName: p.title,
              })
            : await fetchRoute(mode === 'bike' ? 'bike' : 'foot', HOTEL, p, {
                signal: controller.signal,
              });
        state.routeCache.set(key, result);
      }
      if (controller.signal.aborted) return;
      if (mode === 'transit') renderTransit(box, result, p);
      else renderSimpleRoute(box, result, mode, p);
    } catch (error) {
      if (controller.signal.aborted) return;
      box.innerHTML = `<p class="cg-muted">${esc(t('routeError'))}</p>`;
      globe.clearRoute();
      globe.flyToBounds([HOTEL, p]);
    }
  }

  function renderSimpleRoute(box, r, mode, p) {
    clearInterval(state.tick);
    globe.removeMarkers('stop');
    const steps = Array.isArray(r.steps) ? r.steps : [];
    box.innerHTML = `
      <div class="cg-tl-head">
        <div class="cg-tl-big">${esc(formatDuration(r.durationS, t))}</div>
        <div class="cg-tl-times">${icon(mode === 'bike' ? 'directions_bike' : 'directions_walk')} ${esc(formatDistance(r.distanceM, t))}</div>
      </div>
      <button class="cg-btn" data-action="guide">${icon('navigation')} ${esc(t('guide'))}</button>
      ${
        steps.length
          ? `<ol class="cg-steps">${steps
              .slice(0, 40)
              .map(
                (s, i) =>
                  `<li data-action="guide-step" data-i="${i}">${esc(s.instruction || s.name || '')}${s.distanceM ? ` <span class="cg-muted">${esc(formatDistance(s.distanceM, t))}</span>` : ''}</li>`,
              )
              .join('')}</ol>`
          : ''
      }`;
    const geom = Array.isArray(r.geometry) ? r.geometry : [];
    const pts = [
      ...steps.map((s) => ({
        lat: s.lat,
        lon: s.lon,
        text: s.instruction || s.name || '',
      })),
      { lat: p.lat, lon: p.lon, text: t('arrived') },
    ];
    box._guide = pts.map((pt, i) => ({
      ...pt,
      kind: 'walk',
      seg: pts[i + 1] ? sliceRoute(geom, pt, pts[i + 1]) : [],
    }));
    globe.drawRoute([
      {
        coords: geom,
        mode: 'WALK',
        color: mode === 'bike' ? '#7CFC9A' : '#4cc3ff',
      },
    ]);
    if (!state.noFly) globe.flyToRoute(geom, [HOTEL, p]);
  }

  function renderTransit(box, data, p) {
    clearInterval(state.tick);
    if (data?.configured === false) {
      box.innerHTML = `<p class="cg-muted">${esc(t('transitNeedsKey'))}</p>`;
      globe.clearRoute();
      globe.flyToBounds([HOTEL, p]);
      return;
    }
    const routes = (data?.routes ?? []).slice(0, 4);
    if (!routes.length && data?.walkBetter) {
      box.innerHTML = `<div class="cg-walkbetter">${icon('directions_walk')}<div><b>${esc(t('walkBetter'))}</b><span>${esc(t('walkBetterSub', { n: Math.round(data.walkS / 60) }))}</span></div>
        <button class="cg-mode on" data-action="mode" data-mode="walk">${esc(t('walk'))}</button></div>`;
      globe.clearRoute();
      globe.flyToBounds([HOTEL, p]);
      return;
    }
    if (!routes.length) {
      box.innerHTML = `<p class="cg-muted">${esc(t('noTransit'))}</p>`;
      globe.clearRoute();
      globe.flyToBounds([HOTEL, p]);
      return;
    }
    box._routes = routes;
    box._sel = 0;
    const paint = () => {
      const lang = getLang();
      const sel = box._sel;
      const r = routes[sel];
      box.innerHTML = `
        <div class="cg-alts-row">${routes
          .map((alt, i) => {
            const lines = alt.legs.filter((l) => l.mode === 'TRANSIT');
            return `<button class="cg-altpill ${i === sel ? 'on' : ''}" data-action="alt" data-i="${i}">
              <div class="cg-altpill-lines">${lines.length ? lines.map((l) => lineBadge(l.transit, true)).join('') : icon('directions_walk')}</div>
              <div class="cg-altpill-dur">${esc(formatDuration(alt.durationS, t))}</div>
              <div class="cg-altpill-dep">${esc(countdown(alt.departure))}</div>
            </button>`;
          })
          .join('')}</div>
        <div class="cg-tl-head">
          <div class="cg-tl-big">${esc(countdown(r.departure, true))}</div>
          <div class="cg-tl-times">${esc(formatTime(r.departure, lang))} → ${esc(formatTime(r.arrival, lang))} · <b>${esc(formatDuration(r.durationS, t))}</b></div>
        </div>
        ${r.leaveAt ? `<div class="cg-leave">${icon('door_open')} ${esc(t('leaveHotelAt', { t: formatTime(r.leaveAt, lang) }))}${data.walkS ? ` <span>· ${esc(t('orWalk', { n: Math.round(data.walkS / 60) }))}</span>` : ''}</div>` : ''}
        <button class="cg-btn" data-action="guide">${icon('navigation')} ${esc(t('guide'))}</button>
        ${data.source === 'gtfs' ? `<div class="cg-src"><span class="cg-seal official" title="${esc(t('officialHint'))}">${sealSvg()}${esc(t('badgeOfficial'))}</span><span>${esc(t('officialTimes'))}</span></div>` : ''}
        <ol class="cg-tl">
          <li class="cg-tl-item hotel"><span class="cg-tl-dot"></span><div><b>${esc(HOTEL.name)}</b></div></li>
          ${r.legs
            .map((l, i) =>
              l.mode === 'TRANSIT'
                ? `<li class="cg-tl-item ride" data-action="guide-step" data-i="${i}" style="--line:${/^#[0-9a-f]{3,8}$/i.test(l.transit.color || '') ? l.transit.color : '#ff9f43'}">
                    <span class="cg-tl-dot"></span>
                    <div>
                      <div class="cg-tl-linerow">${lineBadge(l.transit)} <span class="cg-tl-head2">${esc(t('towards'))} ${esc(l.transit.headsign)}</span></div>
                      <div class="cg-tl-stop"><b>${esc(l.transit.from)}</b> <span class="cg-time">${esc(formatTime(l.transit.departure, lang))}</span></div>
                      <div class="cg-muted cg-tl-mid">${l.transit.stopCount} ${esc(t('stops'))} · ${esc(formatDuration(l.durationS, t))}${l.transit.agency ? ` · ${esc(l.transit.agency)}` : ''}</div>
                      <div class="cg-tl-stop"><b>${esc(l.transit.to)}</b> <span class="cg-time">${esc(formatTime(l.transit.arrival, lang))}</span></div>
                    </div>
                  </li>`
                : `<li class="cg-tl-item walk" data-action="guide-step" data-i="${i}"><span class="cg-tl-dot"></span>
                    <div>${icon('directions_walk')} ${esc(t('walk'))} <b>${esc(formatDuration(l.durationS, t))}</b> <span class="cg-muted">· ${esc(formatDistance(l.distanceM, t))}${l.instruction ? ` · ${esc(t('walkTo'))} ${esc(l.instruction)}` : ''}</span></div>
                  </li>`,
            )
            .join('')}
          <li class="cg-tl-item end"><span class="cg-tl-dot"></span><div><b>${esc(p.title)}</b><div class="cg-muted">${esc(formatTime(r.arrival, lang))}</div></div></li>
        </ol>`;
      box._guide = [
        ...r.legs.map((l) => {
          const start = l.polyline?.[0];
          const text =
            l.mode === 'TRANSIT'
              ? `${t('line')} ${l.transit.line} ${t('towards')} ${l.transit.headsign} · ${l.transit.from} → ${l.transit.to} (${formatTime(l.transit.departure, lang)})`
              : `${t('walk')} ${formatDuration(l.durationS, t)} · ${l.instruction || ''}`;
          return {
            lat: start ? start[1] : p.lat,
            lon: start ? start[0] : p.lon,
            text,
            kind: l.mode === 'TRANSIT' ? 'ride' : 'walk',
            seg: l.polyline || [],
          };
        }),
        { lat: p.lat, lon: p.lon, text: t('arrived'), kind: 'end', seg: [] },
      ];
    };
    box._paint = paint;
    paint();
    drawTransit(routes[0]);
    if (!state.noFly)
      globe.flyToRoute(
        routes[0].polyline || routes[0].legs.flatMap((l) => l.polyline || []),
        [HOTEL, p],
      );
    state.tick = setInterval(() => {
      if (!document.body.contains(box)) return clearInterval(state.tick);
      paint();
    }, 30000);
  }

  function lineBadge(tr, small = false) {
    const hex = (c, d) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : d);
    const bg = hex(tr.color, '#ff9f43');
    const fg = hex(tr.textColor, '#1a1408');
    return `<span class="cg-line ${small ? 'sm' : ''}" style="background:${esc(bg)};color:${esc(fg)}">${icon(VEHICLE_ICON[tr.vehicle] || 'directions_bus')} ${esc(tr.line)}</span>`;
  }

  function countdown(iso, long = false) {
    if (!iso) return '';
    const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (min <= 0) return t('now');
    if (min > 90)
      return long
        ? `${t('departsAt')} ${formatTime(iso, getLang())}`
        : formatTime(iso, getLang());
    return long ? t('departsIn', { n: min }) : `${min} ${t('minutes')}`;
  }

  function drawTransit(r) {
    globe.removeMarkers('stop');
    globe.drawRoute(
      r.legs.map((l) => ({
        coords: l.polyline,
        mode: l.mode,
        color: l.mode === 'TRANSIT' ? l.transit.color || '#ff9f43' : '#4cc3ff',
      })),
    );
    for (const l of r.legs) {
      if (l.mode !== 'TRANSIT') continue;
      for (const [loc, name] of [
        [l.transit.fromLoc, l.transit.from],
        [l.transit.toLoc, l.transit.to],
      ]) {
        if (loc)
          globe.addMarker({
            id: `stop:${name}`,
            lat: loc.lat,
            lon: loc.lon,
            label: name,
            kind: 'stop',
          });
      }
    }
  }

  // ---------- in-app step-by-step guide ----------
  function startGuide() {
    const box = panel.querySelector('[data-role="route"]');
    const steps = box?._guide;
    if (!steps?.length) return;
    state.guide = { steps, i: 0 };
    track('guide', state.routeMode);
    // Measure the ground under every step now so later steps don't wait for it.
    for (const s of steps) globe.groundHeight(s.lat, s.lon);
    guideBar.hidden = false;
    root.dataset.guide = 'on';
    setSheet('collapsed');
    showGuideStep(0);
  }
  function showGuideStep(i) {
    const g = state.guide;
    if (!g) return;
    g.i = Math.max(0, Math.min(g.steps.length - 1, i));
    const s = g.steps[g.i];
    const next = g.steps[g.i + 1];
    const heading = next ? bearing(s, next) : 0;
    const last = g.i === g.steps.length - 1;
    guideBar.innerHTML = `
      <div class="cg-guide-top"><span class="cg-guide-n">${esc(t('step'))} ${g.i + 1}/${g.steps.length}</span>
        <button class="cg-x" data-action="stop-guide" title="${esc(t('stopGuide'))}">${icon('close')}</button></div>
      <div class="cg-guide-text">${last ? icon('flag') : icon('navigation')} ${esc(s.text)}</div>
      <div class="cg-guide-nav">
        <button class="cg-mode" data-action="guide-prev" ${g.i === 0 ? 'disabled' : ''}>${icon('chevron_left')} ${esc(t('prev'))}</button>
        <button class="cg-mode on" data-action="guide-next" ${last ? 'disabled' : ''}>${esc(t('next'))} ${icon('chevron_right')}</button>
      </div>`;
    panel
      .querySelectorAll('[data-action="guide-step"]')
      .forEach((el) => el.classList.toggle('on', Number(el.dataset.i) === g.i));
    globe.showGuide(g.steps, g.i);
    // Debounce: fast taps on Next/Prev only fly to the step the user stops on.
    clearTimeout(state.guideTimer);
    state.guideTimer = setTimeout(() => moveGuideCamera(g, heading), 180);
  }
  function moveGuideCamera(g, fallbackHeading) {
    if (state.guide !== g) return;
    const s = g.steps[g.i];
    const seg = s.seg || [];
    const last = g.i === g.steps.length - 1;
    if (s.kind === 'ride' && seg.length > 1) {
      // A bus/metro leg can be kilometres long: frame the whole ride.
      globe.flyToRoute(seg);
      return;
    }
    // Stand behind the step, looking along the next stretch of the route.
    const heading =
      seg.length > 1
        ? headingAlong(seg)
        : last && g.i > 0
          ? bearing(g.steps[g.i - 1], s)
          : fallbackHeading;
    const len = pathLength(seg);
    const range = last ? 260 : Math.min(520, Math.max(170, len * 0.9));
    globe.lookAt({
      lat: s.lat,
      lon: s.lon,
      heading,
      pitch: last ? -48 : -32,
      range,
      duration: 1.1,
    });
  }
  function stopGuide() {
    if (!state.guide) return;
    state.guide = null;
    clearTimeout(state.guideTimer);
    globe.clearGuide();
    guideBar.hidden = true;
    delete root.dataset.guide;
    panel
      .querySelectorAll('[data-action="guide-step"].on')
      .forEach((el) => el.classList.remove('on'));
  }
  const distM = (a, b) => {
    const R = 6371000,
      toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR,
      dLon = (b.lon - a.lon) * toR;
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const ll = ([lon, lat]) => ({ lat, lon });
  function pathLength(coords) {
    let d = 0;
    for (let i = 1; i < coords.length; i++)
      d += distM(ll(coords[i - 1]), ll(coords[i]));
    return d;
  }
  /** Direction of travel over the first ~40 m of a stretch (robust to curvy streets). */
  function headingAlong(coords) {
    const a = ll(coords[0]);
    let b = ll(coords[coords.length - 1]);
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      acc += distM(ll(coords[i - 1]), ll(coords[i]));
      if (acc >= 40) {
        b = ll(coords[i]);
        break;
      }
    }
    return distM(a, b) < 1 ? 0 : bearing(a, b);
  }
  /** The part of the route geometry between two steps. */
  function sliceRoute(geom, from, to) {
    if (!geom.length) return [];
    const nearest = (pt, startAt = 0) => {
      let best = startAt,
        bd = Infinity;
      for (let i = startAt; i < geom.length; i++) {
        const d = distM(pt, ll(geom[i]));
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const i0 = nearest(from);
    const i1 = nearest(to, i0);
    return geom.slice(i0, Math.max(i0 + 2, i1 + 1));
  }
  function bearing(a, b) {
    const φ1 = (a.lat * Math.PI) / 180,
      φ2 = (b.lat * Math.PI) / 180;
    const Δλ = ((b.lon - a.lon) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
      Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  // ---------- events ----------
  root.addEventListener('click', (e) => {
    const langBtn = e.target.closest('[data-lang]');
    if (langBtn) {
      setLang(langBtn.dataset.lang);
      root.querySelectorAll('[data-lang]').forEach((b) => {
        b.classList.toggle('on', b === langBtn);
        b.setAttribute('aria-pressed', String(b === langBtn));
      });
      for (const p of POIS) {
        const ent = globe.viewer.entities.getById(`marker:${p.id}`);
        if (ent) ent.label.text = L(p.name);
      }
      state.routeCache.clear();
      state.quietRoute = true;
      render();
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) return setTab(tab.dataset.tab);
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    const id = el.dataset.id;
    if (a === 'back') back();
    // Keyboard activation of the sheet handle (pointer taps are handled by the drag code).
    else if (a === 'sheet-cycle') {
      if (e.detail === 0)
        setSheet(SNAPS[(SNAPS.indexOf(state.sheet) + 1) % SNAPS.length]);
    } else if (a === 'home-view')
      globe.flyTo({ lat: HOTEL.lat, lon: HOTEL.lon, ...HOTEL.welcomeView });
    else if (a === 'open-poi') openPoi(id);
    else if (a === 'open-poi-mode') {
      state.routeMode = el.dataset.mode || 'walk';
      openPoi(id);
    } else if (a === 'open-place') {
      const r = state.searchResults?.find?.((x) => x.id === id);
      if (r) openPlace(r);
    } else if (a === 'open-hotel') go({ name: 'hotel' });
    else if (a === 'open-service') {
      const s = HOTEL_SERVICES.find((x) => x.id === id);
      if (s) {
        track('service', L(s.name, 'es'));
        go({ name: 'service', service: s });
      }
    } else if (a === 'quick-search' || a === 'search-retry') {
      const q = a === 'search-retry' ? state.view.q : el.dataset.q;
      if (state.view.name !== 'search' || state.view.cat)
        go({ name: 'search', q });
      else state.view.q = q;
      render();
      const input = panel.querySelector('[data-role="search"]');
      if (input) {
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (a === 'filter-cat')
      go({ name: 'catalog', cat: el.dataset.cat || 'all', sort: 'reco' });
    else if (a === 'catalog-cat' && state.view.name === 'catalog') {
      state.view.cat = el.dataset.cat;
      render();
      panel
        .querySelector(
          `[data-action="catalog-cat"][data-cat="${CSS.escape(el.dataset.cat)}"]`,
        )
        ?.focus();
    } else if (a === 'catalog-toggle' && state.view.name === 'catalog') {
      state.view[el.dataset.key] = !state.view[el.dataset.key];
      render();
      panel
        .querySelector(
          `[data-action="catalog-toggle"][data-key="${el.dataset.key}"]`,
        )
        ?.focus();
    } else if (a === 'catalog-sort' && state.view.name === 'catalog') {
      state.view.sort = el.dataset.sort;
      render();
      panel
        .querySelector(
          `[data-action="catalog-sort"][data-sort="${el.dataset.sort}"]`,
        )
        ?.focus();
    } else if (a === 'catalog-clear' && state.view.name === 'catalog') {
      Object.assign(state.view, { cat: 'all', now: false, indoor: false });
      render();
    } else if (a === 'mode') {
      state.routeMode = el.dataset.mode;
      stopGuide();
      render();
    } else if (a === 'alt') {
      const box = panel.querySelector('[data-role="route"]');
      const i = Number(el.dataset.i);
      if (box?._routes?.[i]) {
        box._sel = i;
        box._paint();
        drawTransit(box._routes[i]);
      }
    } else if (a === 'toggle-plan') {
      if (state.plan.has(id)) state.plan.delete(id);
      else state.plan.add(id);
      saveSet('concierge.plan', state.plan);
      state.quietRoute = true;
      const scroll = panel.scrollTop;
      render();
      panel.scrollTop = scroll;
      panel
        .querySelector(
          `[data-action="toggle-plan"][data-id="${CSS.escape(id)}"]`,
        )
        ?.focus({ preventScroll: true });
    } else if (a === 'chat-open') openChat(el.dataset.request || null);
    else if (a === 'chat-close') {
      state.chat.open = false;
      renderTasks();
      scheduleChat();
    } else if (a === 'chat-ctx-clear') {
      state.chat.requestId = null;
      renderChat();
    } else if (a === 'request') {
      track('action', el.dataset.type);
      openRequest(el.dataset.type, { preset: el.dataset.preset || '' });
    } else if (a === 'request-cancel') {
      state.requestForm = null;
      renderTasks();
    } else if (a === 'guide') startGuide();
    else if (a === 'guide-step') {
      if (!state.guide) startGuide();
      showGuideStep(Number(el.dataset.i));
    } else if (a === 'guide-next') showGuideStep((state.guide?.i ?? 0) + 1);
    else if (a === 'guide-prev') showGuideStep((state.guide?.i ?? 0) - 1);
    else if (a === 'stop-guide') {
      stopGuide();
      setSheet('half');
    }
  });

  root.addEventListener('submit', async (e) => {
    const chatForm = e.target.closest('[data-role="chat-form"]');
    if (chatForm) {
      e.preventDefault();
      const ta = chatForm.querySelector('textarea');
      const body = ta.value.trim();
      if (!body || state.chat.sending) return;
      state.chat.sending = true;
      try {
        const msgs = await sendChat({
          body,
          room: state.guest?.room || '',
          name: state.guest?.name || '',
          lang: getLang(),
          requestId: state.chat.requestId,
        });
        ta.value = '';
        appendMessages(msgs);
        state.chat.requestId = null;
        renderChat();
        sidePanel.querySelector('[data-role="chat-form"] textarea')?.focus();
      } catch (error) {
        showToast(failText(error));
      } finally {
        state.chat.sending = false;
      }
      return;
    }
    const form = e.target.closest('[data-role="request-form"]');
    if (!form) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const msg = form.querySelector('[data-role="form-msg"]');
    if (!data.room?.trim()) {
      msg.textContent = t('roomRequired');
      return;
    }
    const f = state.requestForm;
    const detailParts = [
      f.preset,
      data.destination && `${t('destination')}: ${data.destination}`,
      data.people && `${t('people')}: ${data.people}`,
      data.details,
    ].filter(Boolean);
    form.querySelector('[type="submit"]').disabled = true;
    msg.textContent = t('sending');
    try {
      const saved = await submitRequest({
        type: f.type,
        room: data.room,
        name: data.name,
        when: data.when,
        details: detailParts.join(' · '),
        lang: getLang(),
      });
      state.guest = { room: data.room.trim(), name: (data.name || '').trim() };
      saveObj('concierge.guest', state.guest);
      state.requests.unshift(saved);
      saveList('concierge.requests', state.requests);
      setTimeout(pollChat, 300);
      state.requestForm = null;
      renderTasks();
      const banner = document.createElement('div');
      banner.className = 'cg-toast';
      banner.setAttribute('role', 'status');
      banner.textContent = t('requestSent');
      root.appendChild(banner);
      setTimeout(() => banner.remove(), 4000);
    } catch (error) {
      msg.textContent = failText(error);
      form.querySelector('[type="submit"]').disabled = false;
    }
  });

  root.addEventListener('keydown', (e) => {
    const ta = e.target.closest('[data-role="chat-form"] textarea');
    if (ta && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ta.form.requestSubmit();
    }
  });

  root.addEventListener('input', (e) => {
    const input = e.target.closest('[data-role="search"]');
    if (input) {
      const q = input.value;
      clearTimeout(state.searchTimer);
      if (state.view.name !== 'search' || state.view.cat)
        go({ name: 'search', q }, { push: state.view.name !== 'search' });
      else state.view.q = q;
      if (!q.trim()) {
        state.searchResults = null;
        renderResultsOnly();
        return;
      }
      state.searchTimer = setTimeout(async () => {
        state.searchResults = 'loading';
        renderResultsOnly();
        let results = [];
        try {
          const data = await searchPlaces(q);
          results = data.results;
          state.searchCategory = data.category;
          state.searchError = data.error || null;
        } catch (e) {
          if (e?.name === 'AbortError') return;
          state.searchError = 'offline';
        }
        if (state.view.q !== q) return;
        if (q.trim().length >= 3) track('search', q.trim().toLowerCase());
        state.searchResults = results;
        globe.removeMarkers('result');
        for (const r of results) {
          if (r.kind === 'place')
            globe.addMarker({
              id: r.id,
              lat: r.lat,
              lon: r.lon,
              label: r.name,
              kind: 'result',
            });
        }
        renderResultsOnly();
      }, 350);
      return;
    }
    const task = e.target.closest('[data-role="task"]');
    if (task) {
      if (task.checked) state.done.add(task.dataset.key);
      else state.done.delete(task.dataset.key);
      saveSet('concierge.done', state.done);
      // Mirror the same checkbox in the other panel without re-rendering the input in use.
      root
        .querySelectorAll(`[data-role="task"][data-key="${task.dataset.key}"]`)
        .forEach((c) => {
          if (c !== task) c.checked = task.checked;
        });
    }
  });

  function renderResultsOnly() {
    const input = panel.querySelector('[data-role="search"]');
    if (!input) return render();
    const tmp = document.createElement('div');
    tmp.innerHTML = renderSearch(state.view);
    const fresh = tmp.querySelector('[data-role="results"]');
    const old = panel.querySelector('[data-role="results"]');
    if (fresh && old) old.replaceWith(fresh);
    else render();
  }

  function openPoi(id) {
    const poi = POIS.find((p) => p.id === id);
    if (!poi) return;
    track('view_poi', poi.id);
    globe.setSelected(id);
    setTab('explore');
    setSheet('half');
    go({ name: 'place', poi });
  }
  function openPlace(r) {
    globe.setSelected(r.id);
    setTab('explore');
    setSheet('half');
    go({ name: 'place', place: r });
  }

  globe.onPick = (id) => {
    if (id === 'hotel') go({ name: 'hotel' });
    else if (POIS.some((p) => p.id === id)) openPoi(id);
    else {
      const r = state.searchResults?.find?.((x) => x.id === id);
      if (r) openPlace(r);
    }
  };

  // ---------- draggable sheet (phones) ----------
  let drag = null;
  const grip = sheet.querySelector('.cg-grip');
  function sheetOffsetFor(mode) {
    const h = sheet.getBoundingClientRect().height;
    if (mode === 'full') return 0;
    if (mode === 'half') return h * 0.5;
    return h - 96;
  }
  function onDown(e) {
    if (window.matchMedia('(min-width: 900px)').matches) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { y0: e.clientY, base: sheetOffsetFor(state.sheet), moved: false };
    sheet.style.transition = 'none';
    grip.setPointerCapture?.(e.pointerId);
  }
  function onMove(e) {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 4) drag.moved = true;
    const h = sheet.getBoundingClientRect().height;
    const y = Math.max(0, Math.min(h - 96, drag.base + dy));
    sheet.style.transform = `translateY(${y}px)`;
  }
  function onUp(e) {
    if (!drag) return;
    const h = sheet.getBoundingClientRect().height;
    const y = Math.max(0, Math.min(h - 96, drag.base + (e.clientY - drag.y0)));
    const moved = drag.moved;
    drag = null;
    sheet.style.transition = '';
    if (!moved) {
      // Tap on the grip cycles the snap points.
      setSheet(SNAPS[(SNAPS.indexOf(state.sheet) + 1) % SNAPS.length]);
      return;
    }
    const target = SNAPS.map((m) => [m, Math.abs(sheetOffsetFor(m) - y)]).sort(
      (a, b) => a[1] - b[1],
    )[0][0];
    setSheet(target);
  }
  grip.addEventListener('pointerdown', onDown);
  grip.addEventListener('pointermove', onMove);
  grip.addEventListener('pointerup', onUp);
  grip.addEventListener('pointercancel', onUp);
  // Header of a view can also be dragged (large touch target).
  panel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cg-head-text, .cg-hero')) onDown(e);
  });
  panel.addEventListener('pointermove', onMove);
  panel.addEventListener('pointerup', onUp);
  panel.addEventListener('pointercancel', onUp);

  setTab('explore');
  render();
  fetchSearchCategories()
    .then((cats) => {
      state.quickCats = cats;
      if (state.view.name === 'home' && !panel.contains(document.activeElement))
        render();
    })
    .catch(() => {});
  refreshWeather();
  setInterval(() => !document.hidden && refreshWeather(), 15 * 60_000);
  // Back to the foreground: catch up at once instead of waiting for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollRequests();
    pollChat();
  });
  track('open', room ? 'qr' : 'web');
  return { go, back, render };
}

function loadSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch {
    return new Set();
  }
}
function saveSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {}
}

function loadList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, 30)));
  } catch {}
}
function loadObj(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function saveObj(key, obj) {
  try {
    localStorage.setItem(key, JSON.stringify(obj));
  } catch {}
}
