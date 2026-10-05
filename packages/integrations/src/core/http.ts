import { ToolError, type ToolErrorKind } from '@forgeline/shared';
import { withRetry } from '@forgeline/workflow-engine';

/**
 * Thin fetch-based HTTP client used by every provider adapter.
 *
 * - Per-request timeout via AbortSignal (combined with the caller's signal)
 * - Maps HTTP/transport failures to classified ToolErrors (auth, rate_limit…)
 * - Parses Retry-After / rate-limit reset headers
 * - Retries idempotent requests (GET/HEAD/PUT/DELETE, or explicitly opted-in)
 * - Never includes request headers (credentials) in error messages
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface HttpRequestOptions {
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  body?: unknown;
  /** Raw body (FormData, string, Buffer) — bypasses JSON encoding. */
  rawBody?: RequestInit['body'];
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Expected response type. Default json. */
  responseType?: 'json' | 'text' | 'none' | 'arrayBuffer';
  /** Retry even for non-idempotent methods (when the endpoint is idempotent). */
  retry?: boolean | number;
  /** Status codes that should not throw (returned as null body). */
  allowStatus?: number[];
  /** Follow redirects (default true). */
  redirect?: RequestInit['redirect'];
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface HttpClientOptions {
  baseUrl: string;
  provider: string;
  defaultHeaders?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Provider-specific error message extraction. */
  extractErrorMessage?: (body: unknown, status: number) => string | undefined;
  /** Provider-specific detection of rate limiting on 403s etc. */
  isRateLimited?: (status: number, headers: Headers, body: unknown) => boolean;
  userAgent?: string;
}

const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset && headers.get('x-ratelimit-remaining') === '0') {
    const resetSecs = Number(reset);
    if (Number.isFinite(resetSecs)) {
      // GitHub uses epoch seconds; some APIs use seconds-until-reset.
      const ms = resetSecs > 1e9 ? resetSecs * 1000 - now : resetSecs * 1000;
      return Math.max(0, ms);
    }
  }
  return undefined;
}

export function classifyStatus(status: number): ToolErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  return 'external';
}

function defaultExtractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body.length < 500 ? body : undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.message === 'string') return b.message;
  if (typeof b.error_description === 'string') return b.error_description;
  if (typeof b.error === 'string') return b.error;
  if (Array.isArray(b.errorMessages) && b.errorMessages.length) return b.errorMessages.join('; ');
  if (b.errors && typeof b.errors === 'object') {
    const errs = Object.entries(b.errors as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    if (errs.length) return errs.join('; ');
  }
  return undefined;
}

export class HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  buildUrl(path: string, query?: HttpRequestOptions['query']): string {
    const url = /^https?:\/\//.test(path)
      ? new URL(path)
      : new URL(this.options.baseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
        else url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(path: string, opts: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const method = opts.method ?? 'GET';
    const retries =
      typeof opts.retry === 'number'
        ? opts.retry
        : opts.retry === false
          ? 0
          : IDEMPOTENT.has(method) || opts.retry === true
            ? (this.options.maxRetries ?? 2)
            : 0;
    return withRetry((attempt) => this.once<T>(path, opts, method, attempt), {
      policy: { maxAttempts: retries + 1, initialDelayMs: 500, maxDelayMs: 10_000 },
      isRetryable: (err) => ToolError.is(err) && err.retryable,
      retryAfterMs: (err) => (ToolError.is(err) ? err.retryAfterMs : undefined),
      signal: opts.signal,
    });
  }

  private async once<T>(path: string, opts: HttpRequestOptions, method: HttpMethod, _attempt: number): Promise<HttpResponse<T>> {
    const provider = this.options.provider;
    const url = this.buildUrl(path, opts.query);
    const defaults =
      typeof this.options.defaultHeaders === 'function' ? await this.options.defaultHeaders() : (this.options.defaultHeaders ?? {});
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.options.userAgent ?? 'Forgeline/1.0',
      ...defaults,
      ...opts.headers,
    };
    let body: RequestInit['body'] | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] ??= 'application/json';
    }

    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal, redirect: opts.redirect ?? 'follow' });
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new ToolError('cancelled', `${provider} request cancelled`, { provider, retryable: false, cause: err });
      }
      if (timeoutSignal.aborted) {
        throw new ToolError('timeout', `${provider} request timed out after ${timeoutMs}ms (${method} ${redactUrl(url)})`, { provider, cause: err });
      }
      throw ToolError.from(err, provider);
    }

    const responseType = opts.responseType ?? 'json';
    const readBody = async (): Promise<unknown> => {
      if (res.status === 204 || method === 'HEAD' || responseType === 'none') return null;
      if (responseType === 'text') return res.text();
      if (responseType === 'arrayBuffer') return res.arrayBuffer();
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        if (!res.ok) return text;
        throw new ToolError('malformed_response', `${provider} returned invalid JSON (${method} ${redactUrl(url)})`, {
          provider,
          status: res.status,
          cause: err,
        });
      }
    };

    if (res.ok || opts.allowStatus?.includes(res.status)) {
      const data = res.ok ? await readBody() : null;
      return { status: res.status, headers: res.headers, data: data as T };
    }

    let errBody: unknown = null;
    try {
      const text = await res.text();
      try {
        errBody = text ? JSON.parse(text) : null;
      } catch {
        errBody = text.slice(0, 500);
      }
    } catch {
      errBody = null;
    }
    let kind = classifyStatus(res.status);
    if (this.options.isRateLimited?.(res.status, res.headers, errBody)) kind = 'rate_limit';
    const retryAfterMs = parseRetryAfter(res.headers);
    const detail = this.options.extractErrorMessage?.(errBody, res.status) ?? defaultExtractMessage(errBody);
    const message = `${provider} ${method} ${redactUrl(url)} failed with ${res.status}${detail ? `: ${detail}` : ''}`;
    throw new ToolError(kind, message, {
      provider,
      status: res.status,
      retryAfterMs,
      retryable: kind === 'external' ? res.status >= 500 : undefined,
      details: errBody && typeof errBody === 'object' ? { body: errBody as Record<string, unknown> } : undefined,
    });
  }

  get<T>(path: string, opts: Omit<HttpRequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...opts, method: 'GET' }).then((r) => r.data);
  }
  post<T>(path: string, body?: unknown, opts: Omit<HttpRequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...opts, method: 'POST', body }).then((r) => r.data);
  }
  put<T>(path: string, body?: unknown, opts: Omit<HttpRequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...opts, method: 'PUT', body }).then((r) => r.data);
  }
  patch<T>(path: string, body?: unknown, opts: Omit<HttpRequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...opts, method: 'PATCH', body }).then((r) => r.data);
  }
  delete<T>(path: string, opts: Omit<HttpRequestOptions, 'method'> = {}) {
    return this.request<T>(path, { ...opts, method: 'DELETE' }).then((r) => r.data);
  }
}

/** Strip query-string credentials (e.g. Trello key/token) from URLs in messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/token|key|secret|signature|password|code/i.test(k)) u.searchParams.set(k, '***');
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url.replace(/(token|key|secret)=[^&]+/gi, '$1=***');
  }
}
