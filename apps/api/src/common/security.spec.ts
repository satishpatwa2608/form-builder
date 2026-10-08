import { randomBytes } from 'node:crypto';
import { hashToken, SecretBox } from './crypto';
import { base32Decode, base32Encode, totpAt, verifyTotp } from './totp';

describe('TOTP (RFC 6238 SHA-1 test vectors)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('at T=%i the 8-digit code is %s', (t, code) => {
    expect(totpAt(secret, Math.floor(t / 30), 8)).toBe(code);
  });

  it('accepts the current step and one either side, nothing further or malformed', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpAt(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step + 2), now)).toBeNull();
    expect(verifyTotp(secret, '12ab56', now)).toBeNull();
  });

  it('base32 round-trips', () => {
    const buf = randomBytes(20);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32));

  it('round-trips, with a fresh IV each time', () => {
    const a = box.seal('JBSWY3DPEHPK3PXP');
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.seal('JBSWY3DPEHPK3PXP')).not.toBe(a);
    expect(box.open(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses anything tampered with, or sealed with another key', () => {
    const sealed = box.seal('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox(randomBytes(32)).open(sealed)).toThrow();
  });
});

it('tokens are stored as SHA-256 hex', () => {
  expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
});
