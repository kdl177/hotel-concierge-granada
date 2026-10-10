/**
 * Password hashing (scrypt) and signed cookie sessions (HMAC), no dependencies.
 */
import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const test = scryptSync(String(password), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && timingSafeEqual(test, ref);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());

export function createSessions({
  secret,
  ttlMs = 12 * 3600 * 1000,
  cookieName = 'hc_session',
}) {
  const sign = (payload) =>
    createHmac('sha256', secret).update(payload).digest('base64url');

  function issue(user) {
    const body = b64({
      uid: user.id,
      sv: user.session_version || 0,
      exp: Date.now() + ttlMs,
    });
    return `${body}.${sign(body)}`;
  }
  function read(tokenValue) {
    const [body, sig] = String(tokenValue || '').split('.');
    if (!body || !sig) return null;
    const expected = sign(body);
    if (
      expected.length !== sig.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
    )
      return null;
    try {
      const data = unb64(body);
      return data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  }
  function cookieFrom(req) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName) return decodeURIComponent(v.join('='));
    }
    return null;
  }
  function setCookie(res, value, { secure }) {
    const attrs = [
      `${cookieName}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(ttlMs / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  }
  function clearCookie(res) {
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  }
  return { issue, read, cookieFrom, setCookie, clearCookie };
}
