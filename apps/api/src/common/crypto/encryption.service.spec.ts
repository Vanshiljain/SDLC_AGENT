import { randomBytes } from 'node:crypto';
import { EncryptionService, EnvSecretsProvider } from './encryption.service';

const key = () => randomBytes(32).toString('base64');

describe('EncryptionService', () => {
  const k1 = key();
  const k2 = key();
  const v1 = new EncryptionService(new EnvSecretsProvider(`1:${k1}`));
  const v12 = new EncryptionService(new EnvSecretsProvider(`1:${k1},2:${k2}`));

  it('round-trips with associated data and never emits plaintext', () => {
    const enc = v1.encrypt('ghp_supersecret', 'integration-1');
    expect(enc.ciphertext).not.toContain('supersecret');
    expect(v1.decrypt(enc, 'integration-1')).toBe('ghp_supersecret');
  });

  it('uses a fresh IV for every encryption', () => {
    expect(v1.encrypt('same').ciphertext).not.toBe(v1.encrypt('same').ciphertext);
  });

  it('rejects ciphertext bound to a different record (associated data mismatch)', () => {
    const enc = v1.encrypt('token', 'integration-1');
    expect(() => v1.decrypt(enc, 'integration-2')).toThrow();
  });

  it('detects tampering', () => {
    const enc = v1.encrypt('token');
    const raw = Buffer.from(enc.ciphertext, 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => v1.decrypt({ ...enc, ciphertext: raw.toString('base64') })).toThrow();
  });

  it('supports key rotation: decrypts old versions, encrypts with the newest', () => {
    const old = v1.encrypt('rotate-me');
    expect(old.keyVersion).toBe(1);
    expect(v12.decrypt(old)).toBe('rotate-me');
    expect(v12.needsRotation(old)).toBe(true);
    expect(v12.encrypt('x').keyVersion).toBe(2);
  });

  it('validates key specifications', () => {
    expect(() => new EnvSecretsProvider('')).toThrow();
    expect(() => new EnvSecretsProvider('1:short')).toThrow(/32 bytes/);
    expect(() => new EnvSecretsProvider(`x:${key()}`)).toThrow();
  });

  it('compares secrets in constant time semantics', () => {
    expect(EncryptionService.safeEqual('abc', 'abc')).toBe(true);
    expect(EncryptionService.safeEqual('abc', 'abd')).toBe(false);
    expect(EncryptionService.safeEqual('abc', 'abcd')).toBe(false);
  });
});
