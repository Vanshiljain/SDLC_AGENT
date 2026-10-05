import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { DEVOPS_SIGNING_SECRET } from '../mock-services/server';
import { ApiClient, ApiError, poll, startStack, type Stack } from './harness';

/**
 * Acceptance scenario: "Implement a password reset feature for my
 * authentication service" — delivered end to end through the real Forgeline
 * API, agents, workflow engine, policy gates and integration adapters, with
 * only the external SaaS endpoints replaced by local mocks. Code validation
 * runs the generated tests for real in the sandbox (the first draft is
 * intentionally buggy, so the repair loop must fix it).
 */

interface Session {
  accessToken: string;
  user: { id: string; email: string };
  memberships: { organizationId: string; role: string; isDemo: boolean }[];
}
interface Step {
  id: string;
  stepKey: string;
  status: string;
  iteration: number;
  summary: string | null;
}
interface ApprovalRow {
  id: string;
  title: string;
  action: string;
  status: string;
  riskLevel: string;
  decidedById: string | null;
}
interface ExecutionDetail {
  id: string;
  status: string;
  mode: string;
  error: unknown;
  steps: Step[];
  approvals: ApprovalRow[];
  externalResources: { type: string; key: string | null; url: string | null; simulated: boolean }[];
  deployments: { status: string; environment: { name: string } }[];
}
interface MessageRow {
  id: string;
  role: string;
  status: string;
  content: string;
  parts: {
    type: string;
    proposalId?: string;
    executionId?: string;
    mode?: string;
    steps?: { key: string }[];
    approvalsRequired?: string[];
    missingIntegrations?: string[];
  }[];
}

const PASSWORD = 'Acceptance!2026';
const REQUEST = 'Implement a password reset feature for my authentication service';
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'COMPENSATED']);

describe('acceptance: password reset delivered end to end', { timeout: 10 * 60_000 }, () => {
  let stack: Stack;
  let anon: ApiClient;
  let owner: ApiClient;
  let lead: ApiClient;
  let engineer: ApiClient;
  let leadId: string;
  let engineerId: string;
  let engineerToken: string;
  let orgId: string;
  let projectId: string;
  let executionId: string;
  let socket: Socket | undefined;
  const realtime: { type: string; executionId?: string | null; data?: Record<string, unknown> }[] = [];

  const mock = async <T>(path: string): Promise<T> => (await fetch(`${stack.mockUrl}${path}`)).json() as Promise<T>;

  before(async () => {
    stack = await startStack();
    anon = new ApiClient(stack.apiUrl);
    await fetch(`${stack.mockUrl}/__reset`, { method: 'POST' });

    const suffix = randomBytes(4).toString('hex');
    const ownerSession = await anon.post<Session>('/auth/register', {
      email: `owner-${suffix}@acme.test`,
      name: 'Olive Owner',
      password: PASSWORD,
      organizationName: `Acme ${suffix}`,
    });
    orgId = ownerSession.memberships[0]!.organizationId;
    owner = anon.as(ownerSession.accessToken, orgId);

    const join = async (email: string, name: string, role: 'ADMIN' | 'MEMBER') => {
      const invite = await owner.post<{ inviteUrl: string }>('/organizations/current/invitations', { email, role });
      const token = new URL(invite.inviteUrl).searchParams.get('token')!;
      return anon.post<Session>('/auth/accept-invite', { token, name, password: PASSWORD });
    };
    const leadSession = await join(`lead-${suffix}@acme.test`, 'Lee Lead', 'ADMIN');
    const engineerSession = await join(`eng-${suffix}@acme.test`, 'Eli Engineer', 'MEMBER');
    lead = anon.as(leadSession.accessToken, orgId);
    engineer = anon.as(engineerSession.accessToken, orgId);
    leadId = leadSession.user.id;
    engineerId = engineerSession.user.id;
    engineerToken = engineerSession.accessToken;
  });

  after(async () => {
    socket?.disconnect();
    await stack?.stop();
  });

  it('connects real integrations (verified live, secrets never returned)', async () => {
    const m = stack.mockUrl;
    const connections: [string, Record<string, string>][] = [
      ['github', { token: 'ghp_e2e_mock_token_value' }],
      ['jira', { siteUrl: `${m}/jira`, email: 'bot@acme.test', apiToken: 'jira-e2e-token' }],
      ['notion', { token: 'secret_notion_e2e_0123456789abcdef' }],
      ['custom-devops', { baseUrl: `${m}/devops`, apiToken: 'e2e-devops-token', signingSecret: DEVOPS_SIGNING_SECRET }],
      ['slack', { webhookUrl: `${m}/slack/T000/B000/xyz` }],
    ];
    for (const [provider, credentials] of connections) {
      const integration = await owner.post<Record<string, unknown>>(`/integrations/${provider}/connect`, { credentials });
      assert.equal(integration.status, 'CONNECTED', `${provider} should be connected`);
      const serialized = JSON.stringify(integration);
      for (const secret of Object.values(credentials).filter((v) => !v.startsWith('http') && !v.includes('@'))) {
        assert.ok(!serialized.includes(secret), `${provider} response must not leak credentials`);
      }
    }
    // Members cannot manage integrations.
    await assert.rejects(engineer.post('/integrations/github/connect', { credentials: { token: 'x' } }), (e: ApiError) => e.status === 403);
  });

  it('sets up the Authentication Service project', async () => {
    const project = await owner.post<{ id: string }>('/projects', {
      name: 'Authentication Service',
      key: 'AUTH',
      description: 'Identity, sessions and password management.',
      createDefaultEnvironments: true,
      settings: { jiraProjectKey: 'AUTH', ticketProvider: 'JIRA', notionParentPageId: 'parent-page', cicdProvider: 'CUSTOM_DEVOPS' },
    });
    projectId = project.id;
    await owner.put(`/projects/${projectId}/members`, { userId: engineerId, role: 'DEVELOPER' });
    await owner.put(`/projects/${projectId}/members`, { userId: leadId, role: 'MAINTAINER' });
    await owner.post(`/projects/${projectId}/repositories`, {
      fullName: 'acme/auth-service',
      settings: { installCommand: 'npm ci --no-audit --no-fund', lintCommand: 'npm run lint', testCommand: 'npm test' },
    });
    const detail = await owner.get<{ environments: { id: string; name: string }[]; repositories: unknown[] }>(`/projects/${projectId}`);
    assert.equal(detail.repositories.length, 1);
    for (const env of detail.environments) {
      await owner.patch(`/projects/${projectId}/environments/${env.id}`, {
        url: `${stack.mockUrl}/env/${env.name}`,
        healthCheckPath: '/health',
        smokeTests: [{ name: 'Login page', path: '/login', expectStatus: 200 }],
      });
    }
  });

  it('subscribes to realtime events', async () => {
    socket = io(`${stack.apiUrl}/realtime`, { transports: ['websocket'], auth: { token: engineerToken, organizationId: orgId } });
    socket.on('event', (e: { type: string; executionId?: string | null; data?: Record<string, unknown> }) => realtime.push(e));
    await new Promise<void>((resolve, reject) => {
      socket!.once('connect', () => resolve());
      socket!.once('connect_error', reject);
    });
  });

  it('the assistant proposes a delivery flow for the request', async () => {
    const conversation = await engineer.post<{ id: string }>('/conversations', { projectId, title: 'Password reset' });
    await socket!.timeout(5000).emitWithAck('subscribe', { conversationId: conversation.id });
    await engineer.post(`/conversations/${conversation.id}/messages`, { content: REQUEST, pageContext: { route: '/projects', projectId } });
    const convo = await poll(
      () => engineer.get<{ messages: MessageRow[] }>(`/conversations/${conversation.id}`),
      (c) => c.messages.some((msg) => msg.role === 'ASSISTANT' && msg.status === 'complete'),
      { label: 'assistant reply' },
    );
    const reply = convo.messages.find((msg) => msg.role === 'ASSISTANT' && msg.status === 'complete')!;
    const proposal = reply.parts.find((p) => p.type === 'flow_proposal');
    assert.ok(proposal?.proposalId, `assistant should propose a flow: ${JSON.stringify(reply.parts).slice(0, 500)}`);
    assert.equal(proposal.mode, 'LIVE');
    assert.deepEqual(proposal.missingIntegrations, [], 'all required integrations are connected');
    assert.ok((proposal.steps?.length ?? 0) > 20, 'full delivery flow proposed');
    assert.ok(
      proposal.approvalsRequired?.some((a) => a.includes('(deploy.production)')),
      `production approval disclosed: ${JSON.stringify(proposal.approvalsRequired)}`,
    );
    assert.ok(
      proposal.approvalsRequired?.some((a) => a.includes('(deploy.staging)')),
      `staging gate resolved to its environment type: ${JSON.stringify(proposal.approvalsRequired)}`,
    );
    assert.ok(
      realtime.some((e) => e.type === 'agent.message.delta' || e.type === 'agent.message.completed'),
      'assistant output should stream over realtime',
    );

    // A viewer-level action would be rejected; the engineer may start it.
    const started = await engineer.post<{ execution: { id: string; mode: string } }>(
      `/conversations/${conversation.id}/proposals/${proposal.proposalId}/start`,
      {},
    );
    executionId = started.execution.id;
    assert.equal(started.execution.mode, 'LIVE');
    assert.ok(executionId);
    await socket!.timeout(5000).emitWithAck('subscribe', { executionId });
  });

  it('runs the flow, enforcing approval policy with four-eyes for production', async () => {
    const decided = new Set<string>();
    const result = await poll(
      async () => {
        const d = await engineer.get<ExecutionDetail>(`/workflow-executions/${executionId}`);
        for (const a of d.approvals.filter((x) => x.status === 'PENDING' && !decided.has(x.id))) {
          decided.add(a.id);
          if (a.action === 'deploy.staging') {
            await engineer.post(`/approvals/${a.id}/approve`, { comment: 'Staging looks good' });
          } else {
            // The initiator may never approve their own production deploy / merge.
            await assert.rejects(
              engineer.post(`/approvals/${a.id}/approve`, {}),
              (e: ApiError) => e.status === 403,
              `engineer must not approve ${a.action}`,
            );
            await lead.post(`/approvals/${a.id}/approve`, { comment: 'LGTM' });
          }
        }
        return d;
      },
      (d) => TERMINAL.has(d.status),
      { timeoutMs: 8 * 60_000, intervalMs: 750, label: 'execution to finish' },
    );

    const table = result.steps.map((s) => `${s.stepKey}:${s.status}:${s.iteration}`).join(', ');
    assert.equal(result.status, 'COMPLETED', `run failed: ${JSON.stringify(result.error)} — ${table}`);
    assert.equal(result.mode, 'LIVE');

    // The repair loop genuinely ran: first validation failed, the fix passed.
    const validations = result.steps.filter((s) => s.stepKey === 'validate_code');
    assert.ok(validations.length >= 2 || validations.some((s) => s.iteration > 0), `expected a repair iteration: ${table}`);

    // Gates.
    const actions = result.approvals.map((a) => `${a.action}:${a.status}`).sort();
    assert.ok(actions.includes('deploy.staging:APPROVED'));
    assert.ok(actions.includes('deploy.production:APPROVED'));
    assert.ok(actions.includes('pr.merge:APPROVED'));
    const prod = result.approvals.find((a) => a.action === 'deploy.production')!;
    assert.equal(prod.decidedById, leadId);

    // Deployments and real (non-simulated) external resources.
    assert.deepEqual(result.deployments.map((d) => `${d.environment.name}:${d.status}`).sort(), [
      'production:SUCCEEDED',
      'staging:SUCCEEDED',
    ]);
    assert.ok(result.externalResources.length > 0);
    assert.ok(
      result.externalResources.every((r) => !r.simulated),
      'live runs never produce simulated resources',
    );
  });

  it('produced the real side effects in the external systems', async () => {
    const state = await mock<{
      github: { pulls: { merged: boolean; head: string }[]; reviews: unknown[]; mainFiles: string[]; runs: number };
      jira: { key: string; status: string; comments: number }[];
      notion: { title: string; blocks: number }[];
      devops: { pipelines: number; deployments: { environment: string }[]; signatureFailures: number };
      slack: number;
      envHits: Record<string, number>;
    }>('/__state');

    assert.equal(state.jira.length, 1, 'exactly one ticket (idempotent creation)');
    assert.ok(state.jira[0]!.comments > 0, 'ticket was updated with progress');
    assert.equal(state.github.pulls.length, 1);
    assert.equal(state.github.pulls[0]!.merged, true, 'PR merged after approval');
    assert.ok(state.github.reviews.length >= 1, 'AI review published to the PR');
    assert.ok(state.github.mainFiles.includes('src/password-reset.js'));
    assert.ok(state.github.mainFiles.includes('test/password-reset.test.js'));
    assert.ok(state.notion.length >= 1, 'documentation published');
    assert.ok(state.github.runs >= 1, 'PR checks ran on GitHub Actions');
    assert.deepEqual(state.devops.deployments.map((d) => d.environment).sort(), ['production', 'staging']);
    assert.equal(state.devops.signatureFailures, 0, 'every DevOps request was HMAC signed');
    assert.ok(
      (state.envHits['staging/health'] ?? 0) > 0 && (state.envHits['production/login'] ?? 0) > 0,
      'health and smoke checks hit the environments',
    );
    assert.ok(state.slack >= 1, 'team notified');
  });

  it('streamed progress in real time and recorded a full audit trail', async () => {
    const types = new Set(realtime.filter((e) => e.executionId === executionId).map((e) => e.type));
    for (const t of ['workflow.step.started', 'workflow.step.completed', 'approval.requested', 'workflow.completed']) {
      assert.ok(types.has(t), `missing realtime event ${t}; got ${[...types].join(', ')}`);
    }

    const audit: { action: string; status: string }[] = [];
    for (let page = 1; ; page++) {
      const res = await owner.get<{ items: { action: string; status: string }[]; total: number }>(
        `/audit?executionId=${executionId}&page=${page}&pageSize=100`,
      );
      audit.push(...res.items);
      if (audit.length >= res.total || !res.items.length) break;
    }
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ['workflow.run_started', 'workflow.run_completed', 'approval.requested', 'approval.approved'])
      assert.ok(actions.has(a), `audit missing ${a}; got ${[...actions].join(', ')}`);
    assert.ok(
      [...actions].some((a) => a.startsWith('tool.')),
      'tool executions are audited',
    );
    assert.ok(
      audit.some((a) => a.status === 'DENIED'),
      'denied approval attempts are audited',
    );

    const logs = await engineer.get<{ items: unknown[] } | unknown[]>(`/workflow-executions/${executionId}/logs`);
    assert.ok((Array.isArray(logs) ? logs : logs.items).length > 0);
  });

  it('runs a pipeline on the custom DevOps platform from a command', async () => {
    const before = (await mock<{ devops: { pipelines: number } }>('/__state')).devops.pipelines;
    const exec = await engineer.post<{ id: string; mode: string }>('/commands/ci.run/execute', { projectId, inputs: { ref: 'main' } });
    const done = await poll(
      () => engineer.get<ExecutionDetail>(`/workflow-executions/${exec.id}`),
      (d) => TERMINAL.has(d.status),
      { timeoutMs: 60_000, label: 'pipeline run' },
    );
    assert.equal(done.status, 'COMPLETED', JSON.stringify(done.error));
    const after = await mock<{ devops: { pipelines: number; signatureFailures: number } }>('/__state');
    assert.equal(after.devops.pipelines, before + 1);
    assert.equal(after.devops.signatureFailures, 0);
  });

  it('isolates tenants: other organizations cannot see the run', async () => {
    const outsider = await anon.post<Session>('/auth/register', {
      email: `outsider-${randomBytes(4).toString('hex')}@other.test`,
      name: 'Oscar Outsider',
      password: PASSWORD,
    });
    const other = anon.as(outsider.accessToken, outsider.memberships[0]!.organizationId);
    await assert.rejects(other.get(`/workflow-executions/${executionId}`), (e: ApiError) => e.status === 404);
    await assert.rejects(other.get(`/projects/${projectId}`), (e: ApiError) => e.status === 404);
    // Forging the org header does not grant access.
    await assert.rejects(
      anon.as(outsider.accessToken, orgId).get(`/workflow-executions/${executionId}`),
      (e: ApiError) => e.status === 403 || e.status === 401,
    );
  });
});
