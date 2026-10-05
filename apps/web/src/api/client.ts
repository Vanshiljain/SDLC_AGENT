import { COOKIE_CSRF, HEADER_CSRF, HEADER_ORGANIZATION, type ApiErrorBody, type SessionResponse } from '@forgeline/shared';
import { pickOrganization, session } from '@/lib/session';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? `Request failed (${status})`);
  }
  get code(): string | undefined {
    return this.body?.code;
  }
}

function readCookie(name: string): string | null {
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export function applySession(s: SessionResponse): void {
  session.set({
    accessToken: s.accessToken,
    expiresAt: Date.now() + s.expiresIn * 1000,
    user: s.user,
    memberships: s.memberships,
    organizationId: pickOrganization(s.memberships, session.get().organizationId),
  });
}

let refreshing: Promise<boolean> | null = null;

/** Rotates the refresh cookie (double-submit CSRF). Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const csrf = readCookie(COOKIE_CSRF);
      if (!csrf) return false;
      const res = await fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include', headers: { [HEADER_CSRF]: csrf } });
      if (!res.ok) return false;
      applySession((await res.json()) as SessionResponse);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Send without the organisation header (e.g. auth endpoints). */
  noOrg?: boolean;
  form?: FormData;
}

function buildUrl(path: string, query?: Query): string {
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  return `${API_BASE}/api${path}${qs ? `?${qs}` : ''}`;
}

async function send(method: string, path: string, opts: RequestOptions, retry: boolean): Promise<Response> {
  const s = session.get();
  if (s.accessToken && s.expiresAt - Date.now() < 15_000 && retry) await refreshSession();
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = session.get().accessToken;
  if (token) headers.authorization = `Bearer ${token}`;
  if (!opts.noOrg && session.get().organizationId) headers[HEADER_ORGANIZATION] = session.get().organizationId!;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(buildUrl(path, opts.query), { method, headers, body, signal: opts.signal, credentials: 'include' });
  if (res.status === 401 && retry && (await refreshSession())) return send(method, path, opts, false);
  return res;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, opts, true);
  if (res.status === 401) session.clear();
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, (data as ApiErrorBody | undefined) ?? null);
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, { body }),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, { form }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.body?.details) ? (err.body.details as unknown[]).filter((d) => typeof d === 'string').join('; ') : '';
    return details && !err.message.includes(details) ? `${err.message}: ${details}` : err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
