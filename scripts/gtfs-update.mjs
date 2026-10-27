#!/usr/bin/env node
/**
 * Downloads the latest GTFS timetables from nap.transportes.gob.es into data/gtfs.
 *
 *   npm run gtfs:update
 *
 * Reads NAP_API_KEY (and optional GTFS_NAP_FILES, CONCIERGE_GTFS_DIR) from .env
 * or the environment. A running server picks the new files up at its next
 * automatic check, or press "Recargar horarios" in Admin → Hotel.
 */
import path from 'node:path';
import { loadEnv } from 'vite';
import { updateFeeds, DEFAULT_FILES } from '../server/app/gtfs-update.js';

const env = { ...loadEnv('production', process.cwd(), ''), ...process.env };
if (!env.NAP_API_KEY) {
  console.error('NAP_API_KEY is not set. Create a free account at https://nap.transportes.gob.es, copy your ApiKey and add NAP_API_KEY=… to .env');
  process.exit(1);
}
const dir = env.CONCIERGE_GTFS_DIR || path.resolve('data/gtfs');
const report = await updateFeeds({ dir, apiKey: env.NAP_API_KEY, files: env.GTFS_NAP_FILES || DEFAULT_FILES, log: console.log });
const bad = report.filter((r) => r.status === 'error');
console.log(`\n${report.length - bad.length}/${report.length} feeds ok in ${dir}` + (bad.length ? ` — failed: ${bad.map((r) => `${r.name} (${r.reason})`).join(', ')}` : ''));
process.exit(bad.length ? 1 : 0);
