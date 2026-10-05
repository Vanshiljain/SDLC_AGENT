import { session } from '@/lib/session';
import { api, ApiError } from './client';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('api client', () => {
  beforeEach(() => {
    session.set({ accessToken: 'old', expiresAt: Date.now() + 600_000, organizationId: 'org-1', memberships: [] });
    document.cookie = 'fl_csrf=csrf-123';
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends the bearer token and organisation header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { ok: true }));
    await api.get('/projects');
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer old');
    expect((init!.headers as Record<string, string>)['x-organization-id']).toBe('org-1');
  });

  it('refreshes once on 401 (with the CSRF header) and retries the request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { message: 'expired' }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new', expiresIn: 900, user: { id: 'u', email: 'e', name: 'n', avatarUrl: null }, memberships: [{ organizationId: 'org-1', organizationName: 'O', organizationSlug: 'o', role: 'OWNER', isDemo: false }] }))
      .mockResolvedValueOnce(json(200, [{ id: 'p1' }]));
    const res = await api.get<{ id: string }[]>('/projects');
    expect(res[0]!.id).toBe('p1');
    const refreshCall = fetchMock.mock.calls[1]!;
    expect(String(refreshCall[0])).toContain('/api/auth/refresh');
    expect((refreshCall[1]!.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-123');
    expect((fetchMock.mock.calls[2]![1]!.headers as Record<string, string>).authorization).toBe('Bearer new');
  });

  it('surfaces API errors with their message and code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(403, { statusCode: 403, error: 'Forbidden', message: 'Missing permission "deploy:production"', code: 'PERMISSION_DENIED' }));
    const err = await api.post('/approvals/x/approve').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('PERMISSION_DENIED');
    expect((err as ApiError).message).toMatch(/deploy:production/);
  });
});
