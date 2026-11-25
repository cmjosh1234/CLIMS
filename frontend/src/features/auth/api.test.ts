import { describe, expect, it, vi } from 'vitest';

import { ApiError, createHttpClient } from '@/lib/api';
import { createFakeAdapter } from '@/test/fakeAdapter';

import {
  completePortalSignIn,
  getCurrentUser,
  listMySessions,
  revokeMySession,
  signIn,
} from './api';

function setup(...script: Parameters<typeof createFakeAdapter>) {
  const { adapter, requests } = createFakeAdapter(...script);
  const onUnauthorized = vi.fn();
  const http = createHttpClient({
    baseUrl: '/api',
    getToken: () => 'old',
    onUnauthorized,
    adapter,
  });
  return { http, requests, onUnauthorized };
}

describe('signIn', () => {
  it('returns the session from a successful login', async () => {
    const { http, requests } = setup({
      status: 200,
      body: {
        success: true,
        message: 'login successful',
        data: {
          token: 'tok_9',
          token_type: 'Bearer',
          expires_in: 86400,
          user: {
            id: 2,
            username: 'okello',
            email: 'okello@example.org',
            status: 'active',
            role: { id: 5, name: 'dfcp', permissions: ['users:read'] },
          },
        },
      },
    });

    const session = await signIn(http, { login: 'okello@example.org', password: 'secret' });

    expect(session.token).toBe('tok_9');
    expect(session.user).toMatchObject({ id: '2', username: 'okello', role: 'dfcp' });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/auth/login',
      body: { login: 'okello@example.org', password: 'secret' },
    });
  });

  it('never sends a previous token with the credentials', async () => {
    const { http, requests } = setup({
      status: 200,
      body: { token: 't', user: { id: 1, username: 'u' } },
    });
    await signIn(http, { login: 'u@example.org', password: 'p' });
    expect(requests[0]?.authorization).toBeNull();
  });

  it('rejects wrong credentials reported in the legacy envelope, without ending a session', async () => {
    const { http, onUnauthorized } = setup({
      status: 200,
      body: { code: '401', message: 'Invalid username or password' },
    });

    await expect(signIn(http, { login: 'u@example.org', password: 'wrong' })).rejects.toMatchObject(
      {
        kind: 'unauthorized',
        message: 'Invalid username or password',
      },
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('rejects a success response that carries no token', async () => {
    const { http } = setup({ status: 200, body: { code: '200', user: { id: 1, username: 'u' } } });
    const failure = signIn(http, { login: 'u@example.org', password: 'p' });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ kind: 'unexpected_response' });
  });
});

describe('signIn against the Go API', () => {
  it('rejects a 401 as wrong credentials, without ending a session', async () => {
    const { http, onUnauthorized } = setup({
      status: 401,
      body: { success: false, message: 'invalid credentials' },
    });
    await expect(signIn(http, { login: 'u@example.org', password: 'wrong' })).rejects.toMatchObject(
      { kind: 'unauthorized', message: 'invalid credentials' },
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

const goSession = {
  id: '6f1c2e9a-1b2c-4d3e-8f4a-5b6c7d8e9f00',
  user_agent: 'okhttp/4.12.0',
  ip_address: '41.210.143.92',
  created_at: '2026-11-18T08:00:00Z',
  last_seen_at: '2026-11-20T09:30:00Z',
  expires_at: '2026-12-18T08:00:00Z',
  revoked_at: null,
  refreshed_at: '2026-11-20T09:30:00Z',
  refresh_count: 4,
  current: false,
};

describe('getCurrentUser', () => {
  it('reads GET /auth/me with the permissions of every role held and the assigned store', async () => {
    const { http, requests } = setup({
      status: 200,
      body: {
        success: true,
        data: {
          id: '0b9e6f1c-4a51-4f7e-9d0a-2f3c8e1b7a64',
          username: 'okello',
          firstname: 'James',
          lastname: 'Okello',
          email: 'okello@example.org',
          store_id: '5d1c2b3a-0000-4000-8000-000000000001',
          active_sessions: 2,
          role: { id: 'r-1', name: 'dfcp', permissions: ['orders:read'] },
          roles: [
            { id: 'r-1', name: 'dfcp', permissions: ['orders:read'] },
            { id: 'r-2', name: 'vht', permissions: ['hotspots:submit'] },
          ],
        },
      },
    });

    const user = await getCurrentUser(http);

    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: '/auth/me',
      authorization: 'Bearer old',
    });
    expect(user).toEqual({
      id: '0b9e6f1c-4a51-4f7e-9d0a-2f3c8e1b7a64',
      username: 'okello',
      firstname: 'James',
      lastname: 'Okello',
      email: 'okello@example.org',
      role: 'dfcp',
      permissions: ['hotspots:submit', 'orders:read'],
      roleNames: ['dfcp', 'vht'],
      store_id: '5d1c2b3a-0000-4000-8000-000000000001',
      must_change_password: false,
    });
  });

  it('rejects a deactivated account as forbidden', async () => {
    const { http } = setup({
      status: 403,
      body: { success: false, message: 'account is disabled' },
    });
    await expect(getCurrentUser(http)).rejects.toMatchObject({
      kind: 'forbidden',
      message: 'account is disabled',
    });
  });
});

describe('listMySessions', () => {
  it('reads GET /auth/sessions, keeping signed-out sessions for the caller to filter', async () => {
    const { http, requests } = setup({
      status: 200,
      body: {
        success: true,
        data: [
          { ...goSession, id: 'a', current: true, user_agent: null },
          { ...goSession, id: 'b', revoked_at: '2026-11-20T10:00:00Z' },
        ],
      },
    });

    const sessions = await listMySessions(http);

    expect(requests[0]).toMatchObject({ method: 'GET', url: '/auth/sessions' });
    expect(sessions).toMatchObject([
      { id: 'a', current: true, user_agent: null, revoked_at: null },
      { id: 'b', current: false, revoked_at: '2026-11-20T10:00:00Z' },
    ]);
  });

  it('refuses a reply that is not a list of sessions', async () => {
    const { http } = setup({ status: 200, body: { success: true, data: [{ id: 'a' }] } });
    await expect(listMySessions(http)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('revokeMySession', () => {
  it('sends DELETE /auth/sessions/:id with the id encoded', async () => {
    const { http, requests } = setup({ status: 200, body: { success: true, data: null } });
    await revokeMySession(http, 'a/b');
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: '/auth/sessions/a%2Fb' });
  });

  it('rejects not_found when the device was already signed out', async () => {
    const { http } = setup({ status: 404, body: { success: false, message: 'session not found' } });
    await expect(revokeMySession(http, goSession.id)).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('completePortalSignIn', () => {
  it('claims the handed-off session without sending a stored token', async () => {
    const { http, requests } = setup({
      status: 200,
      body: {
        success: true,
        data: {
          token: 'tok_sso',
          refresh_token: 'refresh_sso',
          user: {
            id: '6f1c2a7e-0000-4000-8000-000000000001',
            username: 'akello',
            role: { id: 2, name: 'dcfp', permissions: [] },
          },
        },
      },
    });

    const session = await completePortalSignIn(http);

    expect(session).toMatchObject({
      token: 'tok_sso',
      refresh_token: 'refresh_sso',
      user: { username: 'akello' },
    });
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/auth/sso/exchange' });
    expect(requests[0]?.authorization).toBeNull();
  });

  it('rejects an expired or reused handoff without ending a local session', async () => {
    const { http, onUnauthorized } = setup({
      status: 401,
      body: { success: false, message: 'start sign-in again from the portal' },
    });
    await expect(completePortalSignIn(http)).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
