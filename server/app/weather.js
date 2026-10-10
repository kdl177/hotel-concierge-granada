/**
 * Local weather for a hotel from Open-Meteo (free, no key). Cached per hotel
 * for 15 minutes so every guest opening the app costs at most one upstream call.
 *
 *   GET /api/h/:slug/weather → { current, today, hours[], flags }
 */
const TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 8000;
const RAIN_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99,
]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

export function shapeForecast(data, now = new Date()) {
  const c = data?.current ?? {};
  const d = data?.daily ?? {};
  const h = data?.hourly ?? {};
  const nowMs = now.getTime();
  const hours = [];
  for (let i = 0; i < (h.time?.length || 0); i++) {
    const ms =
      Date.parse(`${h.time[i]}:00Z`) - (data.utc_offset_seconds || 0) * 1000;
    if (ms < nowMs - 3600_000) continue;
    hours.push({
      time: h.time[i],
      temp: h.temperature_2m?.[i],
      code: h.weather_code?.[i],
      pop: h.precipitation_probability?.[i] ?? 0,
    });
    if (hours.length >= 12) break;
  }
  const code = c.weather_code;
  const next3Pop = Math.max(0, ...hours.slice(0, 3).map((x) => x.pop || 0));
  const sunsetIso = d.sunset?.[0] || null;
  const sunsetMs = sunsetIso
    ? Date.parse(`${sunsetIso}:00Z`) - (data.utc_offset_seconds || 0) * 1000
    : null;
  const minutesToSunset = sunsetMs
    ? Math.round((sunsetMs - nowMs) / 60000)
    : null;
  const temp = c.temperature_2m;
  return {
    current: {
      temp,
      feels: c.apparent_temperature,
      code,
      isDay: !!c.is_day,
      wind: c.wind_speed_10m,
      precip: c.precipitation ?? 0,
    },
    today: {
      max: d.temperature_2m_max?.[0],
      min: d.temperature_2m_min?.[0],
      sunrise: d.sunrise?.[0] || null,
      sunset: sunsetIso,
      pop: d.precipitation_probability_max?.[0] ?? 0,
    },
    hours,
    flags: {
      rain: RAIN_CODES.has(code) || next3Pop >= 55,
      snow: SNOW_CODES.has(code),
      hot: Number.isFinite(temp) && temp >= 32,
      cold: Number.isFinite(temp) && temp <= 7,
      minutesToSunset,
      golden:
        minutesToSunset !== null &&
        minutesToSunset > 0 &&
        minutesToSunset <= 120,
    },
  };
}

export function createWeather({ fetchImpl = (...a) => fetch(...a) } = {}) {
  const cache = new Map(); // hotelId -> { at, data, pending }

  async function forHotel(h) {
    const hit = cache.get(h.id);
    if (hit?.data && Date.now() - hit.at < TTL_MS) return hit.data;
    if (hit?.pending) return hit.pending;
    // After a failure, wait before asking the upstream again (no retry storm).
    if (!hit?.data && hit?.failedAt && Date.now() - hit.failedAt < 120_000)
      throw new Error('weather unavailable (cooling down)');
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude: h.lat.toFixed(4),
      longitude: h.lon.toFixed(4),
      current:
        'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,precipitation',
      hourly: 'temperature_2m,weather_code,precipitation_probability',
      daily:
        'temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max',
      timezone: 'auto',
      forecast_days: '2',
    }).toString();
    const pending = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'hotel-concierge' },
        });
        if (!res.ok) throw new Error(`open-meteo ${res.status}`);
        const data = shapeForecast(await res.json());
        cache.set(h.id, { at: Date.now(), data });
        return data;
      } catch (error) {
        cache.set(h.id, {
          at: hit?.at || 0,
          data: hit?.data || null,
          failedAt: Date.now(),
        });
        if (hit?.data) return hit.data; // stale beats nothing
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    cache.set(h.id, { ...(hit || {}), pending });
    return pending;
  }

  function mount(app, { hotelBySlug }) {
    app.get('/h/:slug/weather', async (req, res) => {
      const h = hotelBySlug.get(req.params.slug);
      if (!h) return res.status(404).json({ error: 'hotel not found' });
      try {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json(await forHotel(h));
      } catch {
        // Optional widget: answer 200 so the guest app simply hides it (no console error).
        res.setHeader('Cache-Control', 'public, max-age=120');
        res.json({ available: false });
      }
    });
  }
  return { mount, forHotel };
}
