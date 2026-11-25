import { z } from 'zod';

import { authUserSchema, type AuthUser } from '@/features/auth/session';
import { optionalNumber, optionalText, parseBody, type HttpClient } from '@/lib/api';

/*
 * The signed-in person's own account: the Go API's `auth` feature
 * (`backend/internal/features/users/account.go`).
 *
 *   GET   /auth/me              → the whole profile, with roles and where they work
 *   PATCH /auth/me              { first_name?, last_name?, email?, phone_number?, current_password? } → profile
 *   POST  /auth/password        { current_password?, new_password } → { user, sessions_revoked }
 *
 * Changing the email address or phone number (both sign in) needs the current
 * password. `current_password` may be left out of a password change only while
 * `must_change_password` is true: the first sign-in of an account someone else
 * created, or after a temporary password. Until then every other request is
 * refused with 403 `password_change_required`.
 *
 * Administrators and DCFPs set a temporary password with `PUT /users/:id/password`
 * and `PUT /users/district/:id/password` (`setTemporaryPassword` below).
 */

const idText = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(z.string().min(1));

const roleSchema = z.object({
  id: idText,
  name: optionalText,
  permissions: z
    .array(z.string())
    .nullish()
    .transform((codes) => codes ?? []),
});

const storeSchema = z.object({
  id: idText,
  name: optionalText,
  store_type: optionalText,
  district_name: optionalText,
});

const hotSpotSchema = z.object({
  id: idText,
  name: optionalText,
  type: optionalText,
  village: optionalText,
  subcounty: optionalText,
  district: optionalText,
});

const subcountySchema = z.object({
  id: idText,
  name: optionalText,
  district_name: optionalText,
});

const organisationUnitSchema = z.object({
  id: idText,
  name: optionalText,
  district: optionalText,
  region: optionalText,
});

const assigned = <Schema extends z.ZodType>(schema: Schema) =>
  schema.nullish().transform((value) => value ?? null);

/** The whole profile, as `GET /auth/me` and `PATCH /auth/me` send it. */
export const profileSchema = z
  .object({
    id: idText,
    username: optionalText,
    first_name: optionalText,
    firstname: optionalText,
    last_name: optionalText,
    lastname: optionalText,
    email: optionalText,
    phone_number: optionalText,
    status: optionalText,
    roles: z
      .array(roleSchema)
      .nullish()
      .transform((roles) => roles ?? []),
    location: optionalText,
    created_at: optionalText,
    last_login_at: optionalText,
    login_count: optionalNumber,
    active_sessions: optionalNumber,
    must_change_password: z
      .boolean()
      .nullish()
      .transform((value) => value === true),
    password_changed_at: optionalText,
    store: assigned(storeSchema),
    hot_spot: assigned(hotSpotSchema),
    subcounty: assigned(subcountySchema),
    organisation_unit: assigned(organisationUnitSchema),
  })
  .transform(({ first_name, firstname, last_name, lastname, ...profile }) => ({
    ...profile,
    first_name: first_name ?? firstname,
    last_name: last_name ?? lastname,
  }));

export type Profile = z.output<typeof profileSchema>;

/** The whole profile behind the signed-in user. */
export async function getProfile(http: HttpClient, signal?: AbortSignal): Promise<Profile> {
  return parseBody(profileSchema, await http.get('/auth/me', { signal }), 'profile');
}

/** What the person may change about themselves. Fields left out keep their value. */
export interface ProfileInput {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
  /** Needed when `email` or `phone_number` changes. */
  current_password?: string;
}

/** The account after a change, as the profile page and the session each keep it. */
export interface SavedAccount {
  profile: Profile;
  user: AuthUser;
}

function savedAccount(body: unknown, what: string): SavedAccount {
  return {
    profile: parseBody(profileSchema, body, what),
    user: parseBody(authUserSchema, body, what),
  };
}

export async function updateProfile(http: HttpClient, input: ProfileInput): Promise<SavedAccount> {
  return savedAccount(await http.patch('/auth/me', input), 'profile');
}

export interface PasswordChange {
  /** Left out only while the account must replace a password someone else chose. */
  current_password?: string;
  new_password: string;
}

const passwordChangedSchema = z.object({
  user: z.unknown(),
  sessions_revoked: z.number().int().nonnegative(),
});

/** Sets a new password. Every other device the account is signed in on is signed out. */
export async function changePassword(
  http: HttpClient,
  input: PasswordChange,
): Promise<SavedAccount & { sessionsRevoked: number }> {
  const body = parseBody(
    passwordChangedSchema,
    await http.post('/auth/password', input),
    'password change',
  );
  return { ...savedAccount(body.user, 'password change'), sessionsRevoked: body.sessions_revoked };
}

/**
 * Who sets a temporary password: an administrator, for any account
 * (`users:update`), or a DCFP, for a field worker in their district
 * (`users:district_create`).
 */
export type TemporaryPasswordScope = 'admin' | 'district';

/**
 * Gives an account a temporary password. It is signed out everywhere and must
 * choose its own password at its next sign-in. Resolves to how many sessions ended.
 */
export async function setTemporaryPassword(
  http: HttpClient,
  scope: TemporaryPasswordScope,
  userId: string,
  password: string,
): Promise<number> {
  const base = scope === 'district' ? '/users/district' : '/users';
  const body = await http.put(`${base}/${encodeURIComponent(userId)}/password`, { password });
  return parseBody(
    z.object({ sessions_revoked: z.number().int().nonnegative() }),
    body,
    'temporary password',
  ).sessions_revoked;
}
