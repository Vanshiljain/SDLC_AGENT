import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '@forgeline/shared';

/**
 * Delay before the next attempt. `attempt` is the attempt that just failed
 * (1-based). Exponential backoff uses "equal jitter" so retries from many runs
 * spread out without ever retrying immediately. A provider Retry-After wins
 * when it is longer.
 */
export function computeBackoffDelay(
  policy: Partial<RetryPolicy> | undefined,
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const p = { ...DEFAULT_RETRY_POLICY, ...policy };
  let delay: number;
  if (p.backoff === 'fixed') {
    delay = p.initialDelayMs;
  } else {
    const exp = Math.min(p.maxDelayMs, p.initialDelayMs * 2 ** Math.max(0, attempt - 1));
    delay = exp / 2 + random() * (exp / 2);
  }
  if (retryAfterMs !== undefined && retryAfterMs > delay) delay = retryAfterMs;
  return Math.round(Math.min(delay, Math.max(p.maxDelayMs, retryAfterMs ?? 0)));
}

export function resolveRetryPolicy(policy: Partial<RetryPolicy> | undefined, fallback?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...fallback, ...policy };
}

/** Generic async retry helper for code paths outside the engine (HTTP clients, LLM calls). */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    policy?: Partial<RetryPolicy>;
    isRetryable: (err: unknown) => boolean;
    retryAfterMs?: (err: unknown) => number | undefined;
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
    signal?: AbortSignal;
  },
): Promise<T> {
  const policy = resolveRetryPolicy(options.policy);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= policy.maxAttempts || !options.isRetryable(err) || options.signal?.aborted) throw err;
      const delay = computeBackoffDelay(policy, attempt, options.retryAfterMs?.(err));
      options.onRetry?.(err, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
