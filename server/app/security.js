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
    for (const [k, list] of hits)
      if (!list.length || now - list[list.length - 1] > windowMs)
        hits.delete(k);
  }
  function peek(key, now = Date.now()) {
    return (hits.get(key) || []).filter((t) => now - t < windowMs);
  }
  return {
    hit(key) {
      const now = Date.now();
      sweep(now);
      const list = peek(key, now);
      if (list.length >= max)
        return {
          ok: false,
          retryAfterS: Math.max(
            1,
            Math.ceil((list[0] + windowMs - now) / 1000),
          ),
        };
      list.push(now);
      hits.set(key, list);
      return { ok: true, retryAfterS: 0 };
    },
    /** Count without recording (e.g. "is this email locked?"). */
    blocked(key) {
      const now = Date.now();
      const list = peek(key, now);
      return list.length >= max
        ? Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000))
        : 0;
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

export const clientIp = (req) =>
  req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * Security headers for every response. The CSP allows what the 3D globe needs
 * (Cesium workers/wasm, Google/OSM/Cesium ion tiles); fonts are self-hosted and nothing
 * else executes: no inline scripts, no eval, no framing.
 */
export function securityHeaders({ production = false } = {}) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
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
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(self), payment=()',
    );
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (production) {
      res.setHeader('Content-Security-Policy', csp);
      if (req.secure)
        res.setHeader(
          'Strict-Transport-Security',
          'max-age=31536000; includeSubDomains',
        );
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
  if (site === 'cross-site')
    return res.status(403).json({ error: 'cross-site request blocked' });
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {}
    const expected = req.headers['x-forwarded-host'] || req.headers.host;
    if (host && expected && host !== expected)
      return res.status(403).json({ error: 'cross-site request blocked' });
  }
  next();
}

// ---------- validators ----------
export const ICON_RE = /^[a-z0-9_]{1,40}$/;
export const safeIcon = (v, fallback) =>
  ICON_RE.test(String(v || '')) ? String(v) : fallback;
/** Phone numbers: digits, +, spaces, dashes, dots, parentheses. */
export const safePhone = (v) =>
  String(v ?? '')
    .replace(/[^0-9+()\-. ]/g, '')
    .trim()
    .slice(0, 40);
/** Only absolute http(s) URLs (or same-origin paths when allowPath). */
export function safeUrl(v, { allowPath = false, max = 400 } = {}) {
  const s = String(v ?? '')
    .trim()
    .slice(0, max);
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

/** Expands an IPv6 literal to 8 numbers (handles "::" and a trailing dotted IPv4). */
function ipv6Words(ip) {
  let v = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    v =
      v.slice(0, -dotted[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = v.includes('::') ? 8 - h.length - t.length : 0;
  const words = [...h, ...Array(fill).fill('0'), ...t].map((x) =>
    parseInt(x || '0', 16),
  );
  return words.length === 8 && words.every((x) => x >= 0 && x <= 0xffff)
    ? words
    : null;
}

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const w = ipv6Words(ip);
  if (!w) return true; // unparseable → refuse
  const v4 = () => `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
  const zero5 = w.slice(0, 5).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96) embed an IPv4 address.
  if (zero5 && (w[5] === 0xffff || w[5] === 0))
    return w[5] === 0 && w[6] === 0 && w[7] <= 1 ? true : privateIp(v4());
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0))
    return privateIp(v4());
  return (
    (w[0] & 0xfe00) === 0xfc00 ||
    (w[0] & 0xffc0) === 0xfe80 ||
    (w[0] & 0xff00) === 0xff00
  );
}

/**
 * Outbound webhook targets: https only (http allowed outside production) and
 * never loopback/private/link-local hosts — checked on the resolved address
 * too, so DNS names pointing inside the network are refused (SSRF).
 */
export async function checkWebhookUrl(
  v,
  { production = process.env.NODE_ENV === 'production', resolve = lookup } = {},
) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: true, url: '' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'invalid URL' };
  }
  if (!(u.protocol === 'https:' || (!production && u.protocol === 'http:')))
    return { ok: false, error: 'webhook must use https' };
  if (u.username || u.password)
    return { ok: false, error: 'credentials in URL not allowed' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal')
  )
    return { ok: false, error: 'private address not allowed' };
  if (net.isIP(host)) {
    if (privateIp(host))
      return { ok: false, error: 'private address not allowed' };
  } else {
    try {
      const addrs = await resolve(host, { all: true });
      if (addrs.some((a) => privateIp(a.address)))
        return { ok: false, error: 'private address not allowed' };
    } catch {
      return { ok: false, error: 'host not found' };
    }
  }
  return { ok: true, url: u.href };
}
export { privateIp };
