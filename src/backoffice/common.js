import { glyph, PICKER_ICONS } from '../design/icons.js';
/** Shared helpers for the reception and admin screens. */
// Icon ligatures stay hidden until the symbol font loads (offline: shown after 3 s).
document.fonts
  ?.load('20px "Concierge Symbols"')
  .then(() => document.body.classList.add('icons-ready'))
  .catch(() => {});
setTimeout(() => document.body.classList.add('icons-ready'), 3000);
export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export const icon = (name, cls = '') =>
  `<span class="msym ${esc(cls)}" aria-hidden="true">${glyph(name)}</span>`;
export const fmt = (iso) => {
  if (!iso) return '';
  const d = new Date(
    iso.includes('T') || iso.includes(' ')
      ? iso.replace(' ', 'T') +
          (iso.endsWith('Z') || iso.includes('+') ? '' : 'Z')
      : iso,
  );
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('es-ES', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
};
export const fmtLocal = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleString('es-ES', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
};

export const TYPE_LABEL = {
  spa: 'Spa / masaje',
  table: 'Mesa gastrobar',
  breakfast: 'Desayuno en habitación',
  taxi: 'Taxi',
  latecheckout: 'Late check-out',
  housekeeping: 'Toallas / limpieza',
  parking: 'Parking',
  flamenco: 'Flamenco',
  reception: 'Recepción',
  tickets: 'Entradas',
  other: 'Otro',
};
export const STATUS_LABEL = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  done: 'Hecha',
  rejected: 'No disponible',
};
export const ROLE_LABEL = {
  superadmin: 'Superadmin',
  admin: 'Administrador',
  reception: 'Recepción',
  staff: 'Personal',
};

let hotelOverride = '';
export function setHotelOverride(id) {
  hotelOverride = id || '';
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(hotelOverride ? { 'X-Hotel': hotelOverride } : {}),
    },
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

const AUTH_ERRORS = {
  'invalid credentials': 'Email o contraseña incorrectos',
  'too many attempts':
    'Demasiados intentos. Espera unos minutos y vuelve a probar.',
  'wrong password': 'La contraseña actual no es correcta',
  'invalid or expired link':
    'El enlace ha caducado o ya se usó. Pide uno nuevo.',
  'use letters and numbers': 'Usa letras y números',
  'new password must be different':
    'La nueva contraseña debe ser distinta de la actual',
};
export function authError(err) {
  const m = String(err?.message || '');
  if (/^min (\d+) characters/.test(m))
    return `Mínimo ${m.match(/\d+/)[0]} caracteres, con letras y números`;
  if (err?.status === 429) return AUTH_ERRORS['too many attempts'];
  return AUTH_ERRORS[m] || m || 'No se pudo completar. Inténtalo de nuevo.';
}

function authCard(title, inner) {
  return `<main class="login"><form class="login-card" novalidate>
    <div class="brand">${icon('hotel')}<div><h1 class="login-title">${esc(title)}</h1><div class="muted">Concierge · acceso del personal</div></div></div>
    ${inner}</form></main>`;
}
const pwHint =
  '<p class="hint">Mínimo 10 caracteres, con letras y números.</p>';

/** Form helper: disables the button while working and shows errors inline. */
function bindForm(root, onSubmit) {
  const form = root.querySelector('form');
  const errEl = form.querySelector('[data-err]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      errEl.textContent = 'Revisa los campos marcados';
      form.querySelector(':invalid')?.focus();
      return;
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.classList.add('busy');
    errEl.textContent = '';
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), errEl);
    } catch (err) {
      errEl.textContent = authError(err);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  });
  form.querySelector('input')?.focus();
}

/** Forced password change (first sign-in, or after an admin reset). */
function changePasswordView(root, title, me) {
  return new Promise((resolve) => {
    root.innerHTML = authCard(
      title,
      `
      <p class="notice">${icon('lock_reset')} <span>Hola${me.user.name ? ` ${esc(me.user.name)}` : ''}: por seguridad, crea tu propia contraseña antes de continuar.</span></p>
      <label>Contraseña actual<input name="current" type="password" required autocomplete="current-password" /></label>
      <label>Nueva contraseña<input name="next" type="password" required minlength="10" autocomplete="new-password" /></label>
      <label>Repite la nueva<input name="again" type="password" required minlength="10" autocomplete="new-password" /></label>
      ${pwHint}<div class="err" role="alert" data-err></div>
      <button class="btn primary" type="submit">Guardar y entrar</button>`,
    );
    bindForm(root, async (v, errEl) => {
      if (v.next !== v.again)
        return (errEl.textContent = 'Las contraseñas no coinciden');
      await api('/auth/password', {
        method: 'POST',
        body: { current: v.current, next: v.next },
      });
      resolve(await api('/auth/me'));
    });
  });
}

function resetView(root, title, tokenValue) {
  return new Promise(() => {
    root.innerHTML = authCard(
      title,
      `
      <p class="notice">${icon('key')} <span>Crea una contraseña nueva para tu cuenta.</span></p>
      <label>Nueva contraseña<input name="password" type="password" required minlength="10" autocomplete="new-password" /></label>
      <label>Repite la nueva<input name="again" type="password" required minlength="10" autocomplete="new-password" /></label>
      ${pwHint}<div class="err" role="alert" data-err></div>
      <button class="btn primary" type="submit">Cambiar contraseña</button>`,
    );
    bindForm(root, async (v, errEl) => {
      if (v.password !== v.again)
        return (errEl.textContent = 'Las contraseñas no coinciden');
      await api('/auth/reset', {
        method: 'POST',
        body: { token: tokenValue, password: v.password },
      });
      history.replaceState(null, '', location.pathname);
      root.querySelector('form').innerHTML =
        `<p class="notice ok">${icon('check_circle')} <span>Contraseña cambiada. Ya puedes entrar.</span></p><a class="btn primary" href="${location.pathname}">Ir al acceso</a>`;
    });
  });
}

function forgotView(root, title, back) {
  root.innerHTML = authCard(
    title,
    `
    <p class="muted">Escribe el email de tu cuenta y te enviaremos un enlace para crear una contraseña nueva.</p>
    <label>Email<input name="email" type="email" required autocomplete="username" /></label>
    <div class="err" role="alert" data-err></div>
    <button class="btn primary" type="submit">Enviar enlace</button>
    <button class="btn link" type="button" data-back>Volver</button>`,
  );
  root.querySelector('[data-back]').addEventListener('click', back);
  bindForm(root, async (v) => {
    const r = await api('/auth/forgot', {
      method: 'POST',
      body: { email: v.email },
    });
    root.querySelector('form').innerHTML = r.emailReset
      ? `<p class="notice ok">${icon('mark_email_read')} <span>Si el email pertenece a una cuenta activa, recibirás un enlace válido durante 30 minutos.</span></p><button class="btn" type="button" data-back>Volver</button>`
      : `<p class="notice">${icon('info')} <span>Este servidor no tiene correo configurado. Pide a un administrador del hotel que te asigne una contraseña temporal desde <b>Admin → Usuarios</b>.</span></p><button class="btn" type="button" data-back>Volver</button>`;
    root.querySelector('[data-back]').addEventListener('click', back);
  });
}

/** Login gate: resolves with { user, hotel } once signed in (and password is not pending). */
export async function requireLogin(root, title) {
  const reset = /^#reset=([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
  if (reset) return resetView(root, title, reset[1]);
  let me = null;
  try {
    me = await api('/auth/me');
  } catch {}
  if (!me?.user) {
    me = await new Promise((resolve) => {
      const show = () => {
        root.innerHTML = authCard(
          title,
          `
          <label>Email<input name="email" type="email" required autocomplete="username" /></label>
          <label>Contraseña<input name="password" type="password" required autocomplete="current-password" /></label>
          <div class="err" role="alert" data-err></div>
          <button class="btn primary" type="submit">Entrar</button>
          <button class="btn link" type="button" data-forgot>¿Has olvidado la contraseña?</button>`,
        );
        root
          .querySelector('[data-forgot]')
          .addEventListener('click', () => forgotView(root, title, show));
        bindForm(root, async (v) => {
          await api('/auth/login', {
            method: 'POST',
            body: { email: v.email, password: v.password },
          });
          resolve(await api('/auth/me'));
        });
      };
      show();
    });
  }
  if (me.user.mustChangePassword)
    me = await changePasswordView(root, title, me);
  return me;
}

/** Header button with the account menu: change password, sign out everywhere, sign out. */
export const accountButton = (user) =>
  `<button class="btn sm" data-account aria-label="Mi cuenta: ${esc(user?.name || user?.email || '')}" title="Mi cuenta">${icon('account_circle')}<span class="hide-sm">${esc(user?.name || 'Cuenta')}</span></button>`;
export function bindAccount(root, user) {
  root.querySelector('[data-account]')?.addEventListener('click', async () => {
    const v = await modal({
      title: 'Mi cuenta',
      submit: 'Cambiar contraseña',
      body: `<p class="muted">${esc(user.email)} · ${esc(ROLE_LABEL[user.role] || user.role)}</p>
        <label>Contraseña actual<input name="current" type="password" autocomplete="current-password" required /></label>
        <label>Nueva contraseña<input name="next" type="password" minlength="10" autocomplete="new-password" required /></label>
        ${pwHint}
        <div class="row gap"><button type="button" class="btn sm" data-signout>${icon('logout')} Cerrar sesión</button>
        <button type="button" class="btn sm no" data-signout-all>${icon('devices')} Cerrar sesión en todos los dispositivos</button></div>`,
      onOpen: (form, close) => {
        form
          .querySelector('[data-signout]')
          .addEventListener('click', async () => {
            await api('/auth/logout', { method: 'POST' }).catch(() => {});
            location.reload();
          });
        form
          .querySelector('[data-signout-all]')
          .addEventListener('click', async () => {
            await api('/auth/logout-all', { method: 'POST' }).catch(() => {});
            location.reload();
          });
      },
    });
    if (!v) return;
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { current: v.current, next: v.next },
      });
      toast(
        'Contraseña cambiada. Se ha cerrado la sesión en tus otros dispositivos.',
      );
    } catch (err) {
      toast(authError(err), 'no');
    }
  });
}

const API_ERRORS = {
  'already exists': 'Ya existe un elemento con ese valor',
  'email already exists': 'Ya existe un usuario con ese email',
  'name required': 'Falta el nombre (al menos en español o inglés)',
  'valid lat/lon required': 'Latitud o longitud no válidas',
  'valid room number required': 'Número de habitación no válido',
  'valid e-mail required': 'Email no válido',
  'invalid e-mail': 'Email del hotel no válido',
  'invalid notification e-mail': 'Email de avisos no válido',
  'not found': 'No encontrado (puede que ya se haya borrado)',
  forbidden: 'No tienes permiso para esta acción',
  'cannot delete yourself': 'No puedes eliminar tu propia cuenta',
  'webhook: private address not allowed':
    'El webhook no puede apuntar a una red interna',
  'webhook: webhook must use https': 'El webhook debe usar https://',
  'webhook: invalid URL': 'La URL del webhook no es válida',
  'webhook: host not found': 'No se encuentra el servidor del webhook',
  'image too large (max 3 MB)': 'Imagen demasiado grande (máx. 3 MB)',
  'file is not a valid image': 'El archivo no es una imagen válida',
  blocked: 'Este dispositivo está bloqueado',
  'empty message': 'El mensaje está vacío',
};
export function errorText(err) {
  const m = String(err?.message || '');
  if (err?.status === 429) return 'Demasiadas peticiones. Espera un momento.';
  if (/password: /.test(m))
    return authError({ message: m.replace(/^.*password: /, '') });
  return API_ERRORS[m] || authError(err);
}

/** Accessible confirmation dialog (replaces window.confirm). */
export async function confirmDialog(message, submit = 'Confirmar') {
  const v = await modal({
    title: 'Confirmar',
    body: `<p>${esc(message)}</p>`,
    submit,
  });
  return !!v;
}

export function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' || kind === 'no' ? 'alert' : 'status');
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
export function modal({
  title,
  body,
  submit = 'Guardar',
  wide = false,
  onOpen,
}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<form class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button type="button" class="x" data-close aria-label="Cerrar">${icon('close')}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">${esc(submit)}</button></div></form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const opener = document.activeElement;
    const app = document.getElementById('app');
    app?.setAttribute('inert', ''); // the page behind the dialog can't be reached
    const close = (v) => {
      wrap.remove();
      app?.removeAttribute('inert');
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') return close(null);
      if (e.key !== 'Tab') return;
      // Keep Tab inside the dialog.
      const items = [
        ...form.querySelectorAll('button, input, select, textarea, a[href]'),
      ].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
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
    onOpen?.(form, close);
    (
      form.querySelector('input, textarea, select') ||
      form.querySelector('button[type=submit]')
    )?.focus();
  });
}

/** Icon field with a searchable list of the icons available in the app, and a live preview. */
export function iconField(name, value, label = 'Icono') {
  return `<label>${esc(label)}<span class="icon-field"><span class="icon-preview" data-icon-preview>${icon(value)}</span><input name="${esc(name)}" value="${esc(value)}" list="icon-list" autocomplete="off" pattern="[a-z0-9_]{1,40}" /></span></label>
    <datalist id="icon-list">${PICKER_ICONS.map((n) => `<option value="${n}"></option>`).join('')}</datalist>`;
}
document.addEventListener('input', (e) => {
  const input = e.target.closest?.('.icon-field input');
  if (input)
    input.parentElement.querySelector('[data-icon-preview]').innerHTML = icon(
      input.value.trim(),
    );
});
