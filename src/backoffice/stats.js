/**
 * Admin → Estadísticas. Plain HTML/SVG charts following the dataviz method:
 * KPI tiles for headline numbers, single-hue bars for magnitude (no legend:
 * one series, the title names it), emphasis for the peak hour, hover tooltips
 * and a table view under every chart.
 */
import { api, esc, TYPE_LABEL } from './common.js';

const MODE_LABEL = { walk: 'A pie', transit: 'Transporte público', bike: 'Bicicleta' };
const LANG_LABEL = { es: 'Español', en: 'Inglés', fr: 'Francés', de: 'Alemán' };
let tip;

export async function renderStats(m, { hotel }) {
  const days = Number(localStorage.getItem('bo.statsDays')) || 30;
  m.innerHTML = `<div class="toolbar"><h2>Estadísticas</h2>
    <div class="filters" role="group" aria-label="Periodo">${[7, 30, 90, 365]
      .map((d) => `<button data-days="${d}" class="${d === days ? 'on' : ''}">${d === 365 ? '12 meses' : `${d} días`}</button>`)
      .join('')}</div></div><div data-stats><p class="muted">Cargando…</p></div>`;
  m.querySelectorAll('[data-days]').forEach((b) =>
    b.addEventListener('click', () => {
      localStorage.setItem('bo.statsDays', b.dataset.days);
      renderStats(m, { hotel });
    }),
  );
  const [data, config, pois] = await Promise.all([
    api(`/admin/stats?days=${days}`),
    api(`/h/${encodeURIComponent(hotel?.slug || 'default')}/config`).catch(() => ({ actions: [] })),
    api('/admin/pois').catch(() => ({ items: [] })),
  ]);
  const typeName = (k) => config.actions.find((a) => a.key === k)?.name?.es || TYPE_LABEL[k] || k;
  const poiName = (k) => pois.items.find((p) => p.key === k)?.name?.es || k;
  const k = data.kpis;
  const pct = k.requests ? Math.round((k.confirmed / k.requests) * 100) : null;
  const resp = k.medianResponseMin === null ? '—' : k.medianResponseMin < 1 ? '< 1 min' : k.medianResponseMin < 90 ? `${Math.round(k.medianResponseMin)} min` : `${(k.medianResponseMin / 60).toFixed(1)} h`;
  const peak = data.byHour.reduce((a, b) => (b.n > a.n ? b : a), { k: null, n: 0 });

  const box = m.querySelector('[data-stats]');
  box.innerHTML = `
    <div class="kpis">
      ${kpi('Aperturas de la app', fmtN(k.opens))}
      ${kpi('Solicitudes', fmtN(k.requests), k.pending ? `${k.pending} pendientes` : '')}
      ${kpi('Confirmadas o hechas', pct === null ? '—' : `${pct}%`, k.rejected ? `${k.rejected} no disponibles` : '')}
      ${kpi('Tiempo de respuesta', resp, 'mediana hasta la primera respuesta')}
      ${kpi('Conversaciones de chat', fmtN(k.chats))}
    </div>
    <div class="charts">
      ${chartCard('Aperturas de la app por día', columns(fillDays(data.opensByDay, data.days), { label: (d) => d.k.slice(5).split('-').reverse().join('/'), unit: 'aperturas' }), table(data.opensByDay, 'Día', 'Aperturas'))}
      ${chartCard(`Solicitudes por hora del día${peak.n ? ` · pico a las ${peak.k}:00` : ''}`, columns(data.byHour, { label: (d) => String(d.k), every: 3, emphasize: peak.n ? peak.k : null, unit: 'solicitudes' }), table(data.byHour.filter((h) => h.n), 'Hora', 'Solicitudes'))}
      ${chartCard('Solicitudes por tipo', hbars(data.byType, typeName, 'solicitudes'), table(data.byType, 'Tipo', 'Solicitudes', typeName))}
      ${chartCard('Lugares más consultados', hbars(data.topPois, poiName, 'vistas'), table(data.topPois, 'Lugar', 'Vistas', poiName))}
      ${chartCard('Cómo planean llegar', hbars(data.routeModes, (x) => MODE_LABEL[x] || x, 'rutas'), table(data.routeModes, 'Modo', 'Rutas', (x) => MODE_LABEL[x] || x))}
      ${chartCard('Idioma de los huéspedes', hbars(data.langs, (x) => LANG_LABEL[x] || x, 'aperturas'), table(data.langs, 'Idioma', 'Aperturas', (x) => LANG_LABEL[x] || x))}
      ${chartCard('Búsquedas más frecuentes', data.searches.length ? `<ol class="rank">${data.searches.map((s) => `<li><span>${esc(s.k)}</span><b>${fmtN(s.n)}</b></li>`).join('')}</ol>` : empty(), '')}
    </div>
    <p class="muted small">Datos anónimos: la app no envía nombre, habitación ni identificador del huésped en estas métricas.</p>`;
  bindTooltips(box);
}

const fmtN = (n) => Number(n || 0).toLocaleString('es-ES');
const kpi = (label, value, sub = '') => `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}</div>`;
const empty = () => '<p class="muted chart-empty">Sin datos en este periodo.</p>';
const chartCard = (title, body, tableHtml) => `<section class="chart-card"><h3>${esc(title)}</h3>${body}${tableHtml ? `<details class="chart-table"><summary>Ver datos</summary>${tableHtml}</details>` : ''}</section>`;

function table(rows, a, b, name = (x) => x) {
  if (!rows.length) return '';
  return `<table class="table"><thead><tr><th>${esc(a)}</th><th class="right">${esc(b)}</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${esc(name(r.k))}</td><td class="right">${fmtN(r.n)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function fillDays(rows, days) {
  const byK = new Map(rows.map((r) => [r.k, r.n]));
  const out = [];
  const n = Math.min(days, 90);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ k: key, n: byK.get(key) || 0 });
  }
  return out;
}

/** Vertical columns from one baseline; optional emphasis on one category. */
function columns(rows, { label, every = 0, emphasize = null, unit }) {
  if (!rows.some((r) => r.n)) return empty();
  const W = 440, H = 170, top = 10, bottom = 20, left = 28;
  const max = niceMax(Math.max(...rows.map((r) => r.n)));
  const band = (W - left) / rows.length;
  const bw = Math.min(24, Math.max(3, band - 2)); // ≤24px, 2px air between bars
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const labelEvery = every || Math.ceil(rows.length / 7);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)}">
    ${ticks.map((t) => `<line class="grid" x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${left - 6}" y="${y(t) + 3}" text-anchor="end">${fmtN(t)}</text>`).join('')}
    ${rows
      .map((r, i) => {
        const x = left + i * band + (band - bw) / 2;
        const h = Math.max(0, y(0) - y(r.n));
        const cls = emphasize === null ? 'bar' : r.k === emphasize ? 'bar' : 'bar muted';
        const bar = h > 0 ? `<path class="${cls}" d="${roundTop(x, y(r.n), bw, h)}"/>` : '';
        const hit = `<rect class="hit" x="${left + i * band}" y="${top}" width="${band}" height="${H - top - bottom}" data-tip="${esc(`${label(r)} · ${fmtN(r.n)} ${unit}`)}"/>`;
        const lab = i % labelEvery === 0 ? `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(label(r))}</text>` : '';
        return bar + lab + hit;
      })
      .join('')}
    <line class="baseline" x1="${left}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>
  </svg>`;
}

/** Horizontal bars, sorted high→low, value labelled at the bar end. */
function hbars(rows, name, unit) {
  if (!rows.length) return empty();
  const max = Math.max(...rows.map((r) => r.n));
  return `<div class="hbars">${rows
    .slice(0, 10)
    .map(
      (r) => `<div class="hbar" data-tip="${esc(`${name(r.k)} · ${fmtN(r.n)} ${unit}`)}">
        <span class="hbar-label">${esc(name(r.k))}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(1.5, (r.n / max) * 100)}%"></span></span>
        <span class="hbar-value">${fmtN(r.n)}</span></div>`,
    )
    .join('')}</div>`;
}

const niceMax = (v) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return v;
};
/** Column with a 4px rounded data end, square at the baseline. */
function roundTop(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function bindTooltips(root) {
  tip ||= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'chart-tip', hidden: true });
  root.addEventListener('pointermove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return (tip.hidden = true);
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 12)}px`;
    tip.style.top = `${e.clientY - 34}px`;
  });
  root.addEventListener('pointerleave', () => (tip.hidden = true));
}
