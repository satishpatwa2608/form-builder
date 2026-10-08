import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fake-api';
import { api, ApiError, onSessionEnded, setAccessToken } from './api';

describe('api client', () => {
  beforeEach(() => setAccessToken(null));

  it('on a 401 refreshes once (shared by concurrent calls) and retries with the new token', async () => {
    let refreshes = 0;
    const { calls } = fakeApi({
      'POST /auth/refresh': () => (refreshes++, { body: { accessToken: 'new' } }),
      'GET /members': (_b, init) => ((init.headers as Record<string, string>).Authorization === 'Bearer new' ? { body: ['ok'] } : { status: 401, body: {} }),
      'GET /folders': (_b, init) => ((init.headers as Record<string, string>).Authorization === 'Bearer new' ? { body: [] } : { status: 401, body: {} }),
    });
    setAccessToken('old');
    const [a, b] = await Promise.all([api('/members'), api('/folders')]);
    expect(a).toEqual(['ok']);
    expect(b).toEqual([]);
    expect(refreshes).toBe(1);
    expect(calls.filter((c) => c.path === '/members').map((c) => c.auth)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('when the refresh fails too, the session ends', async () => {
    fakeApi({ 'POST /auth/refresh': () => ({ status: 401, body: {} }), 'GET /members': () => ({ status: 401, body: { message: 'Sign in to continue' } }) });
    const ended = vi.fn();
    onSessionEnded(ended);
    await expect(api('/members')).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalled();
  });

  it("a wrong password is an answer, not an expired session: no refresh; the server's message and field errors come through", async () => {
    const { calls } = fakeApi({
      'POST /auth/login': () => ({ status: 401, body: { message: 'Email or password is wrong' } }),
      'POST /auth/signup': () => ({ status: 400, body: { message: 'Some fields are not valid', errors: [{ field: 'password', message: 'Use at least 10 characters' }] } }),
    });
    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401, message: 'Email or password is wrong' });
    await expect(api('/auth/signup', { method: 'POST', body: {} })).rejects.toMatchObject({ fields: { password: 'Use at least 10 characters' } });
    expect(calls.some((c) => c.path === '/auth/refresh')).toBe(false);
  });
});
