import type { NestExpressApplication } from '@nestjs/platform-express';
import { authed, createTestApp, invite, register, type TestUser } from './helpers';

describe('Tenant isolation & RBAC', () => {
  let app: NestExpressApplication;
  let ownerA: TestUser;
  let ownerB: TestUser;
  let projectA: string;

  beforeAll(async () => {
    app = await createTestApp();
    ownerA = await register(app, 'Owner A');
    ownerB = await register(app, 'Owner B');
    const p = await authed(app, ownerA).post('/api/projects').send({ name: 'Billing', key: 'BILL', createDefaultEnvironments: true }).expect(201);
    projectA = p.body.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('hides other organisations’ resources (404, not 403)', async () => {
    await authed(app, ownerB).get(`/api/projects/${projectA}`).expect(404);
    const list = await authed(app, ownerB).get('/api/projects').expect(200);
    expect(list.body.map((p: { id: string }) => p.id)).not.toContain(projectA);
  });

  it('rejects a forged organisation header', async () => {
    await authed(app, ownerB, ownerA.orgId).get('/api/projects').expect(403);
  });

  it('viewers can read but not create or change', async () => {
    const viewer = await invite(app, ownerA, 'VIEWER');
    await authed(app, viewer).get('/api/projects').expect(200);
    await authed(app, viewer).post('/api/projects').send({ name: 'Nope', key: 'NOPE' }).expect(403);
    await authed(app, viewer).patch(`/api/projects/${projectA}`).send({ description: 'x' }).expect(403);
  });

  it('members cannot manage integrations or invite people', async () => {
    const member = await invite(app, ownerA, 'MEMBER');
    await authed(app, member).post('/api/integrations/github/connect').send({ credentials: { token: 'ghp_x' } }).expect(403);
    await authed(app, member).post('/api/organizations/current/invitations').send({ email: 'x@forgeline.test', role: 'ADMIN' }).expect(403);
  });

  it('records denied attempts in the audit log', async () => {
    const audit = await authed(app, ownerA).get('/api/audit?status=DENIED&pageSize=100').expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
  });

  it('validates input strictly (unknown fields are rejected)', async () => {
    await authed(app, ownerA).post('/api/projects').send({ name: 'X', key: 'lower', isAdmin: true }).expect(400);
  });
});
