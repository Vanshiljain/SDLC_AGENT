import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureHttpApp } from '../src/main';
import { loadConfig } from '../src/config/configuration';

export const PASSWORD = 'Integration!2026';

export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  configureHttpApp(app, loadConfig());
  await app.init();
  return app;
}

export const uid = () => randomBytes(4).toString('hex');

export interface TestUser {
  token: string;
  userId: string;
  orgId: string;
  email: string;
  cookies: string[];
}

export async function register(app: NestExpressApplication, name = 'Test User'): Promise<TestUser> {
  const email = `it-${uid()}@forgeline.test`;
  const res = await request(app.getHttpServer()).post('/api/auth/register').send({ email, name, password: PASSWORD, organizationName: `Org ${uid()}` }).expect(201);
  return { token: res.body.accessToken, userId: res.body.user.id, orgId: res.body.memberships[0].organizationId, email, cookies: setCookies(res) };
}

/** Invites a new user into `owner`'s organisation with the given role and returns their session. */
export async function invite(app: NestExpressApplication, owner: TestUser, role: 'ADMIN' | 'MEMBER' | 'VIEWER', name = `${role} user`): Promise<TestUser> {
  const email = `it-${uid()}@forgeline.test`;
  const inv = await authed(app, owner).post('/api/organizations/current/invitations').send({ email, role }).expect(201);
  const token = new URL(inv.body.inviteUrl).searchParams.get('token');
  const res = await request(app.getHttpServer()).post('/api/auth/accept-invite').send({ token, name, password: PASSWORD }).expect(201);
  return { token: res.body.accessToken, userId: res.body.user.id, orgId: owner.orgId, email, cookies: setCookies(res) };
}

export function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
}

export function cookieValue(cookies: string[], name: string): string | undefined {
  const c = cookies.find((x) => x.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.split(';')[0]!.slice(name.length + 1)) : undefined;
}

/** supertest agent with bearer token + organisation header. */
export function authed(app: NestExpressApplication, user: Pick<TestUser, 'token' | 'orgId'>, orgId = user.orgId) {
  const server = app.getHttpServer();
  const wrap = (req: request.Test) => req.set('Authorization', `Bearer ${user.token}`).set('X-Organization-Id', orgId);
  return {
    get: (url: string) => wrap(request(server).get(url)),
    post: (url: string) => wrap(request(server).post(url)),
    patch: (url: string) => wrap(request(server).patch(url)),
    put: (url: string) => wrap(request(server).put(url)),
    delete: (url: string) => wrap(request(server).delete(url)),
  };
}

export async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  throw new Error(`waitFor timed out; last: ${JSON.stringify(last).slice(0, 1500)}`);
}
