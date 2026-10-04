import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { googleRoutesProxy } from '../providers/googleRoutes.js';
import { conciergeApiPlugin } from '../app/vitePlugin.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const config = createBrowserViteConfig({
    plugins: [...localProviderPlugins(), googleRoutesProxy(), conciergeApiPlugin(), apiNotFoundPlugin()],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT || 4180,
    command,
  });
  config.build = {
    ...config.build,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('../../index.html', import.meta.url)),
        reception: fileURLToPath(new URL('../../reception.html', import.meta.url)),
        admin: fileURLToPath(new URL('../../admin.html', import.meta.url)),
        // The God's Eye View console is kept in the repo and in `npm run dev`;
        // it is only bundled for production when CONCIERGE_CONSOLE=1.
        ...(process.env.CONCIERGE_CONSOLE === '1' ? { console: fileURLToPath(new URL('../../console.html', import.meta.url)) } : {}),
      },
    },
  };
  config.preview = { host: process.env.HOST || 'localhost', port: parseInt(process.env.PORT, 10) || 4180 };
  return config;
});
