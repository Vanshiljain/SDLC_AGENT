import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ToolError } from '@forgeline/shared';

/**
 * SSRF protection for user-configurable outbound HTTP (health checks, smoke
 * tests, the generic HTTP Request node). The check runs inside the socket
 * connect lookup, so the validated IP is the IP actually connected to — no
 * DNS-rebinding window.
 */

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

export interface SafeFetchOptions {
  allowPrivateNetworks: boolean;
  /** Hostnames always allowed (e.g. internal service names configured by an admin). */
  allowedHosts?: string[];
}

const agentCache = new Map<string, Agent>();

function agentFor(options: SafeFetchOptions): Agent {
  const key = `${options.allowPrivateNetworks}|${(options.allowedHosts ?? []).join(',')}`;
  let agent = agentCache.get(key);
  if (agent) return agent;
  const allowed = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  agent = new Agent({
    connect: {
      lookup(hostname, opts, callback) {
        dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
          if (err) return callback(err, '', 0);
          const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
          const bypass = options.allowPrivateNetworks || allowed.has(hostname.toLowerCase());
          const permitted = bypass ? list : list.filter((a) => !isPrivateAddress(a.address));
          if (!permitted.length) {
            const e = new Error(`Blocked request to private address for host ${hostname}`) as NodeJS.ErrnoException;
            e.code = 'ESSRFBLOCKED';
            return callback(e, '', 0);
          }
          if ((opts as { all?: boolean }).all) return callback(null, permitted as unknown as string, 0);
          return callback(null, permitted[0]!.address, permitted[0]!.family);
        });
      },
    },
  });
  agentCache.set(key, agent);
  return agent;
}

export async function safeFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; signal?: AbortSignal },
  options: SafeFetchOptions,
): Promise<{ status: number; headers: Headers; body: string; latencyMs: number }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError('validation', `Invalid URL: ${url}`, { retryable: false });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ToolError('validation', `Only http(s) URLs are allowed (got ${parsed.protocol})`, { retryable: false });
  }
  if (parsed.username || parsed.password) {
    throw new ToolError('validation', 'URLs with embedded credentials are not allowed', { retryable: false });
  }
  if (
    isIP(parsed.hostname.replace(/^\[|\]$/g, '')) &&
    !options.allowPrivateNetworks &&
    isPrivateAddress(parsed.hostname.replace(/^\[|\]$/g, ''))
  ) {
    throw new ToolError('permission', `Requests to private network addresses are blocked (${parsed.hostname})`, { retryable: false });
  }
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 10_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const started = performance.now();
  try {
    const res = await undiciFetch(parsed, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal,
      redirect: 'manual',
      dispatcher: agentFor(options),
    });
    const body = init.method === 'HEAD' ? '' : (await res.text()).slice(0, 64_000);
    return { status: res.status, headers: res.headers as unknown as Headers, body, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === 'ESSRFBLOCKED') throw new ToolError('permission', cause.message ?? 'Blocked private address', { retryable: false });
    if (timeout.aborted) throw new ToolError('timeout', `Request to ${parsed.host} timed out`);
    throw ToolError.from(err, 'http');
  }
}
