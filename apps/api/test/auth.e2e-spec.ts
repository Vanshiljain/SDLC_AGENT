import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { authed, cookieValue, createTestApp, PASSWORD, register, setCookies } from './helpers';

describe('Auth & sessions', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const refresh = (refreshCookie: string | undefined, csrf: string | undefined, sendHeader = true) => {
    const cookies = [refreshCookie && `fl_refresh=${refreshCookie}`, csrf && `fl_csrf=${csrf}`].filter(Boolean).join('; ');
    const req = request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', cookies);
    return sendHeader && csrf ? req.set('X-CSRF-Token', csrf) : req;
  };

  it('issues an access token and secure session cookies; the refresh token never appears in the body', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `reg-${Date.now()}@forgeline.test`, name: 'Reg', password: PASSWORD })
      .expect(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/refresh/i);
    const cookies = setCookies(res);
    const rt = cookies.find((c) => c.startsWith('fl_refresh='))!;
    expect(rt).toMatch(/HttpOnly/i);
    expect(rt).toMatch(/SameSite=Strict/i);
    expect(rt).toMatch(/Path=\/api\/auth/);
    expect(cookies.find((c) => c.startsWith('fl_csrf='))).not.toMatch(/HttpOnly/i);
  });

  it('rejects weak passwords and duplicate emails', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `weak-${Date.now()}@forgeline.test`, name: 'W', password: 'password' })
      .expect(400);
    const u = await register(app);
    await request(app.getHttpServer()).post('/api/auth/register').send({ email: u.email, name: 'Dup', password: PASSWORD }).expect(409);
  });

  it('rejects bad credentials without revealing which part was wrong', async () => {
    const u = await register(app);
    const a = await request(app.getHttpServer()).post('/api/auth/login').send({ email: u.email, password: 'Wrong!Password1' }).expect(401);
    const b = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: `nobody-${Date.now()}@forgeline.test`, password: PASSWORD })
      .expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('requires a bearer token on protected routes', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/projects').set('Authorization', 'Bearer not-a-jwt').expect(401);
  });

  it('requires the CSRF double-submit header to refresh', async () => {
    const u = await register(app);
    const rt = cookieValue(u.cookies, 'fl_refresh');
    const csrf = cookieValue(u.cookies, 'fl_csrf');
    await refresh(rt, csrf, false).expect(403);
    await refresh(rt, 'forged').set('X-CSRF-Token', csrf!).expect(403);
    const ok = await refresh(rt, csrf).expect(200);
    expect(ok.body.accessToken).toEqual(expect.any(String));
  });

  it('rotates refresh tokens and revokes the whole family when an old token is replayed', async () => {
    const u = await register(app);
    const rt1 = cookieValue(u.cookies, 'fl_refresh');
    const csrf = cookieValue(u.cookies, 'fl_csrf');
    const r1 = await refresh(rt1, csrf).expect(200);
    const rt2 = cookieValue(setCookies(r1), 'fl_refresh');
    expect(rt2).toBeDefined();
    expect(rt2).not.toBe(rt1);
    // Replaying the rotated token is treated as theft…
    await refresh(rt1, csrf).expect(401);
    // …and the attacker's (or user's) newer token stops working too.
    await refresh(rt2, csrf).expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const u = await register(app);
    const rt = cookieValue(u.cookies, 'fl_refresh');
    const csrf = cookieValue(u.cookies, 'fl_csrf');
    await request(app.getHttpServer()).post('/api/auth/logout').set('Cookie', `fl_refresh=${rt}`).expect(204);
    await refresh(rt, csrf).expect(401);
  });

  it('returns memberships and effective permissions', async () => {
    const u = await register(app);
    const me = await authed(app, u).get('/api/auth/me').expect(200);
    expect(me.body.memberships[0].role).toBe('OWNER');
    expect(me.body.permissions).toEqual(expect.arrayContaining(['org:manage', 'integration:manage', 'deploy:production']));
  });
});
