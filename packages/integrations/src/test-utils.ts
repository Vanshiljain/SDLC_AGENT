import type { IntegrationClients, ToolExecutionContext } from './core/tool';

/** Test helpers: a tiny fetch router and a tool context factory. */

export interface MockRoute {
  method: string;
  path: RegExp;
  handler: (req: { url: URL; body: unknown; headers: Headers; calls: number }) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
    text?: string;
  };
}

export function mockFetch(routes: MockRoute[]) {
  const calls: { method: string; url: string; body: unknown; headers: Headers }[] = [];
  const counts = new Map<MockRoute, number>();
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* raw */
      }
    }
    calls.push({ method, url: url.toString(), body, headers });
    const route = routes.find((r) => r.method === method && r.path.test(url.pathname));
    if (!route) return new Response(JSON.stringify({ message: `No mock for ${method} ${url.pathname}` }), { status: 404 });
    const n = (counts.get(route) ?? 0) + 1;
    counts.set(route, n);
    const res = route.handler({ url, body, headers, calls: n });
    const status = res.status ?? 200;
    const payload = res.text ?? (res.body === undefined || status === 204 ? null : JSON.stringify(res.body));
    return new Response(payload, { status, headers: { 'content-type': 'application/json', ...res.headers } });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export function toolContext(
  overrides: Partial<Omit<ToolExecutionContext, 'clients'>> & { clients?: Partial<IntegrationClients> } = {},
): ToolExecutionContext {
  const notConnected = async () => {
    throw new Error('not connected in test');
  };
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    executionId: 'exec-1',
    stepKey: 'step',
    idempotencyKey: 'exec-1:step:0',
    mode: 'LIVE',
    attempt: 1,
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    progress() {},
    project: {
      id: 'p1',
      name: 'Auth Service',
      key: 'AUTH',
      slug: 'auth-service',
      settings: { jiraProjectKey: 'AUTH', notionParentPageId: 'parent-page' },
      repository: { id: 'r1', owner: 'acme', name: 'auth', fullName: 'acme/auth', defaultBranch: 'main', settings: {} },
      environments: [],
    },
    ...overrides,
    clients: {
      github: notConnected,
      jira: notConnected,
      trello: notConnected,
      notion: notConnected,
      cicd: notConnected,
      slack: notConnected,
      connected: async () => [],
      ...overrides.clients,
    } as IntegrationClients,
  };
}
