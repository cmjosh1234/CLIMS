import { describe, expect, it } from 'vitest';

import { createMemoryStorage } from '@/lib/storage/jsonStorage';

import { createSessionStore, hasPermissions, sessionSchema, type Session } from './session';

const session: Session = {
  token: 'tok_1',
  user: {
    id: '4',
    username: 'nakato',
    role: 'admin',
    firstname: 'Nakato',
    lastname: null,
    email: null,
    permissions: null,
    roleNames: ['admin'],
    store_id: null,
    must_change_password: false,
  },
};

describe('sessionSchema', () => {
  it('normalises a numeric role id and a numeric user id', () => {
    const parsed = sessionSchema.parse({ token: 't', user: { id: 12, username: 'u', role: 3 } });
    expect(parsed.user).toMatchObject({ id: '12', role: '3', firstname: null, email: null });
  });

  it('keeps the Go API user id, a UUID string, as it is', () => {
    const id = '0b9e6f1c-4a51-4f7e-9d0a-2f3c8e1b7a64';
    const parsed = sessionSchema.parse({ token: 't', user: { id, username: 'u' } });
    expect(parsed.user.id).toBe(id);
  });

  it('keeps the refresh token when the API issues one', () => {
    const parsed = sessionSchema.parse({
      token: 't',
      refresh_token: 'r',
      user: { id: 1, username: 'u' },
    });
    expect(parsed.refresh_token).toBe('r');
  });

  it('reads the role name from the Go API role object', () => {
    const parsed = sessionSchema.parse({
      token: 't',
      user: { id: 1, username: 'admin', role: { id: 1, name: 'admin', permissions: [] } },
    });
    expect(parsed.user.role).toBe('admin');
  });

  it('accepts a user with no role', () => {
    expect(
      sessionSchema.parse({ token: 't', user: { id: 1, username: 'u' } }).user.role,
    ).toBeNull();
  });

  it.each([
    { name: 'a missing token', value: { user: { id: 1, username: 'u' } } },
    { name: 'an empty token', value: { token: '', user: { id: 1, username: 'u' } } },
    { name: 'a missing user', value: { token: 't' } },
    { name: 'a user without an id', value: { token: 't', user: { username: 'u' } } },
    { name: 'an empty id', value: { token: 't', user: { id: '', username: 'u' } } },
    { name: 'a fractional id', value: { token: 't', user: { id: 1.5, username: 'u' } } },
    { name: 'an empty username', value: { token: 't', user: { id: 1, username: '' } } },
  ])('rejects $name', ({ value }) => {
    expect(sessionSchema.safeParse(value).success).toBe(false);
  });
});

describe('createSessionStore', () => {
  it('loads what it saved', () => {
    const store = createSessionStore(createMemoryStorage());
    store.save(session);
    expect(store.load()).toEqual(session);
  });

  it('loads null after clear', () => {
    const store = createSessionStore(createMemoryStorage());
    store.save(session);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it.each([
    { name: 'corrupted JSON', raw: '{"token":' },
    { name: 'a session with no token', raw: JSON.stringify({ user: session.user }) },
    { name: 'the legacy shape with an empty object', raw: '{}' },
    { name: 'a tampered user', raw: JSON.stringify({ token: 't', user: 'admin' }) },
  ])('treats $name as signed out instead of crashing', ({ raw }) => {
    const store = createSessionStore(createMemoryStorage({ 'clims.session': raw }));
    expect(store.load()).toBeNull();
  });
});

describe('permissions on the signed-in user', () => {
  const role = (name: string, permissions: string[] | null) => ({ id: name, name, permissions });

  it('joins the permissions of every role the Go API says the user holds', () => {
    const parsed = sessionSchema.parse({
      token: 't',
      user: {
        id: 'u-1',
        username: 'u',
        role: role('dfcp', ['orders:read']),
        roles: [role('dfcp', ['orders:read']), role('vht', ['hotspots:submit', 'orders:read'])],
      },
    });
    expect(parsed.user.permissions).toEqual(['hotspots:submit', 'orders:read']);
    expect(parsed.user.role).toBe('dfcp');
  });

  it('reads them from the primary role when the reply has no role list', () => {
    const parsed = sessionSchema.parse({
      token: 't',
      user: { id: 1, username: 'u', role: role('admin', ['users:read']) },
    });
    expect(parsed.user.permissions).toEqual(['users:read']);
  });

  it('names the user by the first role held when there is no primary role', () => {
    const parsed = sessionSchema.parse({
      token: 't',
      user: { id: 1, username: 'u', roles: [role('moh', []), role('vht', [])] },
    });
    expect(parsed.user.role).toBe('moh');
  });

  it('knows a user with no roles holds nothing', () => {
    const parsed = sessionSchema.parse({ token: 't', user: { id: 1, username: 'u', roles: null } });
    expect(parsed.user.permissions).toEqual([]);
  });

  it('leaves them unknown when the reply does not say, as a legacy or older stored session', () => {
    const parsed = sessionSchema.parse({
      token: 't',
      user: { id: 1, username: 'u', role: 'admin' },
    });
    expect(parsed.user.permissions).toBeNull();
  });

  it('reads back the stored shape unchanged', () => {
    const first = sessionSchema.parse({
      token: 't',
      user: { id: 'u-1', username: 'u', roles: [role('moh', ['users:read', 'roles:read'])] },
    });
    expect(sessionSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });
});

describe('hasPermissions', () => {
  const user = (permissions: string[] | null) => ({ permissions });

  it('needs every code asked for', () => {
    expect(
      hasPermissions(user(['users:create', 'roles:assign']), ['users:create', 'roles:assign']),
    ).toBe(true);
    expect(hasPermissions(user(['users:create']), ['users:create', 'roles:assign'])).toBe(false);
  });

  it('allows while the permissions are unknown, and refuses a signed-out visitor', () => {
    expect(hasPermissions(user(null), ['roles:manage'])).toBe(true);
    expect(hasPermissions(null, ['roles:manage'])).toBe(false);
  });
});
