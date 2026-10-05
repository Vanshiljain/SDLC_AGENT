import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ToolExecutor } from '../src/tools/tool-executor.service';
import { RecoveryService } from '../src/workflow-execution/recovery.service';
import { RedisService } from '../src/common/redis/redis.provider';
import { authed, createTestApp, invite, register, waitFor, type TestUser } from './helpers';

interface Run {
  id: string;
  status: string;
  mode: string;
  steps: { id: string; stepKey: string; status: string; output: Record<string, unknown> | null; error: { message: string } | null }[];
  approvals: { id: string; status: string; action: string }[];
}

describe('Workflow engine (end-to-end through the API)', () => {
  let app: NestExpressApplication;
  let owner: TestUser;
  let projectId: string;

  const getRun = (id: string, user = owner) => authed(app, user).get(`/api/workflow-executions/${id}`).then((r) => r.body as Run);
  const settled = (r: Run) => ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_APPROVAL'].includes(r.status);
  const step = (r: Run, key: string) => r.steps.filter((s) => s.stepKey === key).at(-1)!;

  beforeAll(async () => {
    app = await createTestApp();
    owner = await register(app, 'Engine Owner');
    const p = await authed(app, owner).post('/api/projects').send({ name: 'Engine', key: 'ENG', createDefaultEnvironments: true }).expect(201);
    projectId = p.body.id;
  });
  afterAll(async () => {
    await app.close();
  });

  const branching = {
    version: 1,
    inputs: { go: { type: 'boolean', required: true }, label: { type: 'string', default: 'demo' } },
    steps: [
      { key: 'check', name: 'Check', type: 'condition', expression: 'inputs.go == true' },
      { key: 'gate', name: 'Gate', type: 'approval', dependsOn: ['check'], when: 'steps.check.output.result == true', approval: { title: 'Ship {{ inputs.label }}?' } },
      { key: 'notify', name: 'Notify', tool: 'notify.team', dependsOn: ['gate'], input: { title: 'Shipped', message: 'Run {{ inputs.label }} finished' } },
      { key: 'never', name: 'Never', tool: 'notify.team', dependsOn: ['check'], when: 'steps.check.output.result == false', input: { title: 'x', message: 'y' } },
    ],
  };

  it('rejects invalid definitions (cycles, unknown tools, bad references)', async () => {
    const cyc = await authed(app, owner)
      .post('/api/workflows/validate')
      .send({ definition: { steps: [{ key: 'a', name: 'A', tool: 'notify.team', dependsOn: ['b'] }, { key: 'b', name: 'B', tool: 'notify.team', dependsOn: ['a'] }] } })
      .expect(200);
    expect(cyc.body.valid).toBe(false);
    const unknown = await authed(app, owner).post('/api/workflows/validate').send({ definition: { steps: [{ key: 'a', name: 'A', tool: 'does.notExist' }] } }).expect(200);
    expect(unknown.body.valid).toBe(false);
    const badRef = await authed(app, owner)
      .post('/api/workflows/validate')
      .send({ definition: { steps: [{ key: 'a', name: 'A', tool: 'notify.team', input: { title: '{{ steps.zzz.output.x }}', message: 'm' } }] } })
      .expect(200);
    expect(badRef.body.valid).toBe(false);
    await authed(app, owner).post('/api/workflows').send({ name: 'Broken', definition: { steps: [{ key: 'a', name: 'A', tool: 'nope.tool' }] } }).expect(400);
  });

  it('branches, pauses at an approval gate, resumes on approval, and records the outcome', async () => {
    const wf = await authed(app, owner).post('/api/workflows').send({ name: 'Branching', projectId, definition: branching }).expect(201);
    const started = await authed(app, owner).post(`/api/workflows/${wf.body.id}/run`).send({ projectId, input: { go: true, label: 'v2' } }).expect(201);
    expect(started.body.mode).toBe('LIVE');

    let run = await waitFor(() => getRun(started.body.id), (r) => r.status === 'WAITING_APPROVAL');
    expect(step(run, 'check').output).toMatchObject({ result: true });
    expect(step(run, 'never').status).toBe('SKIPPED');
    const gate = run.approvals.find((a) => a.status === 'PENDING')!;
    expect(gate.action).toBe('workflow.gate');

    await authed(app, owner).post(`/api/approvals/${gate.id}/approve`).send({ comment: 'go' }).expect(201);
    run = await waitFor(() => getRun(started.body.id), (r) => ['COMPLETED', 'FAILED'].includes(r.status));
    expect(run.status).toBe('COMPLETED');
    expect(step(run, 'notify').status).toBe('COMPLETED');
    // Without Slack connected, notify.team honestly falls back to in-app notifications.
    expect(JSON.stringify(step(run, 'notify').output)).toMatch(/in-app|inApp|notification/i);

    const audit = await authed(app, owner).get(`/api/audit?executionId=${run.id}&pageSize=100`).expect(200);
    const actions = audit.body.items.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['workflow.run_started', 'approval.requested', 'approval.approved', 'workflow.run_completed']));
  });

  it('skips the gated branch when the condition is false', async () => {
    const wf = await authed(app, owner).post('/api/workflows').send({ name: 'Branching (false)', projectId, definition: branching }).expect(201);
    const started = await authed(app, owner).post(`/api/workflows/${wf.body.id}/run`).send({ projectId, input: { go: false } }).expect(201);
    const run = await waitFor(() => getRun(started.body.id), settled);
    expect(run.status).toBe('COMPLETED');
    expect(step(run, 'gate').status).toBe('SKIPPED');
    expect(step(run, 'notify').status).toBe('SKIPPED');
    expect(step(run, 'never').status).toBe('COMPLETED');
  });

  it('fails the step when an approval is rejected', async () => {
    const wf = await authed(app, owner).post('/api/workflows').send({ name: 'Rejected', projectId, definition: branching }).expect(201);
    const started = await authed(app, owner).post(`/api/workflows/${wf.body.id}/run`).send({ projectId, input: { go: true } }).expect(201);
    let run = await waitFor(() => getRun(started.body.id), (r) => r.status === 'WAITING_APPROVAL');
    await authed(app, owner).post(`/api/approvals/${run.approvals[0]!.id}/reject`).send({ comment: 'not today' }).expect(201);
    run = await waitFor(() => getRun(started.body.id), (r) => ['COMPLETED', 'FAILED'].includes(r.status));
    expect(run.status).toBe('FAILED');
    expect(step(run, 'notify').status).toBe('SKIPPED');
  });

  it('a viewer cannot decide approvals or start runs', async () => {
    const viewer = await invite(app, owner, 'VIEWER');
    const wf = await authed(app, owner).post('/api/workflows').send({ name: 'Gate for viewer', projectId, definition: branching }).expect(201);
    await authed(app, viewer).post(`/api/workflows/${wf.body.id}/run`).send({ projectId, input: { go: true } }).expect(403);
    const started = await authed(app, owner).post(`/api/workflows/${wf.body.id}/run`).send({ projectId, input: { go: true } }).expect(201);
    const run = await waitFor(() => getRun(started.body.id), (r) => r.status === 'WAITING_APPROVAL');
    await authed(app, viewer).post(`/api/approvals/${run.approvals[0]!.id}/approve`).send({}).expect(403);
  });

  it('blocks requests to private networks (SSRF guard) and lets a failed step be retried', async () => {
    const def = { steps: [{ key: 'probe', name: 'Probe', tool: 'http.request', retry: { maxAttempts: 1 }, input: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data' } }] };
    const wf = await authed(app, owner).post('/api/workflows').send({ name: 'SSRF', projectId, definition: def }).expect(201);
    const started = await authed(app, owner).post(`/api/workflows/${wf.body.id}/run`).send({ projectId }).expect(201);
    let run = await waitFor(() => getRun(started.body.id), settled);
    expect(run.status).toBe('FAILED');
    expect(step(run, 'probe').error?.message).toMatch(/private|not allowed|blocked/i);

    await authed(app, owner).post(`/api/workflow-executions/${run.id}/steps/${step(run, 'probe').id}/retry`).send({}).expect(201);
    run = await waitFor(() => getRun(started.body.id), settled);
    expect(run.status).toBe('FAILED');
    const audit = await authed(app, owner).get(`/api/audit?executionId=${run.id}&pageSize=100`).expect(200);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toContain('workflow.step_retried');
  });

  it('recovers a step whose worker died, without repeating its side effect', async () => {
    const prisma = app.get(PrismaService);
    const def = { steps: [{ key: 'announce', name: 'Announce', tool: 'notify.team', input: { title: 'Recovered', message: 'exactly once' } }] };
    const wf = await authed(app, owner).post('/api/workflows').send({ name: 'Recovery', projectId, definition: def }).expect(201);
    const started = await authed(app, owner).post(`/api/workflows/${wf.body.id}/run`).send({ projectId }).expect(201);
    const done = await waitFor(() => getRun(started.body.id), settled);
    expect(done.status).toBe('COMPLETED');
    const stepId = step(done, 'announce').id;

    // Simulate a crash after the side effect but before the step was marked complete.
    await prisma.workflowExecution.update({ where: { id: done.id }, data: { status: 'RUNNING', completedAt: null } });
    await prisma.workflowExecutionStep.update({ where: { id: stepId }, data: { status: 'RUNNING', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(Date.now() - 60_000), completedAt: null, attempt: 1, maxAttempts: 3 } });
    await app.get(RedisService).client.del('forgeline:lock:recovery');
    const stats = await app.get(RecoveryService).sweep();
    expect(stats.expiredLeases).toBeGreaterThanOrEqual(1);

    const recovered = await waitFor(() => getRun(done.id), (r) => r.status === 'COMPLETED');
    expect(step(recovered, 'announce').status).toBe('COMPLETED');
    // The retry hit the idempotency ledger instead of notifying again.
    const ledger = await prisma.toolExecution.findMany({ where: { executionId: done.id, tool: 'notify.team' } });
    expect(ledger).toHaveLength(1);
  });

  it('executes a tool once per idempotency key (ledger)', async () => {
    const tools = app.get(ToolExecutor);
    const prisma = app.get(PrismaService);
    const key = `it:${owner.orgId}:${Date.now()}`;
    const inv = { tool: 'notify.team', input: { title: 'Once', message: 'only once' }, organizationId: owner.orgId, userId: owner.userId, projectId, idempotencyKey: key, mode: 'LIVE' as const };
    const first = await tools.execute(inv);
    const second = await tools.execute(inv);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.toolExecutionId).toBe(first.toolExecutionId);
    expect(await prisma.toolExecution.count({ where: { organizationId: owner.orgId, idempotencyKey: { endsWith: key } } })).toBe(1);
  });

  it('re-checks the acting user’s permissions at tool execution time', async () => {
    const viewer = await invite(app, owner, 'VIEWER');
    const tools = app.get(ToolExecutor);
    await expect(
      tools.execute({ tool: 'notify.team', input: { title: 't', message: 'm' }, organizationId: owner.orgId, userId: viewer.userId, projectId, idempotencyKey: `it:viewer:${Date.now()}`, mode: 'LIVE' }),
    ).rejects.toThrow(/permission/i);
  });
});
