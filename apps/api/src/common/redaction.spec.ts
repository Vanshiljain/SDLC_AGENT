import { redact, redactString } from './redaction';

describe('redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({ token: 'abc', nested: { apiKey: 'k', password: 'p', ok: 'visible' }, list: [{ clientSecret: 's' }] });
    expect(out).toEqual({
      token: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', password: '[REDACTED]', ok: 'visible' },
      list: [{ clientSecret: '[REDACTED]' }],
    });
  });

  it('redacts well-known token formats inside free text', () => {
    const text = 'auth ghp_abcdefghijklmnopqrstuvwxyz0123 and Bearer abcdefghijklmnopqrstuvwxyz and sk-abcdefghijklmnopqrstuvwxyz';
    const out = redactString(text);
    expect(out).not.toMatch(/ghp_|sk-abc|Bearer abc/);
    expect(out).toContain('[REDACTED]');
  });

  it('keeps the Slack webhook host but hides its path', () => {
    expect(redactString('https://hooks.slack.com/services/T000/B000/XXXX')).toBe('https://hooks.slack.com/services/[REDACTED]');
  });

  it('leaves ordinary content untouched', () => {
    expect(redact({ summary: 'Created AUTH-142', count: 3, ok: true })).toEqual({ summary: 'Created AUTH-142', count: 3, ok: true });
  });
});
