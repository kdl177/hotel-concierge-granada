/**
 * Production entry: one Node process serving the built pages (dist/), the
 * concierge API and the map/route proxies of the base project.
 *
 *   npm run build && node server/app/main.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';
import compression from 'compression';
import { loadEnv } from 'vite';
import { createConciergeApp } from './index.js';
import { localProviderPlugins } from '../providers/local.js';
import { googleRoutesProxy } from '../providers/googleRoutes.js';
import { geocodeProxy } from '../providers/regional/place.js';
import {
  googlePlacesContextProxy,
  installRouteMiddleware,
} from '../providers/places.js';
import { createLimiter, limit, clientIp } from './security.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const [k, v] of Object.entries(loadEnv('production', root, '')))
  if (process.env[k] === undefined) process.env[k] = v;
process.env.NODE_ENV ||= 'production';

const { app: concierge } = createConciergeApp();
const app = express();
app.disable('x-powered-by');
// gzip/deflate for pages, JS and JSON (Cesium alone is ~5 MB uncompressed).
app.use(compression({ threshold: 1024 }));
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, uniquelocal');
app.use(concierge);

// Map/route proxies of the base project speak the connect middleware API, so
// they mount on Express as-is. By default only what the concierge uses is
// published (walking/bike routes, geocoding, place search, transit fallback):
// the God's Eye View console and its ~35 endpoints (OpenAI, OpenSky, Street
// View…) stay off in production unless CONCIERGE_CONSOLE=1. Nothing is deleted.
const consoleEnabled = process.env.CONCIERGE_CONSOLE === '1';
const httpServer = createServer(app);
const fakeServer = {
  middlewares: app,
  httpServer,
  config: { root },
  restart: async () =>
    console.warn('[concierge] restart the process to apply new keys'),
};
const providerLimiter = createLimiter({
  windowMs: 60_000,
  max: parseInt(process.env.PROVIDER_RATE_PER_MIN, 10) || 60,
});
app.use(
  ['/api/route', '/api/geocode', '/api/google'],
  limit(providerLimiter, clientIp, 'too many map requests, wait a moment'),
);
if (!consoleEnabled) installRouteMiddleware(app);
const plugins = consoleEnabled
  ? [...localProviderPlugins(), googleRoutesProxy()]
  : [geocodeProxy(), googlePlacesContextProxy(), googleRoutesProxy()];
for (const plugin of plugins) {
  try {
    (plugin.configurePreviewServer || plugin.configureServer)?.(fakeServer);
  } catch (error) {
    console.warn(
      `[concierge] provider ${plugin.name} not mounted:`,
      error?.message,
    );
  }
}
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

const dist = path.join(root, 'dist');
if (!existsSync(dist)) {
  console.error('[concierge] dist/ not found — run `npm run build` first');
  process.exit(1);
}
// Hashed assets are immutable; HTML is revalidated so deploys show up at once.
app.use(
  '/assets',
  express.static(path.join(dist, 'assets'), {
    maxAge: '1y',
    immutable: true,
    fallthrough: true,
  }),
);
app.use(
  express.static(dist, {
    maxAge: '1h',
    index: 'index.html',
    extensions: ['html'],
    setHeaders: (res, file) =>
      file.endsWith('.html') && res.setHeader('Cache-Control', 'no-cache'),
  }),
);
// SPA fallback (Express 5 has no '*' route): any other GET serves the guest app.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (!consoleEnabled && /^\/console(\.html)?$/.test(req.path))
    return res.status(404).send('Not found');
  // Unknown files (with an extension) are real 404s, not the app page.
  if (/\.[a-z0-9]{2,5}$/i.test(req.path))
    return res.status(404).send('Not found');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(dist, 'index.html'));
});

const port = parseInt(process.env.PORT, 10) || 4180;
const host = process.env.HOST || '0.0.0.0';
httpServer.listen(port, host, () =>
  console.log(`[concierge] listening on http://${host}:${port}`),
);
