import { createGlobe } from './globe.js';
import { createUi } from './ui.js';
import { t, getLang, setLang } from './i18n.js';
import { loadConfig, loadRoom, setContext } from './services.js';

document.documentElement.lang = getLang();
// Hide icon ligature words until the symbol font is in; show them even if it never loads (offline kiosk).
document.fonts?.load('24px "Material Symbols Rounded"').then(() => document.body.classList.add('icons-ready')).catch(() => {});
setTimeout(() => document.body.classList.add('icons-ready'), 3000);
const loader = document.getElementById('cg-loading');
const status = loader.querySelector('.status');
status.textContent = t('loadingGlobe');

async function start() {
  const params = new URLSearchParams(location.search);
  const slug = params.get('h') || 'default';
  const config = await loadConfig(slug);
  const HOTEL = config.hotel;
  HOTEL.welcomeView = { height: 900, heading: 35, pitch: -38, ...(HOTEL.welcomeView || {}) };
  document.title = `${HOTEL.name} · Concierge`;
  let room = null;
  const roomToken = params.get('r') || '';
  if (roomToken) {
    const found = await loadRoom(slug, roomToken);
    if (found) {
      room = { ...found.room, stay: found.stay };
      if (found.stay?.lang && !localStorage.getItem('concierge.lang')) setLang(found.stay.lang);
    }
  }
  setContext({ slug: HOTEL.slug, hotel: HOTEL, pois: config.pois, roomToken: room ? roomToken : '' });
  const globe = await createGlobe({
    container: 'cesiumContainer',
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  });
  globe.setHome({ lat: HOTEL.lat, lon: HOTEL.lon, ...HOTEL.welcomeView });
  createUi({ root: document.getElementById('cg-app'), globe, config, room });
  loader.classList.add('hide');
  setTimeout(() => loader.remove(), 600);
  // Gentle intro: settle onto the hotel from slightly higher up.
  globe.flyTo({ lat: HOTEL.lat, lon: HOTEL.lon, ...HOTEL.welcomeView, duration: 2.5 });
  window.__concierge = { globe, config };
}

start().catch((error) => {
  console.error('Concierge failed to start:', error);
  status.textContent = `Error: ${error?.message || error}`;
  status.style.color = '#ff6b6b';
});
