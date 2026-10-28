import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) over HMAC-SHA1, the form every authenticator
 * app speaks. Nothing external is involved: the secret lives in the database, the clock
 * is this server's, and the person's phone does the rest.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretBase32: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function currentCounter(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Checks a code against the current step and one either side, to absorb clock drift
 * between the server and the phone. Returns the counter that matched, so a caller can
 * refuse to accept that same counter twice — a code is single use.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs = Date.now()): number | null {
  const given = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const centre = currentCounter(nowMs);
  for (const counter of [centre, centre - 1, centre + 1]) {
    const expected = totpCode(secretBase32, counter);
    if (expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
      return counter;
    }
  }
  return null;
}

export function otpauthUri(secretBase32: string, account: string, issuer = 'mcpbridge'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten one-shot codes for when the phone is gone; readable in groups, like "k7f3-2m9x". */
export function newRecoveryCodes(count = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
  });
}

export function normalizeRecoveryCode(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
