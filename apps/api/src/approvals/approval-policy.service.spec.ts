import type { ProjectContext } from '@forgeline/integrations';
import { OrganizationsService } from '../organizations/organizations.service';
import type { PrismaService } from '../common/prisma/prisma.service';
import { ApprovalPolicyService } from './approval-policy.service';

function service(orgSettings: Record<string, unknown> = {}) {
  const prisma = { organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ settings: orgSettings }) } } as unknown as PrismaService;
  const orgs = Object.create(OrganizationsService.prototype) as OrganizationsService;
  return new ApprovalPolicyService(prisma, orgs);
}

const project = (overrides: Partial<ProjectContext> = {}): ProjectContext => ({
  id: 'p1',
  name: 'Auth',
  key: 'AUTH',
  slug: 'auth',
  settings: {},
  environments: [
    { id: 'e1', name: 'staging', type: 'STAGING', healthCheckPath: '/health', smokeTests: [], requiresApproval: false, config: {} },
    { id: 'e2', name: 'production', type: 'PRODUCTION', healthCheckPath: '/health', smokeTests: [], requiresApproval: true, config: {} },
    { id: 'e3', name: 'dev', type: 'DEVELOPMENT', healthCheckPath: '/health', smokeTests: [], requiresApproval: false, config: {} },
  ],
  ...overrides,
});

describe('ApprovalPolicyService', () => {
  it('always gates locked actions, even if a project tries to disable them', async () => {
    const p = project({ settings: { approvalPolicy: { 'deploy.production': 'auto', 'pr.merge': 'auto' } } });
    for (const action of ['deploy.production', 'pr.merge', 'infrastructure.destroy']) {
      const d = await service().evaluate('org', p, action);
      expect(d.required).toBe(true);
      expect(d.locked).toBe(true);
    }
  });

  it('resolves deploy.environment to the environment type', async () => {
    const s = service();
    expect((await s.evaluate('org', project(), 'deploy.environment', 'production')).action).toBe('deploy.production');
    expect((await s.evaluate('org', project(), 'deploy.environment', 'staging')).action).toBe('deploy.staging');
    expect((await s.evaluate('org', project(), 'deploy.environment', 'dev')).required).toBe(false);
  });

  it('treats unknown environments as production (fail safe)', async () => {
    const d = await service().evaluate('org', project(), 'deploy.environment', 'mystery');
    expect(d.action).toBe('deploy.production');
    expect(d.required).toBe(true);
  });

  it('requires approval for staging by default and allows projects to relax it', async () => {
    expect((await service().evaluate('org', project(), 'deploy.staging')).required).toBe(true);
    const relaxed = project({ settings: { approvalPolicy: { 'deploy.staging': 'auto' } } });
    expect((await service().evaluate('org', relaxed, 'deploy.staging')).required).toBe(false);
  });

  it('lets projects opt in to approval for configurable actions', async () => {
    const strict = project({ settings: { approvalPolicy: { 'pr.create': 'required' } } });
    expect((await service().evaluate('org', strict, 'pr.create')).required).toBe(true);
    expect((await service().evaluate('org', project(), 'pr.create')).required).toBe(false);
  });

  it('enforces four-eyes for production unless the organisation disables it', async () => {
    expect((await service().evaluate('org', project(), 'deploy.production')).allowSelfApproval).toBe(false);
    expect((await service({ fourEyesProduction: false }).evaluate('org', project(), 'deploy.production')).allowSelfApproval).toBe(true);
    expect((await service().evaluate('org', project(), 'deploy.staging')).allowSelfApproval).toBe(true);
  });

  it('maps gated actions to the permission an approver must hold', async () => {
    const s = service();
    expect((await s.evaluate('org', project(), 'deploy.production')).requiredPermission).toBe('deploy:production');
    expect((await s.evaluate('org', project(), 'pr.merge')).requiredPermission).toBe('code:merge');
  });

  it('describes the effective policy with locked rows', () => {
    const rows = service().describe(project({ settings: { approvalPolicy: { 'pr.create': 'required' } } }));
    expect(rows.find((r) => r.action === 'deploy.production')).toEqual({ action: 'deploy.production', locked: true, setting: 'required' });
    expect(rows.find((r) => r.action === 'pr.create')?.setting).toBe('required');
  });
});
