import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Field-level encryption for PHI at rest (AES-256-GCM) plus keyed "blind
 * indexes" (HMAC-SHA256) so we can look a patient up by phone/email without
 * storing the value in clear text. Both sub-keys are derived from one 32-byte
 * master key with HKDF, so operators only manage a single secret.
 */
export class Vault {
  private readonly encKey: Buffer;
  private readonly idxKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('Encryption key must be exactly 32 bytes');
    this.encKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'slotback/enc/v1', 32));
    this.idxKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'slotback/idx/v1', 32));
  }

  /** `aad` binds the ciphertext to its row (e.g. `patients:pat_123`) so values cannot be swapped between rows. */
  encrypt(plaintext: string, aad = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
  }

  decrypt(token: string, aad = ''): string {
    if (!token.startsWith('v1.')) throw new Error('Unsupported ciphertext version');
    const buf = Buffer.from(token.slice(3), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown, aad = ''): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(token: string, aad = ''): T {
    return JSON.parse(this.decrypt(token, aad)) as T;
  }

  blindIndex(value: string): string {
    return createHmac('sha256', this.idxKey).update(value).digest('base64url');
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

export function passwordProblems(password: string): string | undefined {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 256) return 'Password is too long.';
  if (/^(.)\1+$/.test(password)) return 'Password is too repetitive.';
  return undefined;
}

// --------------------------------------------------------------------- TOTP

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) – what every authenticator app supports. */
export function totpCode(secret: string, at: number = Date.now(), step = 30): string {
  const counter = Math.floor(at / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(bin).padStart(6, '0');
}

export function verifyTotp(secret: string, code: string, at: number = Date.now()): boolean {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  for (const drift of [-1, 0, 1]) {
    if (safeEqual(totpCode(secret, at + drift * 30000), clean)) return true;
  }
  return false;
}

export function totpUri(secret: string, account: string, issuer = 'Slotback'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
