import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';

/**
 * Secret management abstraction. The default provider reads versioned data
 * keys from ENCRYPTION_KEYS; a KMS/Vault-backed provider can replace it by
 * implementing SecretsProvider (keys never leave the provider in that case).
 */
export interface SecretsProvider {
  currentKeyVersion(): number;
  getKey(version: number): Buffer;
}

export const SECRETS_PROVIDER = Symbol('SECRETS_PROVIDER');

export class EnvSecretsProvider implements SecretsProvider {
  private readonly keys = new Map<number, Buffer>();
  private readonly current: number;

  constructor(spec: string) {
    for (const part of spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const idx = part.indexOf(':');
      if (idx < 1) throw new Error('ENCRYPTION_KEYS entries must be "<version>:<base64 key>"');
      const version = Number(part.slice(0, idx));
      const key = Buffer.from(part.slice(idx + 1), 'base64');
      if (!Number.isInteger(version) || version < 1) throw new Error(`Invalid encryption key version "${part.slice(0, idx)}"`);
      if (key.length !== 32) throw new Error(`Encryption key v${version} must decode to 32 bytes (got ${key.length})`);
      this.keys.set(version, key);
    }
    if (!this.keys.size) throw new Error('No encryption keys configured');
    this.current = Math.max(...this.keys.keys());
  }

  currentKeyVersion(): number {
    return this.current;
  }

  getKey(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Encryption key version ${version} is not available`);
    return key;
  }
}

export interface EncryptedValue {
  ciphertext: string;
  keyVersion: number;
}

/** AES-256-GCM authenticated encryption with key versioning (rotation-friendly). */
@Injectable()
export class EncryptionService {
  constructor(@Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider) {}

  encrypt(plaintext: string, associatedData?: string): EncryptedValue {
    const keyVersion = this.secrets.currentKeyVersion();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secrets.getKey(keyVersion), iv);
    if (associatedData) cipher.setAAD(Buffer.from(associatedData));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: Buffer.concat([iv, tag, ct]).toString('base64'), keyVersion };
  }

  decrypt(value: EncryptedValue, associatedData?: string): string {
    const raw = Buffer.from(value.ciphertext, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.secrets.getKey(value.keyVersion), iv);
    if (associatedData) decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown, associatedData?: string): EncryptedValue {
    return this.encrypt(JSON.stringify(value), associatedData);
  }

  decryptJson<T>(value: EncryptedValue, associatedData?: string): T {
    return JSON.parse(this.decrypt(value, associatedData)) as T;
  }

  /** True when a value was encrypted with an older key and should be re-encrypted. */
  needsRotation(value: EncryptedValue): boolean {
    return value.keyVersion !== this.secrets.currentKeyVersion();
  }

  static sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  static randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}

export function secretsProviderFactory(config: AppConfig): SecretsProvider {
  return new EnvSecretsProvider(config.encryptionKeys);
}
