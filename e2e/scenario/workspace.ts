import { randomBytes } from 'node:crypto';
import { DEVOPS_SIGNING_SECRET } from '../mock-services/server';
import { ApiClient } from './harness';

export const ACCEPTANCE_PASSWORD = 'Acceptance!2026';

export interface AcceptanceWorkspace {
  orgId: string;
  projectId: string;
  password: string;
  owner: { email: string };
  lead: { email: string };
  engineer: { email: string };
}

interface Session {
  accessToken: string;
  user: { id: string };
  memberships: { organizationId: string }[];
}

/**
 * Creates an isolated, real (non-demo) workspace wired to the mock external
 * services: owner + release lead (ADMIN) + engineer (MEMBER), all integrations
 * connected and verified, and an Authentication Service project with its repo
 * and environments.
 */
export async function createAcceptanceWorkspace(apiUrl: string, mockUrl: string): Promise<AcceptanceWorkspace> {
  const anon = new ApiClient(apiUrl);
  const suffix = randomBytes(4).toString('hex');
  const ownerEmail = `owner-${suffix}@acme.test`;
  const owner = await anon.post<Session>('/auth/register', { email: ownerEmail, name: 'Olive Owner', password: ACCEPTANCE_PASSWORD, organizationName: `Acme ${suffix}` });
  const orgId = owner.memberships[0]!.organizationId;
  const o = anon.as(owner.accessToken, orgId);

  const join = async (email: string, name: string, role: 'ADMIN' | 'MEMBER') => {
    const invite = await o.post<{ inviteUrl: string }>('/organizations/current/invitations', { email, role });
    const token = new URL(invite.inviteUrl).searchParams.get('token')!;
    return anon.post<Session>('/auth/accept-invite', { token, name, password: ACCEPTANCE_PASSWORD });
  };
  const leadEmail = `lead-${suffix}@acme.test`;
  const engineerEmail = `eng-${suffix}@acme.test`;
  const lead = await join(leadEmail, 'Lee Lead', 'ADMIN');
  const engineer = await join(engineerEmail, 'Eli Engineer', 'MEMBER');

  for (const [provider, credentials] of [
    ['github', { token: 'ghp_e2e_mock_token_value' }],
    ['jira', { siteUrl: `${mockUrl}/jira`, email: 'bot@acme.test', apiToken: 'jira-e2e-token' }],
    ['notion', { token: 'secret_notion_e2e_0123456789abcdef' }],
    ['custom-devops', { baseUrl: `${mockUrl}/devops`, apiToken: 'e2e-devops-token', signingSecret: DEVOPS_SIGNING_SECRET }],
    ['slack', { webhookUrl: `${mockUrl}/slack/T000/B000/xyz` }],
  ] as const) {
    await o.post(`/integrations/${provider}/connect`, { credentials });
  }

  const project = await o.post<{ id: string }>('/projects', {
    name: 'Authentication Service',
    key: 'AUTH',
    description: 'Identity, sessions and password management.',
    createDefaultEnvironments: true,
    settings: { jiraProjectKey: 'AUTH', ticketProvider: 'JIRA', notionParentPageId: 'parent-page', cicdProvider: 'CUSTOM_DEVOPS' },
  });
  await o.put(`/projects/${project.id}/members`, { userId: engineer.user.id, role: 'DEVELOPER' });
  await o.put(`/projects/${project.id}/members`, { userId: lead.user.id, role: 'MAINTAINER' });
  await o.post(`/projects/${project.id}/repositories`, { fullName: 'acme/auth-service', settings: { installCommand: 'npm ci --no-audit --no-fund', lintCommand: 'npm run lint', testCommand: 'npm test' } });
  const detail = await o.get<{ environments: { id: string; name: string }[] }>(`/projects/${project.id}`);
  for (const env of detail.environments) {
    await o.patch(`/projects/${project.id}/environments/${env.id}`, { url: `${mockUrl}/env/${env.name}`, healthCheckPath: '/health', smokeTests: [{ name: 'Login page', path: '/login', expectStatus: 200 }] });
  }
  return { orgId, projectId: project.id, password: ACCEPTANCE_PASSWORD, owner: { email: ownerEmail }, lead: { email: leadEmail }, engineer: { email: engineerEmail } };
}
