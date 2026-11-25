import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

import { selectToken, sessionEnded } from '@/features/auth/authSlice';
import { createSessionStore, type Session } from '@/features/auth/session';
import { createHttpClient } from '@/lib/api';
import { createQueryClient } from '@/lib/query/queryClient';
import { createMemoryStorage } from '@/lib/storage/jsonStorage';
import { AppProviders } from '@/providers/AppProviders';
import { createAppStore } from '@/store/store';

import { createFakeAdapter } from './fakeAdapter';
import { testRouter } from './navigation';

/** Every permission the Go API defines: what an administrator holds. */
export const ADMIN_PERMISSIONS = [
  'audit:read',
  'catalogue:manage',
  'hotspots:activate',
  'hotspots:all_districts',
  'hotspots:read',
  'hotspots:submit',
  'inventory:manage',
  'inventory:read',
  'orders:all_stores',
  'orders:process',
  'orders:read',
  'orders:receive',
  'orders:replenish',
  'orders:stockout',
  'orders:supply_hotspots',
  'roles:assign',
  'roles:manage',
  'roles:read',
  'sync_logs:read',
  'users:create',
  'users:read',
  'users:update',
];

export const testSession: Session = {
  token: 'test-token',
  user: {
    id: '1',
    username: 'snakato',
    role: 'Admin',
    firstname: 'Sarah',
    lastname: 'Nakato',
    email: 'sarah@example.org',
    permissions: ADMIN_PERMISSIONS,
    roleNames: ['admin'],
    store_id: null,
    must_change_password: false,
  },
};

/**
 * {@link testSession} holding only `permissions`, for screens that leave out
 * what a user may not do, and optionally other roles, for screens that depend
 * on the workspace a role opens.
 */
export function sessionWith(permissions: string[], roleNames: string[] = ['admin']): Session {
  return { ...testSession, user: { ...testSession.user, permissions, roleNames } };
}

interface RenderAppOptions {
  /** Initial address, e.g. `/moh/users`. */
  route?: string;
  /** Start signed in as {@link testSession}. */
  signedIn?: boolean;
  /** Start signed in with this session instead, e.g. {@link sessionWith}. Implies `signedIn`. */
  session?: Session;
  /** Scripted API replies, consumed in order. */
  replies?: Parameters<typeof createFakeAdapter>;
}

/**
 * Renders `ui` inside the real provider stack, wired exactly as `AppRoot`
 * wires it, but against in-memory storage, a scripted network and the test
 * router, which starts at `route`.
 */
export function renderApp(
  ui: ReactNode,
  {
    route = '/',
    signedIn = false,
    session,
    replies = [{ status: 200, body: [] }],
  }: RenderAppOptions = {},
) {
  testRouter.reset(route);
  const initial = session ?? (signedIn ? testSession : null);
  const storage = createMemoryStorage(initial ? { 'clims.session': JSON.stringify(initial) } : {});
  const store = createAppStore({ sessionStore: createSessionStore(storage) });
  const onMutationError = vi.fn();
  const queryClient = createQueryClient({ onMutationError });
  const { adapter, requests } = createFakeAdapter(...replies);
  const http = createHttpClient({
    baseUrl: '/api',
    getToken: () => selectToken(store.getState()),
    onUnauthorized: () => store.dispatch(sessionEnded()),
    adapter,
  });

  const view = render(
    <AppProviders
      config={{ apiBaseUrl: '/api', mapTiles: { kind: 'off' } }}
      store={store}
      queryClient={queryClient}
      http={http}
      storage={storage}
    >
      {ui}
    </AppProviders>,
  );

  return { ...view, store, storage, requests, onMutationError };
}
