import { createGlobe } from './globe.js';
import { createUi } from './ui.js';
import { HOTEL } from './data/hotel.js';
import { t, getLang } from './i18n.js';

document.documentElement.lang = getLang();
const loader = document.getElementById('cg-loading');
const status = loader.querySelector('.status');
status.textContent = t('loadingGlobe');

async function start() {
  const globe = await createGlobe({
    container: 'cesiumContainer',
    googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  });
  globe.setHome({ lat: HOTEL.lat, lon: HOTEL.lon, ...HOTEL.welcomeView });
  createUi({ root: document.getElementById('cg-app'), globe });
  loader.classList.add('hide');
  setTimeout(() => loader.remove(), 600);
  // Gentle intro: settle onto the hotel from slightly higher up.
  globe.flyTo({ lat: HOTEL.lat, lon: HOTEL.lon, ...HOTEL.welcomeView, duration: 2.5 });
  window.__concierge = { globe };
}

start().catch((error) => {
  console.error('Concierge failed to start:', error);
  status.textContent = `Error: ${error?.message || error}`;
  status.style.color = '#ff6b6b';
});
