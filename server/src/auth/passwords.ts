import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * scrypt password hashing (node:crypto). Format:
 *   scrypt$N$r$p$saltB64$hashB64
 * Parameters follow OWASP guidance for interactive logins. Hashing and
 * verification are asynchronous (libuv threadpool) so a burst of login
 * attempts cannot stall the event loop.
 */
const N = 1 << 15; // 32768
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { ...opts, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    const actual = await scryptAsync(password, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Fixed-parameter dummy hash used to equalize the work done for unknown
 * usernames, so login timing does not reveal whether an account exists.
 * The salt/hash are constants; the result of verifying against it is
 * always discarded.
 */
const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16, 7).toString('base64')}$${Buffer.alloc(
  KEYLEN,
  9,
).toString('base64')}`;

export async function verifyAgainstDummy(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}
