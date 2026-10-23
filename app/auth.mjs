import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 14;
export const SESSION_COOKIE = 'masar_session';

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, cost, saltHex, keyHex] = stored.split('$');
  if (algorithm !== 'scrypt' || cost !== '16384' || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(keyHex)) {
    return false;
  }
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, Buffer.from(keyHex, 'hex'));
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function sessionExpiry() {
  return Date.now() + SESSION_DURATION_MS;
}

export function sessionCookie(token, secure) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function expiredSessionCookie(secure) {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}
