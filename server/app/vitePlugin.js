/** Mount the concierge API (Express) inside the Vite dev/preview server. */
import { createConciergeApp } from './index.js';

export function conciergeApiPlugin() {
  let instance = null;
  function install(server) {
    instance ||= createConciergeApp();
    server.middlewares.use(instance.app);
  }
  return {
    name: 'concierge-api',
    configureServer: install,
    configurePreviewServer: install,
  };
}
