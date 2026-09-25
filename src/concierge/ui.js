/**
 * Guest interface: a panel (bottom sheet on phones, side panel on kiosks)
 * over the 3D map. Views: home, search, place, hotel, service.
 */
import { HOTEL, HOTEL_SERVICES } from './data/hotel.js';
import { POIS, POI_CATEGORIES } from './data/pois.js';
import { LANGS, LANG_LABELS, getLang, setLang, t, L } from './i18n.js';
import {
  searchPlaces,
  fetchRoute,
  fetchTransit,
  distanceFromHotelM,
  dayMoment,
  isOpenNow,
  formatDistance,
  formatDuration,
  formatTime,
} from './services.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = '') => `<span class="msym ${cls}" aria-hidden="true">${name}</span>`;

const VEHICLE_ICON = { BUS: 'directions_bus', SUBWAY: 'subway', TRAM: 'tram', LIGHT_RAIL: 'tram', RAIL: 'train', HEAVY_RAIL: 'train', METRO_RAIL: 'subway' };

export function createUi({ root, globe }) {
  const state = {
    view: { name: 'home' },
    stack: [],
    sheet: 'half', // collapsed | half | full
    routeMode: 'walk',
    routeCache: new Map(),
    abort: null,
    searchTimer: null,
    searchResults: null,
    tick: null,
    done: loadDone(),
  };

  root.innerHTML = `
    <header class="cg-top">
      <div class="cg-brand">
        <span class="cg-logo">${icon('hotel')}</span>
        <div><div class="cg-hotel">${esc(HOTEL.name)}</div><div class="cg-city">Granada</div></div>
      </div>
      <div class="cg-langs" role="group" aria-label="Language">
        ${LANGS.map((l) => `<button data-lang="${l}" class="${l === getLang() ? 'on' : ''}">${LANG_LABELS[l]}</button>`).join('')}
      </div>
    </header>
    <div class="cg-map-actions">
      <button class="cg-fab" data-action="home-view" title="${esc(HOTEL.name)}">${icon('hotel')}</button>
    </div>
    <section class="cg-sheet" data-sheet="half">
      <button class="cg-handle" data-action="toggle-sheet" aria-label="Expand"></button>
      <div class="cg-panel"></div>
    </section>
  `;
  const sheet = root.querySelector('.cg-sheet');
  const panel = root.querySelector('.cg-panel');

  // Hotel + curated markers.
  globe.addMarker({ id: 'hotel', lat: HOTEL.lat, lon: HOTEL.lon, label: HOTEL.name, kind: 'hotel' });
  for (const p of POIS) globe.addMarker({ id: p.id, lat: p.lat, lon: p.lon, label: L(p.name), kind: 'poi' });

  // ---------- navigation ----------
  function go(view, { push = true } = {}) {
    if (push) state.stack.push(state.view);
    state.view = view;
    render();
  }
  function back() {
    state.view = state.stack.pop() || { name: 'home' };
    if (state.view.name === 'home') {
      globe.clearRoute();
      globe.setSelected(null);
      globe.removeMarkers('result');
      globe.removeMarkers('stop');
    }
    render();
  }
  function setSheet(mode) {
    state.sheet = mode;
    sheet.dataset.sheet = mode;
  }

  // ---------- rendering ----------
  function render() {
    const v = state.view;
    let html = '';
    if (v.name === 'home') html = renderHome();
    else if (v.name === 'search') html = renderSearch(v);
    else if (v.name === 'place') html = renderPlace(v);
    else if (v.name === 'hotel') html = renderHotel();
    else if (v.name === 'service') html = renderService(v);
    panel.innerHTML = html;
    panel.scrollTop = 0;
    if (v.name === 'place') loadRoute(v);
  }

  function header(title, sub = '') {
    return `<div class="cg-head">
      <button class="cg-back" data-action="back" aria-label="${esc(t('back'))}">${icon('arrow_back')}</button>
      <div><h2>${esc(title)}</h2>${sub ? `<div class="cg-sub">${esc(sub)}</div>` : ''}</div>
    </div>`;
  }

  function searchBox(value = '') {
    return `<label class="cg-search">${icon('search')}
      <input type="search" data-role="search" placeholder="${esc(t('searchPlaceholder'))}" value="${esc(value)}" autocomplete="off" />
    </label>`;
  }

  function poiCard(p, { wide = false } = {}) {
    const cat = POI_CATEGORIES[p.cat];
    const d = distanceFromHotelM(p);
    return `<button class="cg-card ${wide ? 'wide' : ''}" data-action="open-poi" data-id="${p.id}">
      <div class="cg-card-icon">${icon(cat?.icon || 'place')}</div>
      <div class="cg-card-body">
        <div class="cg-card-title">${esc(L(p.name))}</div>
        <div class="cg-card-meta"><span class="cg-tag">${esc(L(p.tag))}</span> · ${esc(formatDistance(d, t))} · ${esc(formatDuration(p.minutes * 60, t))}</div>
      </div>
      ${icon('chevron_right', 'cg-chev')}
    </button>`;
  }

  function renderHome() {
    const moment = dayMoment();
    const suggested = POIS.filter((p) => p.best.includes(moment))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 5);
    const nearby = [...POIS].sort((a, b) => distanceFromHotelM(a) - distanceFromHotelM(b)).slice(0, 4);
    const openNow = HOTEL_SERVICES.filter((s) => isOpenNow(s) === true).slice(0, 4);
    const cats = Object.entries(POI_CATEGORIES).filter(([k]) => POIS.some((p) => p.cat === k));
    return `
      <div class="cg-hero"><h1>${esc(t('welcome'))}</h1><p>${esc(t('tagline'))}</p></div>
      ${searchBox()}
      <h3>${esc(t('suggestions'))} <span class="cg-moment">· ${esc(t(moment))}</span></h3>
      <div class="cg-row">${suggested.map((p) => poiCard(p)).join('')}</div>
      <h3>${esc(t('hotel'))} ${openNow.length ? `<span class="cg-moment">· ${esc(t('openNow'))}</span>` : ''}</h3>
      <div class="cg-chips">
        ${openNow.map((s) => `<button class="cg-chip" data-action="open-service" data-id="${s.id}">${icon(s.icon)} ${esc(L(s.name))}</button>`).join('')}
        <button class="cg-chip accent" data-action="open-hotel">${icon('room_service')} ${esc(t('all'))}</button>
      </div>
      <h3>${esc(t('explore'))}</h3>
      <div class="cg-chips">
        ${cats.map(([k, c]) => `<button class="cg-chip" data-action="filter-cat" data-cat="${k}">${icon(c.icon)} ${esc(L(c.label))}</button>`).join('')}
      </div>
      <h3>${esc(t('nearHotel'))}</h3>
      <div class="cg-list">${nearby.map((p) => poiCard(p, { wide: true })).join('')}</div>
      <div class="cg-foot">${esc(L(HOTEL.reception))} · <a href="tel:${esc(HOTEL.phone.replace(/\s/g, ''))}">${esc(HOTEL.phone)}</a></div>
    `;
  }

  function renderSearch(v) {
    let body;
    if (v.cat) {
      const list = POIS.filter((p) => p.cat === v.cat);
      body = `<div class="cg-list">${list.map((p) => poiCard(p, { wide: true })).join('')}</div>`;
    } else if (state.searchResults === 'loading') {
      body = `<p class="cg-muted">${esc(t('searching'))}</p>`;
    } else if (!state.searchResults?.length) {
      body = `<p class="cg-muted">${esc(v.q ? t('noResults') : t('tapPlace'))}</p>`;
    } else {
      body = `<div class="cg-list">${state.searchResults
        .map((r) =>
          r.kind === 'poi'
            ? poiCard(r.poi, { wide: true })
            : `<button class="cg-card wide" data-action="open-place" data-id="${esc(r.id)}">
                <div class="cg-card-icon">${icon('place')}</div>
                <div class="cg-card-body"><div class="cg-card-title">${esc(r.name)}</div>
                <div class="cg-card-meta">${esc(r.address || '')} · ${esc(formatDistance(distanceFromHotelM(r), t))}</div></div>
                ${icon('chevron_right', 'cg-chev')}
              </button>`,
        )
        .join('')}</div>`;
    }
    const title = v.cat ? L(POI_CATEGORIES[v.cat].label) : t('searchResults');
    return `${header(title)}${v.cat ? '' : searchBox(v.q || '')}${body}`;
  }

  function placeOf(v) {
    if (v.poi) return { ...v.poi, title: L(v.poi.name) };
    return { ...v.place, title: v.place.name };
  }

  function renderPlace(v) {
    const p = placeOf(v);
    const d = distanceFromHotelM(p);
    const modes = [
      ['walk', 'directions_walk', t('walk')],
      ['transit', 'directions_bus', t('transit')],
      ['bike', 'directions_bike', t('bike')],
    ];
    const tasks = v.poi ? L(v.poi.tasks) : [];
    return `
      ${header(p.title, v.poi ? L(v.poi.tag) : v.place.address || '')}
      ${v.poi ? `<p class="cg-desc">${esc(L(v.poi.desc))}</p>` : ''}
      <div class="cg-facts">
        <span>${icon('hotel')} ${esc(t('fromHotel'))}: <b>${esc(formatDistance(d, t))}</b></span>
        ${v.poi ? `<span>${icon('schedule')} ${esc(t('visit'))}: <b>${esc(formatDuration(v.poi.minutes * 60, t))}</b></span>` : ''}
      </div>
      ${tasks.length ? `<h3>${esc(t('thingsToDo'))}</h3>
      <ul class="cg-tasks">${tasks
        .map((task, i) => {
          const key = `${v.poi.id}:${i}`;
          return `<li><label><input type="checkbox" data-role="task" data-key="${key}" ${state.done.has(key) ? 'checked' : ''}/><span>${esc(task)}</span></label></li>`;
        })
        .join('')}</ul>` : ''}
      <h3>${esc(t('howToGetThere'))}</h3>
      <div class="cg-modes">${modes
        .map(([m, ic, label]) => `<button class="cg-mode ${state.routeMode === m ? 'on' : ''}" data-action="mode" data-mode="${m}">${icon(ic)} ${esc(label)}</button>`)
        .join('')}</div>
      <div class="cg-route" data-role="route"><p class="cg-muted">${esc(t('loading'))}</p></div>
      <a class="cg-btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${HOTEL.lat},${HOTEL.lon}&destination=${p.lat},${p.lon}&travelmode=${state.routeMode === 'bike' ? 'bicycling' : state.routeMode === 'walk' ? 'walking' : 'transit'}">${icon('open_in_new')} ${esc(t('startNav'))}</a>
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
          (list) => `<div class="cg-list">${list
            .map((s) => {
              const open = isOpenNow(s);
              return `<button class="cg-card wide" data-action="open-service" data-id="${s.id}">
                <div class="cg-card-icon">${icon(s.icon)}</div>
                <div class="cg-card-body"><div class="cg-card-title">${esc(L(s.name))}</div>
                <div class="cg-card-meta">${open === null ? esc(L(s.hours)) : `<span class="cg-dot ${open ? 'open' : 'closed'}"></span>${esc(open ? t('openNow') : t('closedNow'))} · ${esc(L(s.hours))}`}</div></div>
                ${icon('chevron_right', 'cg-chev')}
              </button>`;
            })
            .join('')}</div>`,
        )
        .join('')}
      <div class="cg-foot">${esc(L(HOTEL.wifi.note))}<br/>${esc(L(HOTEL.reception))}</div>
    `;
  }

  function renderService(v) {
    const s = v.service;
    const open = isOpenNow(s);
    return `
      ${header(L(s.name), open === null ? '' : open ? t('openNow') : t('closedNow'))}
      <div class="cg-service-icon">${icon(s.icon)}</div>
      <p class="cg-desc">${esc(L(s.desc))}</p>
      ${L(s.hours) ? `<div class="cg-facts"><span>${icon('schedule')} ${esc(t('hours'))}: <b>${esc(L(s.hours))}</b></span></div>` : ''}
      ${s.bookable ? `<a class="cg-btn" href="tel:${esc(HOTEL.phone.replace(/\s/g, ''))}">${icon('call')} ${esc(t('bookAtReception'))}</a>` : ''}
      <div class="cg-foot">${esc(L(HOTEL.reception))}</div>
    `;
  }

  // ---------- routing ----------
  async function loadRoute(v) {
    state.abort?.abort();
    const controller = new AbortController();
    state.abort = controller;
    const p = placeOf(v);
    const box = panel.querySelector('[data-role="route"]');
    const mode = state.routeMode;
    const key = `${mode}|${p.lat},${p.lon}|${getLang()}`;
    try {
      let result = state.routeCache.get(key);
      if (!result) {
        result =
          mode === 'transit'
            ? await fetchTransit(HOTEL, p, getLang(), { signal: controller.signal })
            : await fetchRoute(mode === 'bike' ? 'bike' : 'foot', HOTEL, p, { signal: controller.signal });
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
    box.innerHTML = `
      <div class="cg-route-sum">${icon(mode === 'bike' ? 'directions_bike' : 'directions_walk')}
        <b>${esc(formatDuration(r.durationS, t))}</b> · ${esc(formatDistance(r.distanceM, t))}</div>
      ${Array.isArray(r.steps) && r.steps.length ? `<ol class="cg-steps">${r.steps
        .slice(0, 12)
        .map((s) => `<li>${esc(s.instruction || s.name || '')}${s.distanceM ? ` <span class="cg-muted">${esc(formatDistance(s.distanceM, t))}</span>` : ''}</li>`)
        .join('')}</ol>` : ''}`;
    globe.drawRoute([{ coords: r.geometry, mode: 'WALK', color: mode === 'bike' ? '#7CFC9A' : '#4cc3ff' }]);
    globe.flyToBounds([HOTEL, p]);
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
        <ol class="cg-tl">
          <li class="cg-tl-item hotel"><span class="cg-tl-dot"></span><div><b>${esc(HOTEL.name)}</b><div class="cg-muted">${esc(formatTime(r.legs[0]?.transit?.departure ? shiftIso(r.legs[0].transit.departure, -r.legs[0].durationS) : r.departure, lang))}</div></div></li>
          ${r.legs
            .map((l) =>
              l.mode === 'TRANSIT'
                ? `<li class="cg-tl-item ride" style="--line:${esc(l.transit.color || '#ff9f43')}">
                    <span class="cg-tl-dot"></span>
                    <div>
                      <div class="cg-tl-linerow">${lineBadge(l.transit)} <span class="cg-tl-head2">${esc(t('towards'))} ${esc(l.transit.headsign)}</span></div>
                      <div class="cg-tl-stop"><b>${esc(l.transit.from)}</b> <span class="cg-time">${esc(formatTime(l.transit.departure, lang))}</span></div>
                      <div class="cg-muted cg-tl-mid">${l.transit.stopCount} ${esc(t('stops'))} · ${esc(formatDuration(l.durationS, t))}${l.transit.agency ? ` · ${esc(l.transit.agency)}` : ''}</div>
                      <div class="cg-tl-stop"><b>${esc(l.transit.to)}</b> <span class="cg-time">${esc(formatTime(l.transit.arrival, lang))}</span></div>
                    </div>
                  </li>`
                : `<li class="cg-tl-item walk"><span class="cg-tl-dot"></span>
                    <div>${icon('directions_walk')} ${esc(t('walk'))} <b>${esc(formatDuration(l.durationS, t))}</b> <span class="cg-muted">· ${esc(formatDistance(l.distanceM, t))}</span></div>
                  </li>`,
            )
            .join('')}
          <li class="cg-tl-item end"><span class="cg-tl-dot"></span><div><b>${esc(p.title)}</b><div class="cg-muted">${esc(formatTime(r.arrival, lang))}</div></div></li>
        </ol>`;
    };
    box._paint = paint;
    paint();
    drawTransit(routes[0]);
    globe.flyToBounds([HOTEL, p]);
    state.tick = setInterval(() => {
      if (!document.body.contains(box)) return clearInterval(state.tick);
      paint();
    }, 30000);
  }

  function lineBadge(tr, small = false) {
    const bg = tr.color || '#ff9f43';
    const fg = tr.textColor || '#1a1408';
    return `<span class="cg-line ${small ? 'sm' : ''}" style="background:${esc(bg)};color:${esc(fg)}">${icon(VEHICLE_ICON[tr.vehicle] || 'directions_bus')} ${esc(tr.line)}</span>`;
  }

  function shiftIso(iso, deltaS) {
    try {
      return new Date(new Date(iso).getTime() + deltaS * 1000).toISOString();
    } catch {
      return iso;
    }
  }

  /** "Sale en 4 min" style countdown from an ISO departure time. */
  function countdown(iso, long = false) {
    if (!iso) return '';
    const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (min <= 0) return t('now');
    if (min > 90) return long ? `${t('departsAt')} ${formatTime(iso, getLang())}` : formatTime(iso, getLang());
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
      for (const [loc, name] of [[l.transit.fromLoc, l.transit.from], [l.transit.toLoc, l.transit.to]]) {
        if (loc) globe.addMarker({ id: `stop:${name}`, lat: loc.lat, lon: loc.lon, label: name, kind: 'stop' });
      }
    }
  }

  // ---------- events ----------
  root.addEventListener('click', (e) => {
    const langBtn = e.target.closest('[data-lang]');
    if (langBtn) {
      setLang(langBtn.dataset.lang);
      root.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('on', b === langBtn));
      for (const p of POIS) {
        const ent = globe.viewer.entities.getById(`marker:${p.id}`);
        if (ent) ent.label.text = L(p.name);
      }
      state.routeCache.clear();
      render();
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a === 'back') back();
    else if (a === 'toggle-sheet') setSheet(state.sheet === 'full' ? 'half' : state.sheet === 'half' ? 'collapsed' : 'half');
    else if (a === 'home-view') {
      globe.flyTo({ lat: HOTEL.lat, lon: HOTEL.lon, ...HOTEL.welcomeView });
    } else if (a === 'open-poi') openPoi(el.dataset.id);
    else if (a === 'open-place') {
      const r = state.searchResults?.find?.((x) => x.id === el.dataset.id);
      if (r) openPlace(r);
    } else if (a === 'open-hotel') go({ name: 'hotel' });
    else if (a === 'open-service') {
      const s = HOTEL_SERVICES.find((x) => x.id === el.dataset.id);
      if (s) go({ name: 'service', service: s });
    } else if (a === 'filter-cat') go({ name: 'search', cat: el.dataset.cat });
    else if (a === 'mode') {
      state.routeMode = el.dataset.mode;
      render();
    } else if (a === 'alt') {
      const box = panel.querySelector('[data-role="route"]');
      const i = Number(el.dataset.i);
      if (box?._routes?.[i]) {
        box._sel = i;
        box._paint();
        drawTransit(box._routes[i]);
      }
    }
  });

  root.addEventListener('input', (e) => {
    const input = e.target.closest('[data-role="search"]');
    if (input) {
      const q = input.value;
      clearTimeout(state.searchTimer);
      if (state.view.name !== 'search' || state.view.cat) go({ name: 'search', q }, { push: state.view.name !== 'search' });
      else state.view.q = q;
      if (!q.trim()) {
        state.searchResults = null;
        renderResultsOnly();
        return;
      }
      state.searchTimer = setTimeout(async () => {
        state.searchResults = 'loading';
        renderResultsOnly();
        const results = await searchPlaces(q);
        if (state.view.q !== q) return;
        state.searchResults = results;
        globe.removeMarkers('result');
        for (const r of results) {
          if (r.kind === 'place') globe.addMarker({ id: r.id, lat: r.lat, lon: r.lon, label: r.name, kind: 'result' });
        }
        renderResultsOnly();
      }, 350);
      return;
    }
    const task = e.target.closest('[data-role="task"]');
    if (task) {
      if (task.checked) state.done.add(task.dataset.key);
      else state.done.delete(task.dataset.key);
      saveDone(state.done);
    }
  });

  function renderResultsOnly() {
    // Keep the input focused: replace only the list under the search box.
    const input = panel.querySelector('[data-role="search"]');
    const html = renderSearch(state.view);
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const fresh = tmp.querySelector('.cg-list, .cg-muted');
    const old = panel.querySelector('.cg-list, .cg-muted');
    if (fresh && old) old.replaceWith(fresh);
    else if (!input) render();
  }

  function openPoi(id) {
    const poi = POIS.find((p) => p.id === id);
    if (!poi) return;
    globe.setSelected(id);
    setSheet('half');
    go({ name: 'place', poi });
  }
  function openPlace(r) {
    globe.setSelected(r.id);
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

  // Sheet drag (touch) — simple threshold gesture on the handle area.
  let dragY = null;
  sheet.addEventListener('touchstart', (e) => {
    if (e.target.closest('.cg-handle, .cg-head, .cg-hero')) dragY = e.touches[0].clientY;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (dragY === null) return;
    const dy = e.changedTouches[0].clientY - dragY;
    dragY = null;
    if (dy < -40) setSheet(state.sheet === 'collapsed' ? 'half' : 'full');
    else if (dy > 40) setSheet(state.sheet === 'full' ? 'half' : 'collapsed');
  }, { passive: true });

  render();
  return { go, back, render };
}

function loadDone() {
  try {
    return new Set(JSON.parse(localStorage.getItem('concierge.done') || '[]'));
  } catch {
    return new Set();
  }
}
function saveDone(set) {
  try {
    localStorage.setItem('concierge.done', JSON.stringify([...set]));
  } catch {}
}
