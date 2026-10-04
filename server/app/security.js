/**
 * Small, dependency-free security helpers: in-memory rate limiting, security
 * headers, same-origin check for state-changing API calls, and validators for
 * values that end up in HTML attributes or outbound requests.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** Sliding-window counter. `hit(key)` → { ok, retryAfterS }. */
export function createLimiter({ windowMs, max }) {
  const hits = new Map();
  let lastSweep = Date.now();
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, list] of hits) if (!list.length || now - list[list.length - 1] > windowMs) hits.delete(k);
  }
  function peek(key, now = Date.now()) {
    return (hits.get(key) || []).filter((t) => now - t < windowMs);
  }
  return {
    hit(key) {
      const now = Date.now();
      sweep(now);
      const list = peek(key, now);
      if (list.length >= max) return { ok: false, retryAfterS: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
      list.push(now);
      hits.set(key, list);
      return { ok: true, retryAfterS: 0 };
    },
    /** Count without recording (e.g. "is this email locked?"). */
    blocked(key) {
      const now = Date.now();
      const list = peek(key, now);
      return list.length >= max ? Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) : 0;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

/** Express middleware from a limiter; `keyFn(req)` picks the bucket. */
export function limit(limiter, keyFn, message = 'too many requests') {
  return (req, res, next) => {
    const r = limiter.hit(keyFn(req));
    if (r.ok) return next();
    res.setHeader('Retry-After', String(r.retryAfterS));
    res.status(429).json({ error: message, retryAfter: r.retryAfterS });
  };
}

export const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * Security headers for every response. The CSP allows what the 3D globe needs
 * (Cesium workers/wasm, Google/OSM/Cesium ion tiles, Google Fonts) and nothing
 * else executes: no inline scripts, no eval, no framing.
 */
export function securityHeaders({ production = false } = {}) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (production) {
      res.setHeader('Content-Security-Policy', csp);
      if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/**
 * Rejects cross-site state-changing requests (CSRF defence in depth on top of
 * SameSite=Lax cookies). Browsers send Sec-Fetch-Site / Origin on such calls.
 */
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return res.status(403).json({ error: 'cross-site request blocked' });
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {}
    const expected = req.headers['x-forwarded-host'] || req.headers.host;
    if (host && expected && host !== expected) return res.status(403).json({ error: 'cross-site request blocked' });
  }
  next();
}

// ---------- validators ----------
export const ICON_RE = /^[a-z0-9_]{1,40}$/;
export const safeIcon = (v, fallback) => (ICON_RE.test(String(v || '')) ? String(v) : fallback);
/** Phone numbers: digits, +, spaces, dashes, dots, parentheses. */
export const safePhone = (v) => String(v ?? '').replace(/[^0-9+()\-. ]/g, '').trim().slice(0, 40);
/** Only absolute http(s) URLs (or same-origin paths when allowPath). */
export function safeUrl(v, { allowPath = false, max = 400 } = {}) {
  const s = String(v ?? '').trim().slice(0, max);
  if (!s) return '';
  if (allowPath && /^\/(?!\/)[^\s"'<>]*$/.test(s)) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}
export const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/**
 * Outbound webhook targets: https only (http allowed outside production) and
 * never loopback/private/link-local hosts — checked on the resolved address
 * too, so DNS names pointing inside the network are refused (SSRF).
 */
export async function checkWebhookUrl(v, { production = process.env.NODE_ENV === 'production', resolve = lookup } = {}) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: true, url: '' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'invalid URL' };
  }
  if (!(u.protocol === 'https:' || (!production && u.protocol === 'http:'))) return { ok: false, error: 'webhook must use https' };
  if (u.username || u.password) return { ok: false, error: 'credentials in URL not allowed' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return { ok: false, error: 'private address not allowed' };
  if (net.isIP(host)) {
    if (privateIp(host)) return { ok: false, error: 'private address not allowed' };
  } else {
    try {
      const addrs = await resolve(host, { all: true });
      if (addrs.some((a) => privateIp(a.address))) return { ok: false, error: 'private address not allowed' };
    } catch {
      return { ok: false, error: 'host not found' };
    }
  }
  return { ok: true, url: u.href };
}
export { privateIp };
