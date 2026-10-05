import type { SmokeTestDefinition } from '../core/tool';
import { safeFetch, type SafeFetchOptions } from './ssrf';

/** Health checks and smoke tests executed by Forgeline itself against a deployed environment. */

export interface ProbeResult {
  name: string;
  status: 'passed' | 'failed';
  httpStatus: number | null;
  latencyMs: number | null;
  detail: string;
}

/** Resolves a probe path against the environment URL, preserving any base path (e.g. https://host/app + /health). */
export function probeUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

export async function runProbe(
  baseUrl: string,
  test: SmokeTestDefinition,
  options: SafeFetchOptions,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const url = probeUrl(baseUrl, test.path);
  const expectStatus = test.expectStatus ?? 200;
  try {
    const res = await safeFetch(
      url,
      {
        method: test.method ?? 'GET',
        headers:
          test.body !== undefined
            ? { 'Content-Type': 'application/json', 'User-Agent': 'Forgeline-Probe/1.0' }
            : { 'User-Agent': 'Forgeline-Probe/1.0' },
        body: test.body !== undefined ? JSON.stringify(test.body) : undefined,
        timeoutMs: 10_000,
        signal,
      },
      options,
    );
    const statusOk = res.status === expectStatus;
    const bodyOk = !test.expectBodyContains || res.body.includes(test.expectBodyContains);
    return {
      name: test.name,
      status: statusOk && bodyOk ? 'passed' : 'failed',
      httpStatus: res.status,
      latencyMs: res.latencyMs,
      detail: !statusOk
        ? `Expected ${expectStatus}, got ${res.status}`
        : !bodyOk
          ? `Response did not contain "${test.expectBodyContains}"`
          : `${res.status} in ${res.latencyMs}ms`,
    };
  } catch (err) {
    return { name: test.name, status: 'failed', httpStatus: null, latencyMs: null, detail: (err as Error).message };
  }
}

export async function runProbes(
  baseUrl: string,
  tests: SmokeTestDefinition[],
  options: SafeFetchOptions & { retries?: number; retryDelayMs?: number },
  signal?: AbortSignal,
): Promise<{ passed: boolean; results: ProbeResult[] }> {
  const results: ProbeResult[] = [];
  for (const test of tests) {
    let result = await runProbe(baseUrl, test, options, signal);
    // New deployments can take a moment to become ready.
    for (let i = 0; i < (options.retries ?? 0) && result.status === 'failed'; i++) {
      await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 3_000));
      result = await runProbe(baseUrl, test, options, signal);
    }
    results.push(result);
  }
  return { passed: results.length > 0 && results.every((r) => r.status === 'passed'), results };
}
