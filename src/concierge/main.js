import { createGlobe } from './globe.js';
import { createUi } from './ui.js';
import { t, getLang, setLang } from './i18n.js';
import { loadConfig, loadRoom, setContext } from './services.js';

document.documentElement.lang = getLang();
// Hide icon ligature words until the symbol font is in; show them even if it never loads (offline kiosk).
document.fonts
  ?.load('24px "Concierge Symbols"')
  .then(() => document.body.classList.add('icons-ready'))
  .catch(() => {});
setTimeout(() => document.body.classList.add('icons-ready'), 3000);
const loader = document.getElementById('cg-loading');
const status = loader.querySelector('.status');
status.textContent = t('loadingGlobe');

async function start() {
  const params = new URLSearchParams(location.search);
  const slug = params.get('h') || 'default';
  const config = await loadConfig(slug);
  const HOTEL = config.hotel;
  HOTEL.welcomeView = {
    height: 900,
    heading: 35,
    pitch: -38,
    ...(HOTEL.welcomeView || {}),
  };
  document.title = `${HOTEL.name} · Concierge`;
  loader.querySelector('.title').textContent = HOTEL.name;
  let room = null;
  const roomToken = params.get('r') || '';
  if (roomToken) {
    const found = await loadRoom(slug, roomToken);
    if (found) {
      room = { ...found.room, stay: found.stay };
      if (found.stay?.lang && !localStorage.getItem('concierge.lang'))
        setLang(found.stay.lang);
    }
  }
  setContext({
    slug: HOTEL.slug,
    hotel: HOTEL,
    pois: config.pois,
    roomToken: room ? roomToken : '',
  });
  const globe = await createGlobe({
    container: 'cesiumContainer',
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  });
  await globe.setHome({ lat: HOTEL.lat, lon: HOTEL.lon, ...HOTEL.welcomeView });
  const kiosk = params.get('kiosk') === '1' || params.get('k') === '1';
  const ui = createUi({
    root: document.getElementById('cg-app'),
    globe,
    config,
    room,
    kiosk,
  });
  if (kiosk) {
    document.documentElement.classList.add('kiosk');
    setupKiosk({
      ui,
      globe,
      HOTEL,
      idleS: Math.max(30, Number(params.get('idle')) || 120),
    });
  }
  const deep = params.get('p');
  if (deep) ui.openPoi?.(deep);
  loader.classList.add('hide');
  setTimeout(() => loader.remove(), 600);
  window.__concierge = { globe, config };
}

/**
 * Kiosk (lobby screen): after `idleS` seconds without touches the app shows an
 * attract screen with the hotel name, the clock and "tap to start", slowly
 * orbits the hotel, and forgets everything the previous guest did (plan,
 * requests, chat key, language). Any touch starts fresh.
 */
function setupKiosk({ ui, globe, HOTEL, idleS }) {
  const screen = document.createElement('div');
  screen.className = 'cg-attract';
  screen.hidden = true;
  screen.innerHTML = `<div class="cg-attract-inner">
    <div class="cg-attract-kicker">${HOTEL.city || ''}</div>
    <h1 class="cg-attract-title"></h1>
    <div class="cg-attract-clock" aria-hidden="true"></div>
    <div class="cg-attract-cta"></div>
    <div class="cg-attract-langs">ES · EN · FR · DE</div>
  </div>`;
  screen.querySelector('.cg-attract-title').textContent = HOTEL.name;
  document.body.appendChild(screen);
  const CTA = [
    'Toca para empezar',
    'Tap to start',
    'Touchez pour commencer',
    'Zum Starten tippen',
  ];
  let ctaIdx = 0;
  let timer = null;
  let clockTimer = null;
  let ctaTimer = null;
  let sleeping = false;

  function tickClock() {
    screen.querySelector('.cg-attract-clock').textContent =
      new Date().toLocaleTimeString(getLang(), {
        hour: '2-digit',
        minute: '2-digit',
      });
  }
  function sleep() {
    if (sleeping) return;
    sleeping = true;
    ui.reset?.();
    document.documentElement.classList.add('kiosk-sleep');
    screen.hidden = false;
    screen.querySelector('.cg-attract-cta').textContent = CTA[0];
    tickClock();
    clockTimer = setInterval(tickClock, 15_000);
    ctaTimer = setInterval(() => {
      ctaIdx = (ctaIdx + 1) % CTA.length;
      const el = screen.querySelector('.cg-attract-cta');
      el.classList.add('swap');
      setTimeout(() => {
        el.textContent = CTA[ctaIdx];
        el.classList.remove('swap');
      }, 250);
    }, 3200);
    globe.orbit({
      lat: HOTEL.lat,
      lon: HOTEL.lon,
      range: Math.max(700, HOTEL.welcomeView.height * 1.2),
    });
  }
  function wake() {
    if (!sleeping) return;
    sleeping = false;
    document.documentElement.classList.remove('kiosk-sleep');
    screen.hidden = true;
    clearInterval(clockTimer);
    clearInterval(ctaTimer);
    globe.stopOrbit();
    globe.flyTo({
      lat: HOTEL.lat,
      lon: HOTEL.lon,
      ...HOTEL.welcomeView,
      duration: 1.2,
    });
  }
  function touched() {
    clearTimeout(timer);
    timer = setTimeout(sleep, idleS * 1000);
    if (sleeping) wake();
  }
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
    document.addEventListener(ev, touched, { passive: true, capture: true });
  screen.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    touched();
  });
  // No text selection, no pinch-zoom, no context menu on a public screen.
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document
    .querySelector('meta[name=viewport]')
    ?.setAttribute(
      'content',
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
    );
  timer = setTimeout(sleep, idleS * 1000);
}

start().catch((error) => {
  console.error('Concierge failed to start:', error);
  status.textContent = t('startError');
  status.style.color = '#f07a63';
  const retry = document.createElement('button');
  retry.className = 'cg-btn';
  retry.style.width = 'auto';
  retry.textContent = t('retry');
  retry.addEventListener('click', () => location.reload());
  status.after(retry);
});
