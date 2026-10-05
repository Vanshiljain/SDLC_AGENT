/**
 * Redaction of secrets before anything is logged, audited, or persisted as
 * tool input/output. Matches sensitive keys and well-known token formats.
 */
const SENSITIVE_KEY =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|client[-_]?secret|refresh|signature|session)/i;
const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g,
  /\bATATT[A-Za-z0-9_=-]{20,}\b/g,
  /\bsecret_[A-Za-z0-9]{20,}\b/g,
  /\bntn_[A-Za-z0-9]{20,}\b/g,
];
const REDACTED = '[REDACTED]';

export function redactString(value: string): string {
  let out = value;
  for (const re of TOKEN_PATTERNS)
    out = out.replace(re, (m, prefix?: string) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED));
  return out;
}

export function redact<T>(value: T, depth = 0, maxStringLength = 20_000): T {
  if (depth > 12) return '[depth limit]' as T;
  if (typeof value === 'string') {
    const r = redactString(value);
    return (r.length > maxStringLength ? `${r.slice(0, maxStringLength)}…[truncated]` : r) as T;
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => redact(v, depth + 1, maxStringLength)) as T;
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SENSITIVE_KEY.test(k) && v !== null && v !== undefined && typeof v !== 'boolean' && typeof v !== 'number'
          ? REDACTED
          : redact(v, depth + 1, maxStringLength);
    }
    return out as T;
  }
  return value;
}

/** Pino redaction paths for HTTP logs. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiToken',
  '*.secret',
];
