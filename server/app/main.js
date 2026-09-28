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
import { loadEnv } from 'vite';
import { createConciergeApp } from './index.js';
import { localProviderPlugins } from '../providers/local.js';
import { googleRoutesProxy } from '../providers/googleRoutes.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const [k, v] of Object.entries(loadEnv('production', root, ''))) if (process.env[k] === undefined) process.env[k] = v;
process.env.NODE_ENV ||= 'production';

const { app: concierge } = createConciergeApp();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(concierge);

// Base-project proxies (OSRM routes, Google Places, Nominatim…) speak the
// connect middleware API, so they mount on Express as-is.
const httpServer = createServer(app);
const fakeServer = { middlewares: app, httpServer, config: { root } };
for (const plugin of [...localProviderPlugins(), googleRoutesProxy()]) {
  try {
    (plugin.configurePreviewServer || plugin.configureServer)?.(fakeServer);
  } catch (error) {
    console.warn(`[concierge] provider ${plugin.name} not mounted:`, error?.message);
  }
}
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

const dist = path.join(root, 'dist');
if (!existsSync(dist)) {
  console.error('[concierge] dist/ not found — run `npm run build` first');
  process.exit(1);
}
app.use(express.static(dist, { maxAge: '1h', index: 'index.html', extensions: ['html'] }));
// SPA fallback (Express 5 has no '*' route): any other GET serves the guest app.
app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));

const port = parseInt(process.env.PORT, 10) || 4180;
const host = process.env.HOST || '0.0.0.0';
httpServer.listen(port, host, () => console.log(`[concierge] listening on http://${host}:${port}`));
