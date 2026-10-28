import assert from 'node:assert/strict';
import { test } from 'node:test';

import { base32Decode, base32Encode, newRecoveryCodes, normalizeRecoveryCode, otpauthUri, totpCode, verifyTotp } from '../src/totp.js';

// RFC 6238 appendix B: secret "12345678901234567890" (ASCII), SHA1, T=59 -> 94287082
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('matches the RFC 6238 SHA1 test vector', () => {
  assert.equal(totpCode(RFC_SECRET, 1), '287082');          // T=59          -> 94287082
  assert.equal(totpCode(RFC_SECRET, 37037036), '081804');   // T=1111111109  -> 07081804
  assert.equal(totpCode(RFC_SECRET, 37037037), '050471');   // T=1111111111  -> 14050471
  assert.equal(totpCode(RFC_SECRET, 41152263), '005924');   // T=1234567890  -> 89005924
  assert.equal(totpCode(RFC_SECRET, 66666666), '279037');   // T=2000000000  -> 69279037
});

test('base32 round-trips', () => {
  for (const len of [1, 5, 10, 20, 33]) {
    const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37) % 256));
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
});

test('verifies the current step and its neighbours, and nothing further', () => {
  const now = 59_000; // counter 1
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, 1), now), 1);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, 0), now), 0);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, 2), now), 2);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, 3), now), null);
  assert.equal(verifyTotp(RFC_SECRET, '12345', now), null);
  assert.equal(verifyTotp(RFC_SECRET, 'abc def', now), null);
});

test('tolerates a code typed with a space', () => {
  const code = totpCode(RFC_SECRET, 1);
  assert.equal(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, 59_000), 1);
});

test('builds an otpauth URI an authenticator app will scan', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'zee@example.com');
  assert.ok(uri.startsWith('otpauth://totp/mcpbridge%3Azee%40example.com?'));
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(uri, /issuer=mcpbridge/);
});

test('recovery codes are distinct and normalise however they are typed', () => {
  const codes = newRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0]!, /^[a-z0-9]{4}-[a-z0-9]{4}$/);
  assert.equal(normalizeRecoveryCode(' K7F3 - 2M9X '), 'k7f32m9x');
});
