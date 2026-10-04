/** Reception screen: live request inbox, assignment, notes, history, stays. */
import { api, esc, icon, fmt, fmtLocal, TYPE_LABEL as BASE_LABEL, STATUS_LABEL, requireLogin, accountButton, bindAccount, toast, beep, modal, setHotelOverride } from './common.js';

const root = document.getElementById('app');
const state = { user: null, hotel: null, hotels: [], tab: 'inbox', filter: 'open', q: '', requests: [], counts: {}, users: [], stays: [], known: null, expanded: new Set(), events: new Map(), chats: [], chatUnread: 0, chatKey: null, chat: null, chatLastSeen: null };

const session = await requireLogin(root, 'Recepción');
state.user = session.user;
state.hotel = session.hotel;
if (state.user.role === 'superadmin') {
  state.hotels = (await api('/super/hotels')).hotels;
  const saved = localStorage.getItem('bo.hotel');
  const pick = state.hotels.find((h) => h.id === saved) || state.hotels[0];
  if (pick) {
    setHotelOverride(pick.id);
    state.hotel = pick;
  }
}
document.addEventListener('click', () => (state.audio = true), { once: true });

// Request type → label, from this hotel's own quick actions (Admin → Acciones rápidas).
let TYPE_LABEL = { ...BASE_LABEL };
async function loadLabels() {
  TYPE_LABEL = { ...BASE_LABEL };
  try {
    const { actions } = await api(`/h/${encodeURIComponent(state.hotel?.slug || 'default')}/config`);
    for (const a of actions) TYPE_LABEL[a.key] = a.name?.es || a.name?.en || a.key;
  } catch {}
}
await loadLabels();

function shell() {
  root.innerHTML = `
    <header class="bar">
      <div class="brand">${icon('hotel')}<div><h1 class="brand-title">${esc(state.hotel?.name || 'Concierge')}</h1><div class="muted">Recepción</div></div></div>
      ${state.hotels.length > 1 ? `<select data-hotel class="sel" aria-label="Hotel">${state.hotels.map((h) => `<option value="${h.id}" ${h.id === state.hotel.id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select>` : ''}
      <nav class="tabs">
        <button data-tab="inbox" class="${state.tab === 'inbox' ? 'on' : ''}">${icon('inbox')} Solicitudes <span class="pill" data-pending></span></button>
        <button data-tab="chats" class="${state.tab === 'chats' ? 'on' : ''}">${icon('forum')} Chat <span class="pill" data-chat-unread>${state.chatUnread || ''}</span></button>
        <button data-tab="stays" class="${state.tab === 'stays' ? 'on' : ''}">${icon('bed')} Estancias</button>
      </nav>
      <div class="me"><span>${esc(state.user.name || state.user.email)}</span>
        ${['admin', 'superadmin'].includes(state.user.role) ? `<a class="btn sm" href="/admin.html">${icon('settings')} Admin</a>` : ''}
        ${accountButton(state.user)}</div>
    </header>
    <main id="main"></main>`;
  root.querySelector('[data-hotel]')?.addEventListener('change', (e) => {
    setHotelOverride(e.target.value);
    localStorage.setItem('bo.hotel', e.target.value);
    state.hotel = state.hotels.find((h) => h.id === e.target.value);
    state.known = null;
    state.users = [];
    loadLabels().then(() => {
      shell();
      refresh();
    });
  });
  bindAccount(root, state.user);
  root.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      shell();
      refresh();
    }),
  );
  renderMain();
}

function renderMain() {
  const main = document.getElementById('main');
  if (state.tab === 'stays') return renderStays(main);
  if (state.tab === 'chats') return renderChats(main);
  main.innerHTML = `
    <div class="toolbar">
      <div class="filters">
        ${[['open', 'Abiertas'], ['pending', 'Pendientes'], ['confirmed', 'Confirmadas'], ['done', 'Hechas'], ['rejected', 'No disponibles'], ['all', 'Todas']]
          .map(([k, l]) => `<button data-filter="${k}" class="${state.filter === k ? 'on' : ''}">${l}${state.counts[k] !== undefined && k !== 'open' && k !== 'all' ? ` <span class="pill">${state.counts[k]}</span>` : ''}</button>`)
          .join('')}
      </div>
      <label class="search">${icon('search')}<input data-q placeholder="Habitación, nombre, texto…" value="${esc(state.q)}" /></label>
      <span class="live" data-live>● en vivo</span>
    </div>
    <div class="cards" data-cards></div>`;
  main.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      renderMain();
      refresh();
    }),
  );
  let timer;
  main.querySelector('[data-q]').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = e.target.value;
      refresh();
    }, 250);
  });
  renderCards();
}

function renderCards() {
  const box = document.querySelector('[data-cards]');
  if (!box) return;
  document.querySelector('[data-pending]').textContent = state.counts.pending || '';
  if (!state.requests.length) {
    box.innerHTML = '<p class="muted">Sin solicitudes.</p>';
    return;
  }
  box.innerHTML = state.requests
    .map((r) => {
      const open = state.expanded.has(r.id);
      const ev = state.events.get(r.id);
      return `<article class="card ${esc(r.status)}" data-id="${esc(r.id)}">
        <div class="top">
          <span class="room">${esc(r.room)}</span>
          <div class="who"><b>${esc(TYPE_LABEL[r.type] || r.type)}</b>${r.name ? `<div class="muted">${esc(r.name)}</div>` : ''}</div>
          <span class="badge ${r.status}">${esc(STATUS_LABEL[r.status])}</span>
          <div class="time">${esc(fmt(r.createdAt))}${r.assignedName ? `<br/>${icon('person', 'sm')} ${esc(r.assignedName)}` : ''}</div>
        </div>
        ${r.when ? `<div class="meta">${icon('schedule', 'sm')} Para: <b>${esc(fmtLocal(r.when))}</b></div>` : ''}
        ${r.details ? `<div class="details">${esc(r.details)}</div>` : ''}
        ${r.note ? `<div class="meta note">${icon('sms', 'sm')} Nota al huésped: ${esc(r.note)}</div>` : ''}
        <div class="actions">
          ${r.status === 'pending' ? `<button class="btn ok" data-status="confirmed">${icon('check')} Confirmar</button>` : ''}
          ${r.status !== 'done' ? `<button class="btn" data-status="done">${icon('task_alt')} Hecha</button>` : ''}
          ${r.status === 'pending' ? `<button class="btn no" data-status="rejected">${icon('block')} No disponible</button>` : ''}
          ${r.status !== 'pending' ? `<button class="btn" data-status="pending">${icon('undo')} Reabrir</button>` : ''}
          <select class="sel" data-assign aria-label="Asignar a"><option value="">Sin asignar</option>${state.users.map((u) => `<option value="${u.id}" ${u.id === r.assignedTo ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select>
          <button class="btn" data-note>${icon('sms')} Nota</button>
          ${r.guestKey ? `<button class="btn" data-chat="${esc(r.guestKey)}">${icon('forum')} Chat</button>` : ''}
          <button class="btn" data-history>${icon('history')} ${open ? 'Ocultar' : 'Historial'}</button>
        </div>
        ${open ? `<ol class="events">${(ev || []).map((e) => `<li><span class="muted">${esc(fmt(e.at))}</span> ${esc(e.user || 'Huésped')} · ${esc(eventLabel(e))}</li>`).join('') || '<li class="muted">Cargando…</li>'}</ol>` : ''}
      </article>`;
    })
    .join('');
}

function eventLabel(e) {
  if (e.event === 'created') return 'creó la solicitud';
  if (e.event === 'status') return `cambió el estado a ${STATUS_LABEL[e.detail] || e.detail}`;
  if (e.event === 'note') return `nota al huésped: “${e.detail}”`;
  if (e.event === 'assigned') return e.detail ? `asignó a ${e.detail}` : 'quitó la asignación';
  if (e.event === 'comment') return `comentario interno: “${e.detail}”`;
  return e.event;
}

document.addEventListener('click', async (e) => {
  const toChat = e.target.closest('[data-chat]');
  if (toChat) {
    state.tab = 'chats';
    state.chatKey = toChat.dataset.chat;
    shell();
    return refresh();
  }
  const card = e.target.closest('[data-id]');
  if (!card) return;
  const id = card.dataset.id;
  const st = e.target.closest('[data-status]');
  if (st) {
    await api(`/staff/requests/${id}`, { method: 'PATCH', body: { status: st.dataset.status } });
    toast(`Solicitud ${STATUS_LABEL[st.dataset.status].toLowerCase()}`);
    return refresh();
  }
  if (e.target.closest('[data-note]')) {
    const r = state.requests.find((x) => x.id === id);
    const v = await modal({ title: `Nota para el huésped · hab. ${r.room}`, body: `<label>Texto que verá el huésped en su app<textarea name="note" rows="3">${esc(r.note || '')}</textarea></label><label>Comentario interno (no lo ve el huésped)<input name="comment" /></label>` });
    if (!v) return;
    await api(`/staff/requests/${id}`, { method: 'PATCH', body: { note: v.note, comment: v.comment || undefined } });
    return refresh();
  }
  if (e.target.closest('[data-history]')) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else {
      state.expanded.add(id);
      state.events.set(id, (await api(`/staff/requests/${id}/events`)).events);
    }
    renderCards();
  }
});
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-assign]');
  if (!sel) return;
  const id = sel.closest('[data-id]').dataset.id;
  await api(`/staff/requests/${id}`, { method: 'PATCH', body: { assignedTo: sel.value || null } });
  refresh();
});

async function refresh() {
  await refreshChatList();
  if (state.tab === 'stays') return refreshStays();
  if (state.tab === 'chats') return refreshChat();
  try {
    const [{ requests, counts }, { users }] = await Promise.all([
      api(`/staff/requests?status=${state.filter}&q=${encodeURIComponent(state.q)}`),
      state.users.length ? Promise.resolve({ users: state.users }) : api('/staff/users'),
    ]);
    state.users = users;
    const pendingIds = new Set(requests.filter((r) => r.status === 'pending').map((r) => r.id));
    if (state.known) {
      const fresh = [...pendingIds].filter((x) => !state.known.has(x));
      if (fresh.length) {
        if (state.audio) beep();
        toast(`${fresh.length} nueva${fresh.length > 1 ? 's' : ''} solicitud${fresh.length > 1 ? 'es' : ''}`, 'new');
        document.title = `(${counts.pending || fresh.length}) Recepción`;
      }
    }
    state.known = pendingIds;
    state.requests = requests;
    state.counts = counts;
    document.title = counts.pending ? `(${counts.pending}) Recepción` : 'Recepción';
    for (const id of state.expanded) state.events.set(id, (await api(`/staff/requests/${id}/events`)).events);
    renderCards();
    document.querySelector('[data-live]')?.classList.remove('off');
  } catch (err) {
    document.querySelector('[data-live]')?.classList.add('off');
    if (err.status === 401) location.reload();
  }
}

// ---------- stays ----------
function renderStays(main) {
  main.innerHTML = `
    <div class="toolbar"><button class="btn primary" data-checkin>${icon('login')} Nuevo check-in</button><span class="muted">Al hacer check-in, el QR de la habitación identifica al huésped y sus solicitudes quedan ligadas a la estancia.</span></div>
    <table class="table"><thead><tr><th>Hab.</th><th>Huésped</th><th>Pers.</th><th>Idioma</th><th>Entrada</th><th>Salida</th><th>Estado</th><th><span class="sr-only">Acciones</span></th></tr></thead>
    <tbody data-stays><tr><td colspan="8" class="muted">Cargando…</td></tr></tbody></table>`;
  main.querySelector('[data-checkin]').addEventListener('click', async () => {
    const v = await modal({ title: 'Check-in', body: `
      <div class="row"><label>Habitación<input name="room" required /></label><label>Personas<input name="guests" type="number" min="1" value="2" /></label></div>
      <label>Nombre del huésped<input name="guestName" /></label>
      <div class="row"><label>Idioma<select name="lang"><option value="es">Español</option><option value="en">English</option><option value="fr">Français</option><option value="de">Deutsch</option></select></label><label>Salida<input name="checkout" type="date" /></label></div>
      <label>Código de reserva (opcional)<input name="code" /></label>` });
    if (!v) return;
    try {
      await api('/staff/stays', { method: 'POST', body: { ...v, checkin: new Date().toISOString().slice(0, 10) } });
      toast('Check-in registrado');
      refreshStays();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  refreshStays();
}
async function refreshStays() {
  const body = document.querySelector('[data-stays]');
  if (!body) return;
  const { stays } = await api('/staff/stays');
  state.stays = stays;
  body.innerHTML = stays.length
    ? stays
        .map(
          (s) => `<tr class="${s.status}"><td><b>${esc(s.room || '—')}</b></td><td>${esc(s.guestName)}</td><td>${Number(s.guests) || 1}</td><td>${esc(s.lang.toUpperCase())}</td><td>${esc(s.checkin || '')}</td><td>${esc(s.checkout || '')}</td>
            <td><span class="badge ${s.status === 'active' ? 'confirmed' : 'done'}">${s.status === 'active' ? 'Activa' : s.status === 'closed' ? 'Cerrada' : 'Próxima'}</span></td>
            <td class="right">${s.status === 'active' ? `<button class="btn sm" data-checkout="${s.id}">${icon('logout')} Check-out</button>` : ''}
              ${s.roomToken ? `<a class="btn sm" target="_blank" href="/?h=${encodeURIComponent(state.hotel.slug)}&r=${encodeURIComponent(s.roomToken)}">${icon('qr_code')} App</a>` : ''}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="8" class="muted">Sin estancias.</td></tr>';
  body.querySelectorAll('[data-checkout]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/staff/stays/${b.dataset.checkout}`, { method: 'PATCH', body: { status: 'closed' } });
      toast('Check-out hecho');
      refreshStays();
    }),
  );
}


// ---------- chats ----------
const who = (c) => `Hab. ${c.room || '—'}${c.guestName ? ` · ${c.guestName}` : ''}`;
function sysLabel(body) {
  if (body === 'created') return 'Nueva solicitud';
  return `Estado: ${STATUS_LABEL[body.split(':')[1]] || body}`;
}
async function refreshChatList() {
  try {
    const { chats, unread } = await api('/staff/chats');
    const newest = chats.find((c) => c.unread && c.lastAuthor === 'guest');
    const sig = chats.filter((c) => c.unread).map((c) => `${c.key}:${c.unread}`).join('|');
    if (state.chatLastSeen !== null && sig && sig !== state.chatLastSeen && newest && newest.key !== state.chatKey) {
      if (state.audio) beep();
      toast(`Mensaje de ${who(newest)}`, 'new');
    }
    state.chatLastSeen = sig;
    state.chats = chats;
    state.chatUnread = unread;
    const pill = document.querySelector('[data-chat-unread]');
    if (pill) pill.textContent = unread || '';
  } catch {}
}
function renderChats(main) {
  main.innerHTML = `<div class="chat-layout">
    <aside class="chat-list" data-chat-list></aside>
    <section class="chat-pane" data-chat-pane><p class="muted" style="padding:20px">Elige una conversación.</p></section>
  </div>`;
  paintChatList();
}
function paintChatList() {
  const box = document.querySelector('[data-chat-list]');
  if (!box) return;
  box.innerHTML = state.chats.length
    ? state.chats
        .map(
          (c) => `<button class="chat-item ${c.key === state.chatKey ? 'on' : ''} ${c.unread ? 'unread' : ''}" data-open-chat="${esc(c.key)}">
            <div class="chat-item-top"><b>${esc(who(c))}</b><span class="muted">${esc(fmt(c.lastAt))}</span></div>
            <div class="chat-item-last">${c.lastAuthor === 'system' ? esc(sysLabel(c.lastBody || '')) : `${c.lastAuthor === 'staff' ? 'Tú: ' : ''}${esc(c.lastBody || '')}`}</div>
            ${c.unread ? `<span class="pill">${c.unread}</span>` : ''}
            <span class="lang">${esc((c.lang || '').toUpperCase())}</span>
          </button>`,
        )
        .join('')
    : '<p class="muted" style="padding:14px">Sin conversaciones todavía.</p>';
}
async function refreshChat() {
  paintChatList();
  if (!state.chatKey) return;
  const pane = document.querySelector('[data-chat-pane]');
  if (!pane) return;
  try {
    const data = await api(`/staff/chats/${encodeURIComponent(state.chatKey)}`);
    const sameCount = state.chat && state.chat.key === data.chat.key && state.chat.messages.length === data.messages.length;
    state.chat = { key: data.chat.key, ...data };
    if (sameCount && pane.querySelector('[data-chat-form]')) return; // nothing new: keep the draft untouched
    const draft = pane.querySelector('[data-chat-form] textarea')?.value || '';
    const ctx = pane.querySelector('[data-chat-form] select')?.value || '';
    pane.innerHTML = `
      <header class="chat-head"><div><b>${esc(who(data.chat))}</b><div class="muted">Idioma del huésped: ${esc((data.chat.lang || 'es').toUpperCase())}</div></div></header>
      <div class="chat-body">
        <div class="chat-msgs" data-msgs>${data.messages
          .map((m) => {
            const time = fmt(m.at);
            const req = data.requests.find((r) => r.id === m.requestId);
            const reqLabel = req ? `${TYPE_LABEL[req.type] || req.type}` : '';
            if (m.author === 'system') return `<div class="msg sys">${icon('info', 'sm')} ${esc(sysLabel(m.body))}${reqLabel ? ` · <b>${esc(reqLabel)}</b>` : ''} <span>${esc(time)}</span></div>`;
            return `<div class="msg ${m.author === 'staff' ? 'mine' : 'theirs'}">
              ${m.author === 'staff' ? `<div class="who">${esc(m.staffName || 'Recepción')}</div>` : ''}
              ${reqLabel ? `<div class="ref">${icon('reply', 'sm')} ${esc(reqLabel)}</div>` : ''}
              <div class="body">${esc(m.body)}</div><div class="time">${esc(time)}</div></div>`;
          })
          .join('')}</div>
        <aside class="chat-reqs"><h4>Solicitudes de este huésped</h4>${data.requests.length
          ? data.requests.map((r) => `<div class="mini-req ${r.status}"><b>${esc(TYPE_LABEL[r.type] || r.type)}</b><span class="badge ${r.status}">${esc(STATUS_LABEL[r.status])}</span>${r.when ? `<div class="muted">${esc(fmtLocal(r.when))}</div>` : ''}</div>`).join('')
          : '<p class="muted">Ninguna.</p>'}</aside>
      </div>
      <form class="chat-form" data-chat-form>
        <select class="sel" aria-label="Asunto del mensaje">${['<option value="">Mensaje general</option>', ...data.requests.map((r) => `<option value="${r.id}" ${r.id === ctx ? 'selected' : ''}>Sobre: ${esc(TYPE_LABEL[r.type] || r.type)}</option>`)].join('')}</select>
        <textarea rows="2" placeholder="Escribe al huésped… (Enter envía, Mayús+Enter salto de línea)">${esc(draft)}</textarea>
        <button class="btn primary" type="submit">${icon('send')} Enviar</button>
      </form>`;
    const msgs = pane.querySelector('[data-msgs]');
    msgs.scrollTop = msgs.scrollHeight;
  } catch (err) {
    if (err.status === 404) state.chatKey = null;
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-open-chat]');
  if (!b) return;
  state.chatKey = b.dataset.openChat;
  state.chat = null;
  refreshChat().then(refreshChatList).then(paintChatList);
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-chat-form]');
  if (!form) return;
  e.preventDefault();
  const ta = form.querySelector('textarea');
  const body = ta.value.trim();
  if (!body) return;
  const requestId = form.querySelector('select').value || undefined;
  try {
    await api(`/staff/chats/${encodeURIComponent(state.chatKey)}`, { method: 'POST', body: { body, requestId } });
    ta.value = '';
    state.chat = null;
    await refreshChat();
    await refreshChatList();
    paintChatList();
    document.querySelector('[data-chat-form] textarea')?.focus();
  } catch (err) {
    toast(err.message, 'err');
  }
});
document.addEventListener('keydown', (e) => {
  const ta = e.target.closest('[data-chat-form] textarea');
  if (ta && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ta.form.requestSubmit();
  }
});

shell();
refresh();
setInterval(refresh, 5000);
