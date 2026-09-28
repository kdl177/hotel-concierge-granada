/** Shared helpers for the reception and admin screens. */
// Icon ligatures stay hidden until the symbol font loads (offline: shown after 3 s).
document.fonts?.load('20px "Material Symbols Rounded"').then(() => document.body.classList.add('icons-ready')).catch(() => {});
setTimeout(() => document.body.classList.add('icons-ready'), 3000);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const icon = (name, cls = '') => `<span class="msym ${cls}" aria-hidden="true">${name}</span>`;
export const fmt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes(' ') ? iso.replace(' ', 'T') + (iso.endsWith('Z') || iso.includes('+') ? '' : 'Z') : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export const fmtLocal = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export const TYPE_LABEL = {
  spa: 'Spa / masaje', table: 'Mesa gastrobar', breakfast: 'Desayuno en habitación', taxi: 'Taxi',
  latecheckout: 'Late check-out', housekeeping: 'Toallas / limpieza', parking: 'Parking',
  flamenco: 'Flamenco', reception: 'Recepción', tickets: 'Entradas', other: 'Otro',
};
export const STATUS_LABEL = { pending: 'Pendiente', confirmed: 'Confirmada', done: 'Hecha', rejected: 'No disponible' };
export const ROLE_LABEL = { superadmin: 'Superadmin', admin: 'Administrador', reception: 'Recepción', staff: 'Personal' };

let hotelOverride = '';
export function setHotelOverride(id) {
  hotelOverride = id || '';
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(hotelOverride ? { 'X-Hotel': hotelOverride } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Login gate: resolves with { user, hotel } once signed in. */
export async function requireLogin(root, title) {
  try {
    return await api('/auth/me');
  } catch {}
  return new Promise((resolve) => {
    root.innerHTML = `<div class="login">
      <form class="login-card">
        <div class="brand">${icon('hotel')}<div><b>${esc(title)}</b><div class="muted">Concierge · acceso del personal</div></div></div>
        <label>Email<input name="email" type="email" required autocomplete="username" /></label>
        <label>Contraseña<input name="password" type="password" required autocomplete="current-password" /></label>
        <div class="err" data-err></div>
        <button class="btn primary" type="submit">Entrar</button>
      </form></div>`;
    root.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
        resolve(await api('/auth/me'));
      } catch (err) {
        root.querySelector('[data-err]').textContent = err.status === 401 ? 'Email o contraseña incorrectos' : err.message;
      }
    });
  });
}

export function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.start();
    o.stop(ctx.currentTime + 0.25);
  } catch {}
}

/** Simple modal with a form; resolves with the form values or null. */
export function modal({ title, body, submit = 'Guardar', wide = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<form class="modal ${wide ? 'wide' : ''}"><div class="modal-head"><b>${esc(title)}</b><button type="button" class="x" data-close>${icon('close')}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">${esc(submit)}</button></div></form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const close = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close(null);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.type === 'checkbox') out[el.name] = el.checked;
        else out[el.name] = el.value;
      }
      close(out);
    });
    form.querySelector('input, textarea, select')?.focus();
  });
}
