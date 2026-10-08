/** Hotel admin panel: hotel data, services, quick actions, places, rooms (QR), users, hotels (superadmin). */
import { api, esc, icon, iconField, fmt, confirmDialog, errorText, requireLogin, accountButton, bindAccount, toast, modal, setHotelOverride, ROLE_LABEL, TYPE_LABEL } from './common.js';
import { renderStats } from './stats.js';

const LANGS = ['es', 'en', 'fr', 'de'];
const LANG_NAME = { es: 'Español', en: 'English', fr: 'Français', de: 'Deutsch' };
const CATS = ['monument', 'garden', 'viewpoint', 'neighbourhood', 'shopping', 'walk', 'square', 'family', 'nature'];
const SERVICE_CATS = ['food', 'wellness', 'family', 'leisure', 'business', 'practical'];
const FIELDS = ['when', 'people', 'destination', 'details'];
const MOMENTS = ['morning', 'afternoon', 'evening', 'night'];

const root = document.getElementById('app');
const state = { user: null, hotel: null, hotels: [], tab: 'hotel', items: [] };

const session = await requireLogin(root, 'Administración');
state.user = session.user;
state.hotel = session.hotel;
if (!['admin', 'superadmin'].includes(state.user.role)) {
  root.innerHTML = '<div class="login"><div class="login-card"><b>Sin permiso</b><p class="muted">Esta pantalla es solo para administradores.</p><a class="btn" href="/reception.html">Ir a recepción</a></div></div>';
  throw new Error('forbidden');
}
if (state.user.role === 'superadmin') {
  state.hotels = (await api('/super/hotels')).hotels;
  const saved = localStorage.getItem('bo.hotel');
  const pick = state.hotels.find((h) => h.id === saved) || state.hotels[0];
  if (pick) {
    setHotelOverride(pick.id);
    state.hotel = pick;
  }
}

const TABS = [
  ['hotel', 'hotel', 'Hotel'],
  ['services', 'room_service', 'Servicios'],
  ['actions', 'bolt', 'Acciones rápidas'],
  ['pois', 'place', 'Lugares'],
  ['rooms', 'qr_code', 'Habitaciones y QR'],
  ['users', 'group', 'Usuarios'],
  ['stats', 'monitoring', 'Estadísticas'],
  ...(state.user.role === 'superadmin' ? [['hotels', 'domain', 'Hoteles']] : []),
];

function shell() {
  root.innerHTML = `
    <header class="bar">
      <div class="brand">${icon('hotel')}<div><h1 class="brand-title">${esc(state.hotel?.name || 'Concierge')}</h1><div class="muted">Administración</div></div></div>
      ${state.hotels.length > 1 ? `<select data-hotel class="sel" aria-label="Hotel">${state.hotels.map((h) => `<option value="${h.id}" ${h.id === state.hotel?.id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select>` : ''}
      <nav class="tabs">${TABS.map(([k, ic, l]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${icon(ic)} ${l}</button>`).join('')}</nav>
      <div class="me"><a class="btn sm" href="/reception.html">${icon('inbox')} Recepción</a><a class="btn sm" target="_blank" rel="noopener" href="/?h=${encodeURIComponent(state.hotel?.slug || 'default')}">${icon('open_in_new')} App</a>${accountButton(state.user)}</div>
    </header>
    <main id="main"></main>`;
  root.querySelector('[data-hotel]')?.addEventListener('change', (e) => {
    setHotelOverride(e.target.value);
    localStorage.setItem('bo.hotel', e.target.value);
    state.hotel = state.hotels.find((h) => h.id === e.target.value);
    shell();
    load();
  });
  bindAccount(root, state.user);
  root.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      shell();
      load();
    }),
  );
}

const main = () => document.getElementById('main');

// ---------- field helpers ----------
const i18nInputs = (name, value = {}, { textarea = false, rows = 2 } = {}) =>
  `<div class="i18n">${LANGS.map((l) => `<label><span class="lang">${l.toUpperCase()}</span>${textarea ? `<textarea name="${name}.${l}" rows="${rows}">${esc(value?.[l] || '')}</textarea>` : `<input name="${name}.${l}" value="${esc(value?.[l] || '')}" />`}</label>`).join('')}</div>`;
const select = (name, options, value, labels = {}) => `<select name="${name}">${options.map((o) => `<option value="${o}" ${o === value ? 'selected' : ''}>${esc(labels[o] || o)}</option>`).join('')}</select>`;
const checks = (name, options, values = [], labels = {}) => `<div class="checks">${options.map((o) => `<label class="chk"><input type="checkbox" name="${name}.${o}" ${values.includes(o) ? 'checked' : ''}/> ${esc(labels[o] || o)}</label>`).join('')}</div>`;
/** Turn flat modal values ("name.es", "fields.when") back into objects/arrays. */
function unflatten(v) {
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const [a, b] = k.split('.');
    if (!b) out[a] = val;
    else if (typeof val === 'boolean') (out[a] ||= []).push(...(val ? [b] : []));
    else (out[a] ||= {})[b] = val;
  }
  return out;
}
const linesToArray = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);

/** Photo picker: URL field + upload button (resized in the browser) + preview. */
const photoField = (value = '') => `<div class="photo-field">
  <img data-preview src="${esc(value)}" ${value ? '' : 'hidden'} alt="" />
  <div class="photo-ctl"><input name="photo" value="${esc(value)}" placeholder="URL de la imagen, o súbela →" />
    <div class="row tight"><label class="btn sm">${icon('upload')} Subir foto<input type="file" accept="image/jpeg,image/png,image/webp" data-upload hidden /></label>
    <button type="button" class="btn sm no" data-clear-photo>${icon('delete')} Quitar</button><span class="muted" data-upload-msg></span></div></div></div>`;

function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('No se pudo leer la imagen'));
    img.src = URL.createObjectURL(file);
  });
}
document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-upload]');
  if (!input?.files?.[0]) return;
  const box = input.closest('.photo-field');
  const msg = box.querySelector('[data-upload-msg]');
  msg.textContent = 'Subiendo…';
  try {
    const { url } = await api('/admin/upload', { method: 'POST', body: { dataUrl: await resizeImage(input.files[0]) } });
    box.querySelector('[name="photo"]').value = url;
    const img = box.querySelector('[data-preview]');
    img.src = url;
    img.hidden = false;
    msg.textContent = 'Subida ✔';
  } catch (err) {
    msg.textContent = errorText(err);
  }
  input.value = '';
});
document.addEventListener('input', (e) => {
  const f = e.target.closest('.photo-field [name="photo"]');
  if (!f) return;
  const img = f.closest('.photo-field').querySelector('[data-preview]');
  img.src = f.value;
  img.hidden = !f.value;
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-clear-photo]');
  if (!b) return;
  const box = b.closest('.photo-field');
  box.querySelector('[name="photo"]').value = '';
  box.querySelector('[data-preview]').hidden = true;
});

// ---------- tabs ----------
let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  const m = main();
  m.innerHTML = '<div class="boot" aria-busy="true"><span class="spinner" aria-hidden="true"></span><span>Cargando…</span></div>';
  try {
    if (state.tab === 'hotel') return await renderHotel(m);
    if (state.tab === 'stats') return await renderStats(m, { hotel: state.hotel });
    if (state.tab === 'hotels') return await renderHotels(m);
    const tab = state.tab;
    const { items } = await api(`/admin/${tab}`);
    if (seq !== loadSeq || tab !== state.tab) return; // a newer tab was opened meanwhile
    state.items = items;
    if (state.tab === 'services') return renderServices(m);
    if (state.tab === 'actions') return renderActions(m);
    if (state.tab === 'pois') return renderPois(m);
    if (state.tab === 'rooms') return renderRooms(m);
    if (state.tab === 'users') return renderUsers(m);
  } catch (err) {
    if (err.status === 401 || err.status === 403 && /password change/.test(err.message)) return location.reload();
    m.innerHTML = `<div class="state-error" role="alert">${icon('cloud_off')}<div><b>No se pudo cargar esta sección</b><p class="muted">${esc(errorText(err))}</p></div><button class="btn" data-retry>${icon('refresh')} Reintentar</button></div>`;
    m.querySelector('[data-retry]').addEventListener('click', load);
  }
}

async function renderHotel(m) {
  const { hotel } = await api('/admin/hotel');
  m.innerHTML = `<form class="form-page" data-hotel-form>
    <h2>Datos del hotel</h2>
    <div class="row"><label>Nombre<input name="name" value="${esc(hotel.name)}" required /></label><label>Marca / grupo<input name="brand" value="${esc(hotel.brand)}" /></label></div>
    <div class="row"><label>Dirección<input name="address" value="${esc(hotel.address)}" /></label><label>Ciudad<input name="city" value="${esc(hotel.city)}" /></label></div>
    <div class="row"><label>Teléfono<input name="phone" value="${esc(hotel.phone)}" /></label><label>Email<input name="email" value="${esc(hotel.email)}" /></label><label>Teléfono de taxi<input name="taxiPhone" value="${esc(hotel.taxiPhone || '')}" /></label></div>
    <div class="row"><label>Latitud<input name="lat" type="number" step="0.000001" value="${hotel.lat}" /></label><label>Longitud<input name="lon" type="number" step="0.000001" value="${hotel.lon}" /></label>
      <label>Vista inicial (altura m / rumbo° / inclinación°)<div class="row tight"><input name="view.height" type="number" value="${hotel.welcomeView?.height ?? 900}" /><input name="view.heading" type="number" value="${hotel.welcomeView?.heading ?? 35}" /><input name="view.pitch" type="number" value="${hotel.welcomeView?.pitch ?? -38}" /></div></label></div>
    <h3>Idiomas de la app</h3>${checks('langs', LANGS, hotel.langs, LANG_NAME)}
    <h3>Texto de recepción (pie de la app)</h3>${i18nInputs('reception', hotel.reception)}
    <h3>Texto Wi-Fi</h3>${i18nInputs('wifi', hotel.wifi)}
    <h3>Foto del hotel</h3>${photoField(hotel.photo)}
    <h3>Notificaciones</h3>
    <div class="row"><label>Webhook (n8n, Make, Slack…) al crear/actualizar solicitudes<input name="webhookUrl" value="${esc(hotel.webhookUrl || '')}" placeholder="https://…" /></label><label>Email de aviso (requiere SMTP_URL en el servidor)<input name="notifyEmail" value="${esc(hotel.notifyEmail || '')}" /></label></div>
    <h3>Transporte público (horarios oficiales GTFS)</h3><div data-transit class="muted">Comprobando…</div>
    <div class="foot"><button class="btn primary">Guardar</button> <span class="muted">Slug de la app: <code>${esc(hotel.slug)}</code> → <a target="_blank" rel="noopener" href="/?h=${esc(hotel.slug)}">/?h=${esc(hotel.slug)}</a></span></div>
  </form>`;
  paintTransit(m.querySelector('[data-transit]'));
  m.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.target).entries());
    for (const el of e.target.elements) if (el.type === 'checkbox') raw[el.name] = el.checked;
    const v = unflatten(raw);
    try {
      await api('/admin/hotel', { method: 'PUT', body: { ...v, lat: num(v.lat), lon: num(v.lon), welcomeView: { height: num(v.view?.height, 900), heading: num(v.view?.heading, 35), pitch: num(v.view?.pitch, -38) } } });
      toast('Guardado');
    } catch (err) {
      toast(errorText(err), 'err');
    }
  });
}

async function paintTransit(box, reload = false) {
  try {
    const data = reload ? await api('/admin/transit/reload', { method: 'POST' }) : await api('/admin/transit');
    const feeds = data.feeds;
    const canReload = reload || data.canReload;
    const how = canReload
      ? `descarga el nuevo .zip en nap.transportes.gob.es, déjalo en la carpeta <code>data/gtfs</code> del servidor (sustituyendo el antiguo) y pulsa <button type="button" class="btn sm" data-reload-transit>Recargar horarios</button>`
      : 'los horarios los actualiza el administrador general del servidor (superadmin).';
    const fmtD = (d) => (d && d.length === 8 ? `${d.slice(6)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : '—');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    box.classList.remove('muted');
    box.innerHTML = feeds.length
      ? `<table class="table"><thead><tr><th>Operador</th><th>Viajes</th><th>Paradas</th><th>Válido hasta</th><th>Estado</th></tr></thead><tbody>${feeds
          .map((f) => {
            const st = f.validTo < today ? '<span class="badge rejected">Caducado</span>' : f.validTo < soon ? '<span class="badge pending">Renovar pronto</span>' : '<span class="badge confirmed">Al día</span>';
            return `<tr><td><b>${esc(f.agencies.join(', '))}</b><div class="muted small">${esc(f.file)}</div></td><td>${f.trips.toLocaleString('es-ES')}</td><td>${f.stops}</td><td>${esc(fmtD(f.validTo))}</td><td>${st}</td></tr>`;
          })
          .join('')}</tbody></table><p class="muted small">Para actualizar: ${how}</p>`
      : `<p class="muted">No hay horarios cargados. Para activarlos: ${how}</p>`;
    box.querySelector('[data-reload-transit]')?.addEventListener('click', () => {
      box.innerHTML = 'Recargando…';
      paintTransit(box, true);
    });
  } catch (err) {
    box.textContent = errorText(err);
  }
}

function listPage(m, { title, help, columns, rows, onNew }) {
  m.innerHTML = `<div class="toolbar"><h2>${esc(title)}</h2><button class="btn primary" data-new>${icon('add')} Nuevo</button></div>${help ? `<p class="muted">${help}</p>` : ''}
    <table class="table"><thead><tr>${columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}<th scope="col"><span class="sr-only">Acciones</span></th></tr></thead><tbody>${rows.join('') || `<tr class="empty-row"><td colspan="${columns.length + 1}" class="muted">Todavía no hay nada aquí. Pulsa <b>Nuevo</b> para crear el primero.</td></tr>`}</tbody></table>`;
  m.querySelector('[data-new]').addEventListener('click', onNew);
}
const rowBtns = (id, extra = '', { canDelete = true } = {}) => `<td class="right">${extra}<button class="btn sm" data-edit="${esc(id)}" aria-label="Editar" title="Editar">${icon('edit')}</button>${canDelete ? `<button class="btn sm no" data-del="${esc(id)}" aria-label="Eliminar" title="Eliminar">${icon('delete')}</button>` : ''}</td>`;
function bindRows(m, { onEdit, onDelete }) {
  m.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => onEdit(state.items.find((x) => x.id === b.dataset.edit))));
  m.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('¿Eliminar este elemento? No se puede deshacer.', 'Eliminar'))) return;
      try {
        await onDelete(b.dataset.del);
        toast('Eliminado');
      } catch (err) {
        toast(errorText(err), 'err');
      }
      load();
    }),
  );
}
async function save(table, item, body) {
  try {
    await api(item ? `/admin/${table}/${item.id}` : `/admin/${table}`, { method: item ? 'PUT' : 'POST', body });
    toast('Guardado');
    load();
  } catch (err) {
    toast(errorText(err), 'err');
  }
}

// Services
function renderServices(m) {
  listPage(m, {
    title: 'Servicios del hotel',
    help: 'Lo que el huésped ve en “En el hotel”. El horario semanal calcula “Abierto ahora”.',
    columns: ['Orden', 'Icono', 'Nombre', 'Categoría', 'Horario', 'Activo'],
    rows: state.items.map((s) => `<tr><td>${s.sort}</td><td>${icon(s.icon)}</td><td><b>${esc(s.name.es || s.name.en)}</b></td><td>${esc(s.category)}</td><td>${esc(s.hours.es || '')}</td><td>${s.active ? '✔' : '—'}</td>${rowBtns(s.id)}</tr>`),
    onNew: () => editService(null),
  });
  bindRows(m, { onEdit: editService, onDelete: (id) => api(`/admin/services/${id}`, { method: 'DELETE' }) });
}
async function editService(s) {
  const open = s?.open?.[0];
  const v = await modal({
    wide: true,
    title: s ? 'Editar servicio' : 'Nuevo servicio',
    body: `<div class="row">${iconField('icon', s?.icon || 'room_service')}<label>Categoría${select('category', SERVICE_CATS, s?.category || 'leisure')}</label><label>Orden<input name="sort" type="number" value="${s?.sort ?? 0}" /></label></div>
      <h4>Nombre</h4>${i18nInputs('name', s?.name)}<h4>Descripción</h4>${i18nInputs('desc', s?.desc, { textarea: true })}<h4>Horario (texto)</h4>${i18nInputs('hours', s?.hours)}
      <h4>Horario semanal para “Abierto ahora” (opcional)</h4><div class="row"><label>Desde<input name="from" type="time" value="${esc(open?.from || '')}" /></label><label>Hasta<input name="to" type="time" value="${esc(open?.to || '')}" /></label></div>
      ${checks('days', ['1', '2', '3', '4', '5', '6', '0'], (open?.days || []).map(String), { 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb', 0: 'Dom' })}
      <h4>Foto</h4>${photoField(s?.photo)}
      <div class="row"><label class="chk"><input type="checkbox" name="bookable" ${s?.bookable ? 'checked' : ''}/> Se reserva en recepción</label><label class="chk"><input type="checkbox" name="active" ${s?.active ?? true ? 'checked' : ''}/> Activo</label></div>`,
  });
  if (!v) return;
  const u = unflatten(v);
  const openTable = u.from && u.to && u.days?.length ? [{ days: u.days.map(Number), from: u.from, to: u.to }] : null;
  save('services', s, { icon: u.icon, category: u.category, sort: num(u.sort), name: u.name, desc: u.desc, hours: u.hours, open: openTable, bookable: !!u.bookable, active: !!u.active, photo: u.photo || '' });
}

// Actions
function renderActions(m) {
  listPage(m, {
    title: 'Acciones rápidas (panel Tareas)',
    help: 'Con campos → abre un formulario y crea una solicitud para recepción. Sin campos y con teléfono → llamada directa.',
    columns: ['Orden', 'Icono', 'Nombre', 'Clave', 'Campos', 'Teléfono', 'Activo'],
    rows: state.items.map((a) => `<tr><td>${a.sort}</td><td>${icon(a.icon)}</td><td><b>${esc(a.name.es || a.name.en)}</b></td><td><code>${esc(a.key)}</code></td><td>${esc(a.fields.join(', '))}</td><td>${esc(a.tel)}</td><td>${a.active ? '✔' : '—'}</td>${rowBtns(a.id)}</tr>`),
    onNew: () => editAction(null),
  });
  bindRows(m, { onEdit: editAction, onDelete: (id) => api(`/admin/actions/${id}`, { method: 'DELETE' }) });
}
async function editAction(a) {
  const v = await modal({
    wide: true,
    title: a ? 'Editar acción' : 'Nueva acción',
    body: `<div class="row"><label>Clave (tipo de solicitud)<input name="key" value="${esc(a?.key || '')}" placeholder="spa, taxi, table…" /></label>${iconField('icon', a?.icon || 'support_agent')}<label>Orden<input name="sort" type="number" value="${a?.sort ?? 0}" /></label></div>
      <h4>Nombre</h4>${i18nInputs('name', a?.name)}<h4>Subtítulo (opcional)</h4>${i18nInputs('sub', a?.sub)}
      <h4>Campos del formulario</h4>${checks('fields', FIELDS, a?.fields || [], { when: 'Fecha/hora', people: 'Personas', destination: 'Destino', details: 'Detalles' })}
      <div class="row"><label>Teléfono (si no hay campos: llamada directa)<input name="tel" value="${esc(a?.tel || '')}" /></label><label class="chk"><input type="checkbox" name="active" ${a?.active ?? true ? 'checked' : ''}/> Activa</label></div>`,
  });
  if (!v) return;
  const u = unflatten(v);
  save('actions', a, { key: u.key, icon: u.icon, sort: num(u.sort), name: u.name, sub: u.sub, fields: u.fields || [], tel: u.tel, active: !!u.active });
}

// POIs
function renderPois(m) {
  listPage(m, {
    title: 'Lugares y qué hacer',
    help: 'Cada lugar lleva su checklist de tareas y botones de acción (enlace de entradas, solicitud a recepción o ver transporte).',
    columns: ['Prio.', 'Foto', 'Nombre', 'Categoría', 'Etiqueta', 'Minutos', 'Momentos', 'Tareas', 'Botones', 'Activo'],
    rows: state.items.map((p) => `<tr><td>${p.priority}</td><td>${p.photo ? `<img class="thumb" src="${esc(p.photo)}" alt="" />` : '<span class="muted">—</span>'}</td><td><b>${esc(p.name.es || p.name.en)}</b>${p.indoor ? ` <span class="badge">a cubierto</span>` : ''}</td><td>${esc(p.cat)}</td><td>${esc(p.tag.es || '')}</td><td>${p.minutes}</td><td>${esc(p.best.join(', '))}</td><td>${(p.tasks.es || []).length}</td><td>${p.actions.length}</td><td>${p.active ? '✔' : '—'}</td>${rowBtns(p.id)}</tr>`),
    onNew: () => editPoi(null),
  });
  bindRows(m, { onEdit: editPoi, onDelete: (id) => api(`/admin/pois/${id}`, { method: 'DELETE' }) });
}
async function editPoi(p) {
  const actionsText = (p?.actions || []).map((a) => `${a.url ? 'url' : a.request ? 'request' : 'mode'}|${a.url || a.request || a.mode}|${a.icon || ''}|${LANGS.map((l) => a.label?.[l] || '').join('|')}`).join('\n');
  const v = await modal({
    wide: true,
    title: p ? 'Editar lugar' : 'Nuevo lugar',
    body: `<div class="row"><label>Categoría${select('cat', CATS, p?.cat || 'monument')}</label><label>Prioridad (0–10)<input name="priority" type="number" value="${p?.priority ?? 5}" /></label><label>Duración (min)<input name="minutes" type="number" value="${p?.minutes ?? 60}" /></label></div>
      <div class="row"><label>Latitud<input name="lat" type="number" step="0.000001" value="${p?.lat ?? ''}" required /></label><label>Longitud<input name="lon" type="number" step="0.000001" value="${p?.lon ?? ''}" required /></label></div>
      <h4>Foto</h4>${photoField(p?.photo)}
      <label class="chk"><input type="checkbox" name="indoor" ${p?.indoor ? 'checked' : ''}/> A cubierto (se recomienda cuando llueve o hace mucho calor)</label>
      <h4>Mejor momento</h4>${checks('best', MOMENTS, p?.best || ['morning', 'afternoon'], { morning: 'Mañana', afternoon: 'Tarde', evening: 'Atardecer', night: 'Noche' })}
      <h4>Nombre</h4>${i18nInputs('name', p?.name)}<h4>Etiqueta corta</h4>${i18nInputs('tag', p?.tag)}<h4>Descripción</h4>${i18nInputs('desc', p?.desc, { textarea: true })}
      <h4>Qué hacer (una tarea por línea)</h4>${i18nInputs('tasks', Object.fromEntries(LANGS.map((l) => [l, (p?.tasks?.[l] || []).join('\n')])), { textarea: true, rows: 4 })}
      <h4>Botones de acción</h4><p class="muted">Una por línea: <code>tipo|valor|icono|texto es|en|fr|de</code>. Tipo <code>url</code> (enlace), <code>request</code> (solicitud a recepción: tickets, flamenco…) o <code>mode</code> (walk/transit/bike).</p>
      <textarea name="actionsText" rows="4">${esc(actionsText)}</textarea>
      <label class="chk"><input type="checkbox" name="active" ${p?.active ?? true ? 'checked' : ''}/> Activo</label>`,
  });
  if (!v) return;
  const u = unflatten(v);
  const actions = linesToArray(u.actionsText).map((line) => {
    const [type, value, ic, ...labels] = line.split('|');
    const label = Object.fromEntries(LANGS.map((l, i) => [l, (labels[i] || labels[0] || '').trim()]));
    return { [type === 'url' ? 'url' : type === 'request' ? 'request' : 'mode']: value?.trim(), icon: ic?.trim() || undefined, label };
  });
  const tasks = Object.fromEntries(LANGS.map((l) => [l, linesToArray(u.tasks?.[l])]));
  save('pois', p, { cat: u.cat, priority: num(u.priority, 5), minutes: num(u.minutes, 60), lat: num(u.lat), lon: num(u.lon), best: u.best || [], name: u.name, tag: u.tag, desc: u.desc, tasks, actions, active: !!u.active, key: p?.key, photo: u.photo || '', indoor: !!u.indoor });
}

// Rooms
function renderRooms(m) {
  listPage(m, {
    title: 'Habitaciones y códigos QR',
    help: 'Imprime el QR de cada habitación: al escanearlo la app ya sabe la habitación y el huésped (si hay check-in).',
    columns: ['Habitación', 'Planta', 'Enlace', 'Activa'],
    rows: state.items.map((r) => `<tr><td><b>${esc(r.number)}</b></td><td>${esc(r.floor)}</td><td><a target="_blank" rel="noopener" href="${esc(r.url)}">${esc(r.url)}</a></td><td>${r.active ? '✔' : '—'}</td>${rowBtns(r.id, `<a class="btn sm" target="_blank" rel="noopener" href="/api/admin/rooms/${r.id}/qr.svg">${icon('qr_code')} QR</a>`)}</tr>`),
    onNew: () => editRoom(null),
  });
  bindRows(m, { onEdit: editRoom, onDelete: (id) => api(`/admin/rooms/${id}`, { method: 'DELETE' }) });
  const bulk = document.createElement('div');
  bulk.className = 'toolbar';
  bulk.innerHTML = `<button class="btn" data-bulk>${icon('playlist_add')} Crear varias (rango)</button><a class="btn" href="#" data-print>${icon('print')} Imprimir todos los QR</a>`;
  m.appendChild(bulk);
  bulk.querySelector('[data-bulk]').addEventListener('click', async () => {
    const v = await modal({ title: 'Crear habitaciones', body: `<div class="row"><label>Desde<input name="from" type="number" value="101" /></label><label>Hasta<input name="to" type="number" value="120" /></label></div><p class="muted">La planta se toma del primer dígito.</p>` });
    if (!v) return;
    let created = 0;
    let existing = 0;
    let failed = 0;
    for (let n = num(v.from); n <= num(v.to) && n - num(v.from) < 400; n++) {
      try {
        await api('/admin/rooms', { method: 'POST', body: { number: String(n), floor: String(n)[0] } });
        created++;
      } catch (err) {
        if (err.message === 'already exists') existing++;
        else failed++;
      }
    }
    toast(`${created} creadas${existing ? ` · ${existing} ya existían` : ''}${failed ? ` · ${failed} con error` : ''}`, failed ? 'err' : 'ok');
    load();
  });
  bulk.querySelector('[data-print]').addEventListener('click', (e) => {
    e.preventDefault();
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>QR habitaciones</title><style>body{font-family:Inter,sans-serif;display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:24px}figure{margin:0;text-align:center;page-break-inside:avoid}img{width:100%;max-width:220px}figcaption{font-size:22px;font-weight:700}small{color:#666}</style></head><body>${state.items.map((r) => `<figure><img src="/api/admin/rooms/${r.id}/qr.svg"/><figcaption>Habitación ${esc(r.number)}</figcaption><small>${esc(state.hotel.name)} · escanea para tu concierge</small></figure>`).join('')}</body></html>`);
    w.document.close();
  });
}
async function editRoom(r) {
  const v = await modal({ title: r ? 'Editar habitación' : 'Nueva habitación', body: `<div class="row"><label>Número<input name="number" value="${esc(r?.number || '')}" required /></label><label>Planta<input name="floor" value="${esc(r?.floor || '')}" /></label></div><label class="chk"><input type="checkbox" name="active" ${r?.active ?? true ? 'checked' : ''}/> Activa</label>` });
  if (!v) return;
  save('rooms', r, { number: v.number, floor: v.floor, active: !!v.active });
}

// Users
function renderUsers(m) {
  listPage(m, {
    title: 'Usuarios del hotel',
    help: 'Administrador: todo. Recepción: solicitudes y estancias. Personal: solo solicitudes.',
    columns: ['Nombre', 'Email', 'Rol', 'Estado', 'Último acceso'],
    rows: state.items.map((u) => {
      const me = u.id === state.user.id;
      const status = !u.active ? '<span class="badge rejected">Desactivado</span>' : u.mustChangePassword ? '<span class="badge pending">Contraseña temporal</span>' : '<span class="badge done">Activo</span>';
      const extra = me ? '' : `<button class="btn sm" data-signout="${esc(u.id)}" aria-label="Cerrar sus sesiones" title="Cerrar todas sus sesiones">${icon('devices')}</button>`;
      return `<tr><td><b>${esc(u.name || '—')}</b>${me ? ' <span class="muted">(tú)</span>' : ''}</td><td>${esc(u.email)}</td><td>${esc(ROLE_LABEL[u.role] || u.role)}</td><td>${status}</td><td>${u.lastLoginAt ? esc(fmt(u.lastLoginAt)) : '<span class="muted">Nunca</span>'}</td>${rowBtns(u.id, extra, { canDelete: !me })}</tr>`;
    }),
    onNew: () => editUser(null),
  });
  bindRows(m, { onEdit: editUser, onDelete: (id) => api(`/admin/users/${id}`, { method: 'DELETE' }) });
  m.querySelectorAll('[data-signout]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Se cerrará la sesión de este usuario en todos sus dispositivos.', 'Cerrar sesiones'))) return;
      await api(`/admin/users/${b.dataset.signout}`, { method: 'PUT', body: { signOut: true } }).then(() => toast('Sesiones cerradas'), (e) => toast(errorText(e), 'err'));
    }),
  );
}
async function editUser(u) {
  const v = await modal({ title: u ? 'Editar usuario' : 'Nuevo usuario', body: `<label>Nombre<input name="name" value="${esc(u?.name || '')}" /></label>${u ? '' : '<label>Email<input name="email" type="email" required /></label>'}<label>Rol${select('role', ['admin', 'reception', 'staff'], u?.role || 'reception', ROLE_LABEL)}</label><label>${u ? 'Contraseña temporal nueva (vacío = no cambiar)' : 'Contraseña temporal'}<input name="password" type="password" autocomplete="new-password" minlength="10" ${u ? '' : 'required'} /></label><p class="hint">Mínimo 10 caracteres, con letras y números. El usuario deberá cambiarla al entrar.</p>${u ? `<label class="chk"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}/> Activo</label>` : ''}` });
  if (!v) return;
  save('users', u, { ...v, active: u ? !!v.active : true, password: v.password || undefined });
}

// Hotels (superadmin)
async function renderHotels(m) {
  const { hotels } = await api('/super/hotels');
  state.hotels = hotels;
  m.innerHTML = `<div class="toolbar"><h2>Hoteles</h2><button class="btn primary" data-new>${icon('add')} Nuevo hotel</button></div>
    <table class="table"><thead><tr><th>Nombre</th><th>Slug</th><th>Ciudad</th><th>Pendientes</th><th>Activo</th><th><span class="sr-only">Acciones</span></th></tr></thead><tbody>
    ${hotels.map((h) => `<tr><td><b>${esc(h.name)}</b></td><td><code>${esc(h.slug)}</code></td><td>${esc(h.city)}</td><td>${h.pending}</td><td>${h.active ? '✔' : '—'}</td><td class="right"><a class="btn sm" target="_blank" rel="noopener" href="/?h=${esc(h.slug)}">${icon('open_in_new')} App</a><button class="btn sm" data-toggle="${h.id}" data-active="${h.active ? 1 : 0}">${h.active ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('')}</tbody></table>`;
  m.querySelector('[data-new]').addEventListener('click', async () => {
    const v = await modal({ title: 'Nuevo hotel', body: `<div class="row"><label>Nombre<input name="name" required /></label><label>Slug (URL)<input name="slug" required placeholder="hotel-sol-malaga" /></label></div>
      <div class="row"><label>Ciudad<input name="city" /></label><label>Teléfono<input name="phone" /></label></div><label>Dirección<input name="address" /></label>
      <div class="row"><label>Latitud<input name="lat" type="number" step="0.000001" /></label><label>Longitud<input name="lon" type="number" step="0.000001" /></label></div>
      <h4>Administrador del hotel</h4><div class="row"><label>Nombre<input name="adminName" /></label><label>Email<input name="adminEmail" type="email" /></label><label>Contraseña temporal<input name="adminPassword" type="password" minlength="10" autocomplete="new-password" /></label></div>` });
    if (!v) return;
    try {
      await api('/super/hotels', { method: 'POST', body: { ...v, lat: num(v.lat, 37.1773), lon: num(v.lon, -3.5986) } });
      toast('Hotel creado');
      location.reload();
    } catch (err) {
      toast(errorText(err), 'err');
    }
  });
  m.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/super/hotels/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active !== '1' } });
      load();
    }),
  );
}

shell();
load();
