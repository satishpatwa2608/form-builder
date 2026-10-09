import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { MAILER, type Mail } from '../src/common/mailer';
import { loadConfig } from '../src/config';

export const PASSWORD = 'correct horse battery';

/** The real app on an in-memory MongoDB, with mail captured instead of sent. */
export async function startApp(env: Record<string, string> = {}) {
  const mongo = await MongoMemoryServer.create();
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URL: mongo.getUri(),
    JWT_SECRET: randomBytes(48).toString('base64'),
    SECRET_KEY: randomBytes(32).toString('base64'),
    // Feature tests shouldn't trip plan limits; plans.e2e-spec sets FREE itself.
    DEFAULT_PLAN: 'ENTERPRISE',
    ...env,
  });
  const outbox: Mail[] = [];
  /** What the app sends mail with; a test can swap `send` to make sending fail. */
  const mailer: { send: (m: Mail) => Promise<void> } = { send: async (m: Mail) => void outbox.push(m) };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, config);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const api = () => request(base);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  /** The token from the last email to `to` whose text contains `path`. */
  const tokenFrom = (to: string, path: string) => {
    const mail = [...outbox].reverse().find((m) => m.to === to && m.text.includes(path));
    const match = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
    if (!match) throw new Error(`No ${path} mail for ${to}`);
    return match[1]!;
  };
  const refreshCookie = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('fb_rt='))
      ?.split(';')[0] ?? '';
  async function signUp(name: string, email: string, orgName: string) {
    await api().post('/auth/signup').send({ name, email, password: PASSWORD, orgName }).expect(202);
    await api().post('/auth/verify-email').send({ token: tokenFrom(email, '/verify-email') }).expect(200);
  }
  async function login(email: string, extra: Record<string, unknown> = {}) {
    const res = await api().post('/auth/login').send({ email, password: PASSWORD, ...extra }).expect(200);
    return { token: res.body.accessToken as string, cookie: refreshCookie(res) };
  }
  /** Invite someone into the owner's org with a role and have them accept; returns their user id. */
  async function addMember(ownerToken: string, name: string, email: string, role: string) {
    await api().post('/invitations').set(bearer(ownerToken)).send({ email, role }).expect(201);
    await api().post('/invitations/accept').send({ token: tokenFrom(email, '/accept-invite'), name, password: PASSWORD }).expect(200);
    const members = (await api().get('/members').set(bearer(ownerToken)).expect(200)).body as { userId: string; email: string }[];
    return members.find((m) => m.email === email)!.userId;
  }

  /** Local-storage upload links name the configured API_URL; point them at this test server. */
  const localUrl = (url: string) => url.replace(/^https?:\/\/[^/]+/, base);

  return {
    app,
    base,
    localUrl,
    config,
    outbox,
    mailer,
    api,
    bearer,
    tokenFrom,
    refreshCookie,
    signUp,
    login,
    addMember,
    close: async () => {
      await app.close();
      await mongo.stop();
    },
  };
}
export type Harness = Awaited<ReturnType<typeof startApp>>;
