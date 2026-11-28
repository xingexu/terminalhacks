import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { requireCondition as check } from '../../packages/runtime/memory.mjs';

const deriveKey = promisify(scrypt);
const hashOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export function browserToken(request) {
  return (request.headers.cookie || '').split(';').map(field => field.trim())
    .find(field => field.startsWith('ew_session='))?.slice('ew_session='.length);
}

export function setBrowserCookie(request, reply, token) {
  const secure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
  reply.header('Set-Cookie', 'ew_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + (secure ? '; Secure' : ''));
}

export function registerAccountRoutes(app, store) {
  const attempts = new Map();
  const windowMs = 15 * 60_000;
  const dummySalt = randomBytes(16);
  let inFlight = 0;
  let nextCleanup = 0;

  function limitAttempts(ip) {
    const now = Date.now();
    if (now >= nextCleanup) {
      for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
      nextCleanup = now + windowMs;
    }
    let entry = attempts.get(ip);
    if (!entry || entry.until <= now) {
      entry = { count: 0, until: now + windowMs };
      attempts.set(ip, entry);
    }
    check(entry.count < 30, 429, 'AUTH_RATE_LIMIT', 'Too many attempts. Try again in 15 minutes.');
    entry.count++;
  }

  async function hashPassword(password, salt) {
    check(inFlight < 4, 429, 'AUTH_BUSY', 'The sign-in service is busy. Try again shortly.');
    inFlight++;
    try {
      return await deriveKey(password, salt, 64, hashOptions);
    } finally {
      inFlight--;
    }
  }

  const browserOnly = async req => {
    check(!req.headers.authorization, 403, 'BROWSER_REQUIRED', 'Manage your account from the Everwhere browser.');
    if (req.method === 'POST') {
      check(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 415, 'JSON_REQUIRED', 'Send this request as JSON.');
      check(req.headers['sec-fetch-site'] !== 'cross-site', 403, 'ORIGIN_DENIED', 'This request must come from Everwhere.');
    }
  };
  const options = { preHandler: browserOnly, bodyLimit: 4096 };
  const result = account => ({ ok: true, data: { account } });

  app.get('/v1/auth/session', options, async req => result(store.account(store.browser(browserToken(req))?.actor)));

  for (const action of ['register', 'login']) {
    app.post('/v1/auth/' + action, options, async (req, reply) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const password = req.body?.password;
      check(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
        400, 'INVALID_EMAIL', 'Enter a valid email address.');
      check(typeof password === 'string' && password.length > 0 && password.length <= 128,
        400, 'INVALID_PASSWORD', 'Enter a password of up to 128 characters.');
      const token = browserToken(req);
      let session;
      if (action === 'register') {
        check(password.length >= 12, 400, 'WEAK_PASSWORD', 'Use at least 12 characters for your password.');
        limitAttempts(req.ip);
        const salt = randomBytes(16);
        session = store.registerAccount(token, email, salt, await hashPassword(password, salt));
      } else {
        limitAttempts(req.ip);
        const credentials = store.credentials(email);
        const hash = await hashPassword(password, credentials?.salt ?? dummySalt);
        check(credentials && timingSafeEqual(hash, credentials.password_hash), 401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
        session = store.signIn(token, credentials.actor);
      }
      setBrowserCookie(req, reply, session.token);
      return result({ email });
    });
  }

  app.post('/v1/auth/logout', options, async (req, reply) => {
    const guest = store.signOut(browserToken(req));
    if (guest) setBrowserCookie(req, reply, guest.token);
    return result(null);
  });
}
