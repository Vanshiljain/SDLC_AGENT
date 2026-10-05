import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { startMockServices, type MockServices } from '../mock-services/server';

/**
 * Boots the acceptance-test stack: the mock external services (GitHub, Jira,
 * Notion, DevOps, Slack, an OpenAI-compatible model) and the real Forgeline
 * API pointed at them. Postgres, Redis and Qdrant must already be running
 * (`pnpm infra:up`) with migrations applied (`pnpm db:deploy`).
 *
 * Set E2E_API_URL + E2E_MOCK_URL to reuse an already running stack instead.
 */

const ROOT = resolve(__dirname, '..', '..');

export interface Stack {
  apiUrl: string;
  mockUrl: string;
  mocks: MockServices | null;
  stop(): Promise<void>;
}

function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForReady(url: string, child: ChildProcess | null, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`API exited with code ${child.exitCode} before becoming ready`);
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.ok) return;
      last = `${res.status} ${await res.text()}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API did not become ready: ${last}`);
}

export async function startStack(): Promise<Stack> {
  if (process.env.E2E_API_URL && process.env.E2E_MOCK_URL) {
    await waitForReady(process.env.E2E_API_URL, null);
    return { apiUrl: process.env.E2E_API_URL, mockUrl: process.env.E2E_MOCK_URL, mocks: null, stop: async () => undefined };
  }

  const mocks = await startMockServices(0);
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const entry = join(ROOT, 'apps', 'api', 'dist', 'main.js');
  if (!existsSync(entry)) throw new Error('Build the API first: pnpm --filter @forgeline/api build');

  const env: NodeJS.ProcessEnv = {
    ...parseDotEnv(join(ROOT, '.env')),
    ...process.env,
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    PORT: String(port),
    API_PUBLIC_URL: apiUrl,
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    OPENAI_API_KEY: 'mock-key',
    OPENAI_BASE_URL: `${mocks.url}/openai/v1`,
    GITHUB_API_URL: `${mocks.url}/github`,
    NOTION_API_URL: `${mocks.url}/notion/v1`,
    SANDBOX_DRIVER: process.env.SANDBOX_DRIVER ?? 'local',
    OUTBOUND_ALLOW_PRIVATE_NETWORKS: 'true',
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '1000',
  };
  const child = spawn(process.execPath, [entry], { cwd: join(ROOT, 'apps', 'api'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  const keep = (b: Buffer) => {
    output.push(b.toString());
    if (output.length > 400) output.shift();
    if (process.env.E2E_VERBOSE) process.stderr.write(b);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  try {
    await waitForReady(apiUrl, child);
  } catch (err) {
    child.kill('SIGKILL');
    await mocks.close();
    throw new Error(`${(err as Error).message}\n--- API output ---\n${output.join('').slice(-6000)}`);
  }

  return {
    apiUrl,
    mockUrl: mocks.url,
    mocks,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            child.kill('SIGKILL');
            r();
          }, 10_000);
          child.once('exit', () => {
            clearTimeout(t);
            r();
          });
        });
      }
      await mocks.close();
    },
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

/** Minimal typed client for the public REST API (same surface the web app uses). */
export class ApiClient {
  constructor(
    private readonly base: string,
    private token?: string,
    private organizationId?: string,
  ) {}

  as(token: string, organizationId?: string): ApiClient {
    return new ApiClient(this.base, token, organizationId ?? this.organizationId);
  }

  inOrg(organizationId: string): ApiClient {
    return new ApiClient(this.base, this.token, organizationId);
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.organizationId) headers['x-organization-id'] = this.organizationId;
    const res = await fetch(`${this.base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, parsed, `${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    return parsed as T;
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T = unknown>(path: string, body: unknown = {}) {
    return this.request<T>('POST', path, body);
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }
  put<T = unknown>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body);
  }
}

export async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, { timeoutMs = 120_000, intervalMs = 500, label = 'condition' } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)?.slice(0, 2000)}`);
}
