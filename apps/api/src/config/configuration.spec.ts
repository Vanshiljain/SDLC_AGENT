import { randomBytes } from 'node:crypto';
import { loadConfig } from './configuration';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')}`,
};

describe('loadConfig', () => {
  it('loads a minimal valid configuration with safe defaults', () => {
    const c = loadConfig(base);
    expect(c.isProduction).toBe(false);
    expect(c.sandbox.driver).toBe('disabled');
    expect(c.queueDriver).toBe('bullmq');
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ ...base, OPENAI_API_KEY: '', PORT: '' }).port).toBe(4000);
  });

  it('fails fast on missing or weak secrets', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...base, ENCRYPTION_KEYS: '' })).toThrow(/ENCRYPTION_KEYS/);
  });

  it('enforces production hardening', () => {
    const prod = { ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' };
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() => loadConfig({ ...prod, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...prod, JWT_REFRESH_SECRET: base.JWT_SECRET })).toThrow(/must differ/);
    expect(() => loadConfig({ ...prod, SANDBOX_DRIVER: 'local' })).toThrow(/SANDBOX_DRIVER=local/);
    expect(() => loadConfig({ ...prod, JWT_SECRET: 'change-me-to-a-long-random-string-of-at-least-32-chars' })).toThrow(/placeholder/);
  });
});
