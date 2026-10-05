import { createHmac, timingSafeEqual } from 'node:crypto';

/** Webhook signature verification (constant-time comparisons). */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** GitHub: X-Hub-Signature-256: sha256=<hex hmac of raw body>. */
export function verifyGitHubSignature(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(expected, header);
}

/** Jira Cloud (admin webhooks with secret): X-Hub-Signature: sha256=<hex>. */
export function verifyJiraSignature(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!header) return false;
  const [algo, sig] = header.includes('=') ? header.split('=', 2) : ['sha256', header];
  if (algo !== 'sha256' || !sig) return false;
  return safeEqual(createHmac('sha256', secret).update(rawBody).digest('hex'), sig);
}

/** Trello: X-Trello-Webhook = base64(HMAC-SHA1(appSecret, body + callbackURL)). */
export function verifyTrelloSignature(appSecret: string, rawBody: Buffer | string, callbackUrl: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = createHmac('sha1', appSecret).update(Buffer.concat([Buffer.from(rawBody), Buffer.from(callbackUrl)])).digest('base64');
  return safeEqual(expected, header);
}

/**
 * Forgeline DevOps / generic: X-Forgeline-Signature: v1=<hex hmac of "ts.body">,
 * X-Forgeline-Timestamp within tolerance to prevent replay.
 */
export function verifyTimestampedSignature(
  secret: string,
  rawBody: Buffer | string,
  timestamp: string | undefined,
  header: string | undefined,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  if (!timestamp || !header) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSeconds) return false;
  const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${Buffer.from(rawBody).toString('utf8')}`).digest('hex')}`;
  return safeEqual(expected, header);
}
