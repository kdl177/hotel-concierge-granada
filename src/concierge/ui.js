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
} from './services.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = '') => `<span class="msym ${cls}" aria-hidden="true">${name}</span>`;
const telHref = (n) => `tel:${String(n).replace(/\s/g, '')}`;

const VEHICLE_ICON = { BUS: 'directions_bus', SUBWAY: 'subway', TRAM: 'tram', LIGHT_RAIL: 'tram', RAIL: 'train', HEAVY_RAIL: 'train', METRO_RAIL: 'subway' };
const SNAPS = ['collapsed', 'half', 'full'];

export function createUi({ root, globe, config, room = null }) {
  const HOTEL = config.hotel;
  const HOTEL_SERVICES = config.services;
  const HOTEL_ACTIONS = config.actions;
  const POIS = config.pois;
  const LANGS_ON = HOTEL.langs?.length ? LANGS.filter((l) => HOTEL.langs.includes(l)) : LANGS;
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
    tick: null,
    guide: null, // { steps: [{lat,lon,text}], i }
    done: loadSet('concierge.done'),
    plan: loadSet('concierge.plan'),
    requestForm: null, // { type, title, fields, preset }
    requests: loadList('concierge.requests'), // [{id, type, status, ...}]
    requestsTick: null,
    guest: room ? { room: room.number, name: room.stay?.guestName || '' } : loadObj('concierge.guest'), // { room, name }
  };

  root.innerHTML = `
    <header class="cg-top">
      <div class="cg-brand">
        <span class="cg-logo">${icon('hotel')}</span>
        <div><div class="cg-hotel">${esc(HOTEL.name)}</div><div class="cg-city">${esc(HOTEL.city || '')}${room ? ` · ${esc(t('room'))} ${esc(room.number)}` : ''}</div></div>
      </div>
      <div class="cg-langs" role="group" aria-label="Language">
        ${LANGS_ON.map((l) => `<button data-lang="${l}" class="${l === getLang() ? 'on' : ''}">${LANG_LABELS[l]}</button>`).join('')}
      </div>
    </header>
    <div class="cg-map-actions">
      <button class="cg-fab" data-action="home-view" title="${esc(HOTEL.name)}">${icon('hotel')}</button>
    </div>
    <section class="cg-sheet" data-sheet="half">
      <div class="cg-grip"><span class="cg-handle"></span></div>
      <div class="cg-panel"></div>
    </section>
    <aside class="cg-side">
      <div class="cg-side-panel"></div>
    </aside>
    <nav class="cg-tabs">
      <button data-tab="explore" class="on">${icon('explore')}<span>${esc(t('explore'))}</span></button>
      <button data-tab="tasks">${icon('checklist')}<span>${esc(t('tasks'))}</span></button>
    </nav>
    <div class="cg-guide" hidden></div>
  `;
  const sheet = root.querySelector('.cg-sheet');
  const panel = root.querySelector('.cg-panel');
  const side = root.querySelector('.cg-side');
  const sidePanel = root.querySelector('.cg-side-panel');
  const tabs = root.querySelector('.cg-tabs');
  const guideBar = root.querySelector('.cg-guide');

  globe.addMarker({ id: 'hotel', lat: HOTEL.lat, lon: HOTEL.lon, label: HOTEL.name, kind: 'hotel' });
  for (const p of POIS) globe.addMarker({ id: p.id, lat: p.lat, lon: p.lon, label: L(p.name), kind: 'poi' });

  // ---------- navigation ----------
  function go(view, { push = true } = {}) {
    if (push) state.stack.push(state.view);
    state.view = view;
    stopGuide();
    render();
  }
  function back() {
    state.view = state.stack.pop() || { name: 'home' };
    stopGuide();
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
    sheet.style.transform = '';
  }
  function setTab(tab) {
    state.tab = tab;
    root.dataset.panel = tab;
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'tasks') renderTasks();
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
    renderTasks();
    tabs.querySelector('[data-tab="explore"] span').textContent = t('explore');
    tabs.querySelector('[data-tab="tasks"] span').textContent = t('tasks');
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

  function poiCard(p, { wide = false } = {}) {
    const cat = POI_CATEGORIES[p.cat] || { icon: 'place' };
    const d = distanceFromHotelM(p);
    return `<button class="cg-card ${wide ? 'wide' : ''}" data-action="open-poi" data-id="${p.id}">
      <div class="cg-card-icon">${icon(cat?.icon || 'place')}</div>
      <div class="cg-card-body">
        <div class="cg-card-title">${esc(L(p.name))}</div>
        <div class="cg-card-meta"><span class="cg-tag">${esc(L(p.tag))}</span> · ${esc(formatDistance(d, t))} · ${esc(formatDuration(p.minutes * 60, t))}</div>
      </div>
      ${state.plan.has(p.id) ? icon('bookmark', 'cg-plan-ico') : ''}${icon('chevron_right', 'cg-chev')}
    </button>`;
  }

  function renderHome() {
    const moment = dayMoment();
    const suggested = POIS.filter((p) => p.best.includes(moment)).sort((a, b) => b.priority - a.priority).slice(0, 5);
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
      <div class="cg-foot">${esc(L(HOTEL.reception))} · <a href="${telHref(HOTEL.phone)}">${esc(HOTEL.phone)}</a></div>
    `;
  }

  function renderSearch(v) {
    let body;
    if (v.cat) {
      body = `<div class="cg-list">${POIS.filter((p) => p.cat === v.cat).map((p) => poiCard(p, { wide: true })).join('')}</div>`;
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

  function actionButton(a, poi) {
    const label = esc(L(a.label));
    if (a.url) return `<a class="cg-act" target="_blank" rel="noopener" href="${esc(a.url)}">${icon(a.icon || 'open_in_new')}<span>${label}</span>${icon('open_in_new', 'cg-act-ext')}</a>`;
    if (a.request) return `<button class="cg-act" data-action="request" data-type="${esc(a.request)}" data-preset="${esc(a.request === 'tickets' ? `${t('ticketsVia')} ${L(poi.name)}` : L(poi.name))}">${icon(a.icon || 'support_agent')}<span>${label}</span></button>`;
    if (a.tel) return `<a class="cg-act" href="${telHref(HOTEL.phone)}">${icon(a.icon || 'call')}<span>${label}</span><small>${esc(HOTEL.phone)}</small></a>`;
    if (a.mode) return `<button class="cg-act" data-action="open-poi-mode" data-id="${poi.id}" data-mode="${a.mode}">${icon(a.icon || 'directions')}<span>${label}</span></button>`;
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
      ${header(p.title, v.poi ? L(v.poi.tag) : v.place.address || '', v.poi ? `<button class="cg-plan-btn ${inPlan ? 'on' : ''}" data-action="toggle-plan" data-id="${v.poi.id}" title="${esc(inPlan ? t('removeFromPlan') : t('addToPlan'))}">${icon(inPlan ? 'bookmark' : 'bookmark_add')}</button>` : '')}
      ${v.poi ? `<p class="cg-desc">${esc(L(v.poi.desc))}</p>` : ''}
      <div class="cg-facts">
        <span>${icon('hotel')} ${esc(t('fromHotel'))}: <b>${esc(formatDistance(d, t))}</b></span>
        ${v.poi ? `<span>${icon('schedule')} ${esc(t('visit'))}: <b>${esc(formatDuration(v.poi.minutes * 60, t))}</b></span>` : ''}
      </div>
      ${v.poi?.actions?.length ? `<div class="cg-acts">${v.poi.actions.map((a) => actionButton(a, v.poi)).join('')}</div>` : ''}
      ${v.poi ? `<h3>${esc(t('thingsToDo'))}</h3>${tasksChecklist(v.poi)}
      <button class="cg-btn ${inPlan ? 'ghost' : ''}" data-action="toggle-plan" data-id="${v.poi.id}">${icon(inPlan ? 'bookmark_remove' : 'bookmark_add')} ${esc(inPlan ? t('removeFromPlan') : t('addToPlan'))}</button>` : ''}
      <h3>${esc(t('howToGetThere'))}</h3>
      <div class="cg-modes">${modes
        .map(([m, ic, label]) => `<button class="cg-mode ${state.routeMode === m ? 'on' : ''}" data-action="mode" data-mode="${m}">${icon(ic)} ${esc(label)}</button>`)
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
      <div class="cg-foot">${esc(L(HOTEL.wifi))}<br/>${esc(L(HOTEL.reception))}</div>
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
      ${s.bookable ? `<a class="cg-btn" href="${telHref(HOTEL.phone)}">${icon('call')} ${esc(t('bookAtReception'))}</a>` : ''}
      <div class="cg-foot">${esc(L(HOTEL.reception))}</div>
    `;
  }

  // ---------- tasks panel ----------
  function renderTasks() {
    const planPois = POIS.filter((p) => state.plan.has(p.id));
    const suggestions = POIS.filter((p) => !state.plan.has(p.id)).sort((a, b) => b.priority - a.priority).slice(0, 3);
    sidePanel.innerHTML = `
      <div class="cg-side-head"><h2>${esc(t('tasks'))}</h2><div class="cg-sub">${esc(HOTEL.name)}</div></div>
      ${state.requestForm ? renderRequestForm() : ''}
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
      ${planPois.length
        ? planPois
            .map((p) => {
              const tasks = L(p.tasks) || [];
              const done = tasks.filter((_, i) => state.done.has(`${p.id}:${i}`)).length;
              return `<section class="cg-plan-item">
                <div class="cg-plan-top">
                  <button class="cg-plan-title" data-action="open-poi" data-id="${p.id}">${icon(POI_CATEGORIES[p.cat]?.icon || 'place')}<b>${esc(L(p.name))}</b></button>
                  <span class="cg-muted">${esc(t('doneCount', { d: done, n: tasks.length }))}</span>
                  <button class="cg-x" data-action="toggle-plan" data-id="${p.id}" title="${esc(t('removeFromPlan'))}">${icon('close')}</button>
                </div>
                ${p.actions?.length ? `<div class="cg-acts">${p.actions.map((a) => actionButton(a, p)).join('')}</div>` : ''}
                ${tasksChecklist(p)}
                <button class="cg-linkbtn" data-action="open-poi-mode" data-id="${p.id}" data-mode="${state.routeMode}">${icon('directions')} ${esc(t('howToGetThere'))}</button>
              </section>`;
            })
            .join('')
        : `<p class="cg-muted">${esc(t('planEmpty'))}</p>`}
      <h3>${esc(t('suggestedForPlan'))}</h3>
      <div class="cg-list">${suggestions
        .map(
          (p) => `<div class="cg-card wide static">
            <div class="cg-card-icon">${icon(POI_CATEGORIES[p.cat]?.icon || 'place')}</div>
            <div class="cg-card-body"><div class="cg-card-title">${esc(L(p.name))}</div><div class="cg-card-meta">${esc(L(p.tag))}</div></div>
            <button class="cg-mini" data-action="toggle-plan" data-id="${p.id}">${icon('add')}</button>
          </div>`,
        )
        .join('')}</div>
    `;
  }

  // ---------- guest requests ----------
  const FIELD_ICON = { when: 'schedule', people: 'group', destination: 'place', details: 'notes' };
  function renderRequestForm() {
    const f = state.requestForm;
    const action = HOTEL_ACTIONS.find((a) => a.key === f.type);
    const fields = f.fields || (action?.fields?.length ? action.fields : ['when', 'details']);
    const g = state.guest || {};
    return `<form class="cg-form" data-role="request-form">
      <div class="cg-form-head">${icon(action?.icon || 'support_agent')}<b>${esc(f.title)}</b>
        <button type="button" class="cg-x" data-action="request-cancel">${icon('close')}</button></div>
      ${f.preset ? `<div class="cg-form-preset">${esc(f.preset)}</div>` : ''}
      <div class="cg-form-row">
        <label>${icon('door_front')}<input name="room" inputmode="numeric" required placeholder="${esc(t('room'))}" value="${esc(g.room || '')}" /></label>
        <label>${icon('person')}<input name="name" placeholder="${esc(t('yourName'))} (${esc(t('optional'))})" value="${esc(g.name || '')}" /></label>
      </div>
      ${fields
        .map((k) =>
          k === 'details'
            ? `<label class="cg-form-full">${icon('notes')}<textarea name="details" rows="2" placeholder="${esc(t('details'))} (${esc(t('optional'))})"></textarea></label>`
            : k === 'when'
              ? `<label>${icon('schedule')}<input name="when" type="datetime-local" /></label>`
              : k === 'people'
                ? `<label>${icon('group')}<input name="people" type="number" min="1" max="20" placeholder="${esc(t('people'))}" /></label>`
                : `<label class="cg-form-full">${icon(FIELD_ICON[k] || 'edit')}<input name="${k}" placeholder="${esc(t(k))}" /></label>`,
        )
        .join('')}
      <div class="cg-form-msg" data-role="form-msg"></div>
      <button class="cg-btn" type="submit">${icon('send')} ${esc(t('send'))}</button>
    </form>`;
  }

  const STATUS_ICON = { pending: 'hourglass_top', confirmed: 'check_circle', done: 'task_alt', rejected: 'cancel' };
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
            <span class="cg-status ${st}">${icon(STATUS_ICON[st])} ${esc(t('status' + st[0].toUpperCase() + st.slice(1)))}</span>
          </div>`;
        })
        .join('')}</div>`;
  }
  function fmtWhen(v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleString(getLang(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function openRequest(type, { preset = '', fields } = {}) {
    const action = HOTEL_ACTIONS.find((a) => a.key === type);
    state.requestForm = { type, title: action ? L(action.name) : preset || type, preset, fields: fields || (action ? null : ['when', 'people', 'details']) };
    setTab('tasks');
    renderTasks();
    sidePanel.scrollTop = 0;
    sidePanel.querySelector('[name="room"]')?.focus();
  }
  async function pollRequests() {
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
    clearInterval(state.tick);
    globe.removeMarkers('stop');
    const steps = Array.isArray(r.steps) ? r.steps : [];
    box.innerHTML = `
      <div class="cg-tl-head">
        <div class="cg-tl-big">${esc(formatDuration(r.durationS, t))}</div>
        <div class="cg-tl-times">${icon(mode === 'bike' ? 'directions_bike' : 'directions_walk')} ${esc(formatDistance(r.distanceM, t))}</div>
      </div>
      <button class="cg-btn" data-action="guide">${icon('navigation')} ${esc(t('guide'))}</button>
      ${steps.length ? `<ol class="cg-steps">${steps
        .slice(0, 40)
        .map((s, i) => `<li data-action="guide-step" data-i="${i}">${esc(s.instruction || s.name || '')}${s.distanceM ? ` <span class="cg-muted">${esc(formatDistance(s.distanceM, t))}</span>` : ''}</li>`)
        .join('')}</ol>` : ''}`;
    box._guide = [
      ...steps.map((s) => ({ lat: s.lat, lon: s.lon, text: s.instruction || s.name || '' })),
      { lat: p.lat, lon: p.lon, text: t('arrived') },
    ];
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
        <button class="cg-btn" data-action="guide">${icon('navigation')} ${esc(t('guide'))}</button>
        <ol class="cg-tl">
          <li class="cg-tl-item hotel"><span class="cg-tl-dot"></span><div><b>${esc(HOTEL.name)}</b></div></li>
          ${r.legs
            .map((l, i) =>
              l.mode === 'TRANSIT'
                ? `<li class="cg-tl-item ride" data-action="guide-step" data-i="${i}" style="--line:${esc(l.transit.color || '#ff9f43')}">
                    <span class="cg-tl-dot"></span>
                    <div>
                      <div class="cg-tl-linerow">${lineBadge(l.transit)} <span class="cg-tl-head2">${esc(t('towards'))} ${esc(l.transit.headsign)}</span></div>
                      <div class="cg-tl-stop"><b>${esc(l.transit.from)}</b> <span class="cg-time">${esc(formatTime(l.transit.departure, lang))}</span></div>
                      <div class="cg-muted cg-tl-mid">${l.transit.stopCount} ${esc(t('stops'))} · ${esc(formatDuration(l.durationS, t))}${l.transit.agency ? ` · ${esc(l.transit.agency)}` : ''}</div>
                      <div class="cg-tl-stop"><b>${esc(l.transit.to)}</b> <span class="cg-time">${esc(formatTime(l.transit.arrival, lang))}</span></div>
                    </div>
                  </li>`
                : `<li class="cg-tl-item walk" data-action="guide-step" data-i="${i}"><span class="cg-tl-dot"></span>
                    <div>${icon('directions_walk')} ${esc(t('walk'))} <b>${esc(formatDuration(l.durationS, t))}</b> <span class="cg-muted">· ${esc(formatDistance(l.distanceM, t))}</span></div>
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
          return { lat: start ? start[1] : p.lat, lon: start ? start[0] : p.lon, text };
        }),
        { lat: p.lat, lon: p.lon, text: t('arrived') },
      ];
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
      r.legs.map((l) => ({ coords: l.polyline, mode: l.mode, color: l.mode === 'TRANSIT' ? l.transit.color || '#ff9f43' : '#4cc3ff' })),
    );
    for (const l of r.legs) {
      if (l.mode !== 'TRANSIT') continue;
      for (const [loc, name] of [[l.transit.fromLoc, l.transit.from], [l.transit.toLoc, l.transit.to]]) {
        if (loc) globe.addMarker({ id: `stop:${name}`, lat: loc.lat, lon: loc.lon, label: name, kind: 'stop' });
      }
    }
  }

  // ---------- in-app step-by-step guide ----------
  function startGuide() {
    const box = panel.querySelector('[data-role="route"]');
    const steps = box?._guide;
    if (!steps?.length) return;
    state.guide = { steps, i: 0 };
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
    panel.querySelectorAll('[data-action="guide-step"]').forEach((el) => el.classList.toggle('on', Number(el.dataset.i) === g.i));
    globe.flyTo({ lat: s.lat, lon: s.lon, height: last ? 260 : 160, heading, pitch: -42, duration: 1.2 });
  }
  function stopGuide() {
    if (!state.guide) return;
    state.guide = null;
    guideBar.hidden = true;
    delete root.dataset.guide;
    panel.querySelectorAll('[data-action="guide-step"].on').forEach((el) => el.classList.remove('on'));
  }
  function bearing(a, b) {
    const φ1 = (a.lat * Math.PI) / 180, φ2 = (b.lat * Math.PI) / 180;
    const Δλ = ((b.lon - a.lon) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
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
    const tab = e.target.closest('[data-tab]');
    if (tab) return setTab(tab.dataset.tab);
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    const id = el.dataset.id;
    if (a === 'back') back();
    else if (a === 'home-view') globe.flyTo({ lat: HOTEL.lat, lon: HOTEL.lon, ...HOTEL.welcomeView });
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
      if (s) go({ name: 'service', service: s });
    } else if (a === 'filter-cat') go({ name: 'search', cat: el.dataset.cat });
    else if (a === 'mode') {
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
      render();
    } else if (a === 'request') openRequest(el.dataset.type, { preset: el.dataset.preset || '' });
    else if (a === 'request-cancel') {
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
    const detailParts = [f.preset, data.destination && `${t('destination')}: ${data.destination}`, data.people && `${t('people')}: ${data.people}`, data.details].filter(Boolean);
    form.querySelector('[type="submit"]').disabled = true;
    msg.textContent = t('sending');
    try {
      const saved = await submitRequest({ type: f.type, room: data.room, name: data.name, when: data.when, details: detailParts.join(' · '), lang: getLang() });
      state.guest = { room: data.room.trim(), name: (data.name || '').trim() };
      saveObj('concierge.guest', state.guest);
      state.requests.unshift(saved);
      saveList('concierge.requests', state.requests);
      state.requestForm = null;
      renderTasks();
      const banner = document.createElement('div');
      banner.className = 'cg-toast';
      banner.textContent = t('requestSent');
      root.appendChild(banner);
      setTimeout(() => banner.remove(), 4000);
    } catch {
      msg.textContent = t('requestFailed');
      form.querySelector('[type="submit"]').disabled = false;
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
      saveSet('concierge.done', state.done);
      // Mirror the same checkbox in the other panel without re-rendering the input in use.
      root.querySelectorAll(`[data-role="task"][data-key="${task.dataset.key}"]`).forEach((c) => {
        if (c !== task) c.checked = task.checked;
      });
    }
  });

  function renderResultsOnly() {
    const input = panel.querySelector('[data-role="search"]');
    if (!input) return render();
    const tmp = document.createElement('div');
    tmp.innerHTML = renderSearch(state.view);
    const fresh = tmp.querySelector('.cg-list, .cg-muted');
    const old = panel.querySelector('.cg-list, .cg-muted');
    if (fresh && old) old.replaceWith(fresh);
  }

  function openPoi(id) {
    const poi = POIS.find((p) => p.id === id);
    if (!poi) return;
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
    const target = SNAPS.map((m) => [m, Math.abs(sheetOffsetFor(m) - y)]).sort((a, b) => a[1] - b[1])[0][0];
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
