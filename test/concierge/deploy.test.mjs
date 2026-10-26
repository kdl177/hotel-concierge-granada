// Deployment kit: the installer must produce a working .env without touching
// Docker, and the compose/Caddy/Dockerfile trio must agree with each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, statSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const root = path.resolve(import.meta.dirname, '../..');
// The shell scripts need bash (any VPS has it; the Windows CI job skips these).
const bash = process.platform === 'win32' ? 'needs bash' : false;
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const env = (dir) => Object.fromEntries(
  readFileSync(path.join(dir, '.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'concierge-deploy-'));
  for (const f of ['docker-compose.yml', '.env.example', 'deploy']) cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
  mkdirSync(path.join(dir, 'server/app'), { recursive: true });
  writeFileSync(path.join(dir, 'server/app/main.js'), '');
  return dir;
}
const install = (dir, vars) =>
  execFileSync('bash', ['deploy/install.sh'], { cwd: dir, env: { ...process.env, DRY_RUN: '1', ...vars }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

test('install.sh (dry run) writes a complete production .env and prints the one-time password', { skip: bash }, () => {
  const dir = scratch();
  try {
    const out = install(dir, { DOMAIN: 'https://concierge.hotel.com/' });
    const e = env(dir);
    assert.equal(e.DOMAIN, 'concierge.hotel.com');
    assert.equal(e.PUBLIC_URL, 'https://concierge.hotel.com');
    assert.equal(e.NODE_ENV, 'production');
    assert.ok(e.CONCIERGE_SECRET.length >= 48, 'long random secret');
    assert.ok(e.ADMIN_PASSWORD.length >= 12, 'random admin password');
    assert.match(out, new RegExp(`Temporary password .*: ${e.ADMIN_PASSWORD}`));
    assert.match(out, /https:\/\/concierge\.hotel\.com\/admin\.html/);
    assert.equal(statSync(path.join(dir, '.env')).mode & 0o777, 0o600, '.env is private');
    assert.doesNotMatch(out, /docker compose up -d --build\n(?!.*dry-run)/, 'no real docker call in dry run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install.sh is idempotent: a second run keeps the secret and password, updates the domain', { skip: bash }, () => {
  const dir = scratch();
  try {
    install(dir, { DOMAIN: 'a.example.com' });
    const first = env(dir);
    const out = install(dir, { DOMAIN: 'b.example.com' });
    const second = env(dir);
    assert.equal(second.CONCIERGE_SECRET, first.CONCIERGE_SECRET);
    assert.equal(second.ADMIN_PASSWORD, first.ADMIN_PASSWORD);
    assert.equal(second.DOMAIN, 'b.example.com');
    assert.equal(second.PUBLIC_URL, 'https://b.example.com');
    assert.match(out, /Password: the one already in/);
    assert.equal(readFileSync(path.join(dir, '.env'), 'utf8').match(/^DOMAIN=/gm).length, 1, 'no duplicated keys');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compose, Caddyfile and Dockerfile agree (port, domain variable, health URL)', () => {
  const compose = read('docker-compose.yml');
  const caddy = read('deploy/Caddyfile');
  const docker = read('Dockerfile');
  assert.match(compose, /DOMAIN=\$\{DOMAIN/, 'compose passes DOMAIN from .env to Caddy');
  assert.match(caddy, /^\{\$DOMAIN\} \{/m, 'Caddy site block reads DOMAIN');
  assert.match(caddy, /reverse_proxy concierge:4180/);
  assert.match(docker, /EXPOSE 4180/);
  assert.match(compose, /\/api\/h\/default\/config/, 'health check hits the first hotel config');
  assert.match(docker, /\/api\/h\/default\/config/);
  if (!bash) for (const f of ['deploy/install.sh', 'deploy/backup.sh', 'deploy/update.sh', 'deploy/restore.sh']) execFileSync('bash', ['-n', path.join(root, f)]);
});
