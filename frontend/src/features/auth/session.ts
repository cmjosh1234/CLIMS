import { z } from 'zod';

import { roleSchema } from '@/lib/api/schema';
import { readJson, removeKey, writeJson, type StorageLike } from '@/lib/storage/jsonStorage';

/** A role as sign-in and `GET /auth/me` send it. Only its permission codes matter here. */
const heldRoleSchema = z.object({ permissions: z.array(z.string()).nullish() });

const hasPermissionList = (role: unknown): boolean => {
  const parsed = heldRoleSchema.safeParse(role);
  return parsed.success && Array.isArray(parsed.data.permissions);
};

/**
 * Every permission code the user's roles grant, or `null` when the reply did
 * not say: a legacy API, or a session saved before permissions were kept.
 * The Go API sends the primary `role` and every held `roles`; `roles: null`
 * means the user holds none, which is known.
 */
function permissionsOf(role: unknown, roles: readonly unknown[] | null | undefined) {
  if (roles === undefined && !hasPermissionList(role)) return null;
  const codes = [...(roles ?? []), role].flatMap((held) => {
    const parsed = heldRoleSchema.safeParse(held);
    return parsed.success ? (parsed.data.permissions ?? []) : [];
  });
  return [...new Set(codes)].sort();
}

const heldRoleNameSchema = z.union([
  z.string(),
  z.object({ name: z.string().nullish() }).transform((role) => role.name ?? ''),
]);

/**
 * The names of every role held, lower-cased (`dfcp`, `store incharge`), or
 * `null` when the reply did not say. A bare role label (legacy APIs, older
 * stored sessions) counts as the one role held.
 */
function roleNamesOf(role: unknown, roles: readonly unknown[] | null | undefined) {
  const names = [...(roles ?? []), ...(role === null || role === undefined ? [] : [role])]
    .map((held) => heldRoleNameSchema.safeParse(held))
    .flatMap((parsed) => (parsed.success ? [parsed.data.trim().toLowerCase()] : []))
    .filter((name) => name !== '');
  // Without a role list, only a named role says anything; a bare numeric id does not.
  if (roles === undefined && names.length === 0) return null;
  return [...new Set(names)].sort();
}

/**
 * The signed-in user as this app needs it. Fields beyond `id` are optional in
 * practice on the legacy API, so they are nullable rather than assumed.
 *
 * The output parses again unchanged: the session is stored in this shape and
 * read back through the same schema on the next page load.
 */
export const authUserSchema = z
  .object({
    // The Go API's user IDs are UUID strings; the legacy API sent numbers.
    id: z.union([z.string().min(1), z.number().int()]).transform(String),
    username: z.string().min(1),
    // The Go API sends `{ id, name, permissions }`; older APIs a name or an id.
    role: z.unknown().optional(),
    roles: z.array(z.unknown()).nullish(),
    /** Present once stored: the codes worked out from the roles at sign-in. */
    permissions: z.array(z.string()).nullish(),
    /** Present once stored: the names of the roles held. */
    roleNames: z.array(z.string()).nullish(),
    firstname: z.string().nullish().default(null),
    lastname: z.string().nullish().default(null),
    email: z.string().nullish().default(null),
    /** The store the account works at (a DCFP's district store); `null` when none is assigned. */
    store_id: z.string().nullish().default(null),
    /**
     * True while the account still has a password someone else chose (an administrator or DCFP
     * created it, or set a temporary one). The API answers nothing but `GET /auth/me`,
     * `POST /auth/password` and sign-out until it is changed; older APIs leave it out.
     */
    must_change_password: z
      .boolean()
      .nullish()
      .transform((value) => value === true),
  })
  .transform(({ role, roles, permissions, roleNames, ...user }) => {
    // Without a primary role, the first role held names the user.
    const label = roleSchema.safeParse(role ?? roles?.[0]);
    return {
      ...user,
      /** The primary role's name, for showing who is signed in. */
      role: label.success ? label.data : null,
      /** What the user may do; `null` while unknown. See {@link hasPermissions}. */
      permissions: permissions ?? permissionsOf(role, roles),
      /** Which roles the user holds, for choosing their workspaces; `null` while unknown. */
      roleNames: roleNames ?? roleNamesOf(role, roles),
    };
  });

/**
 * Whether `user` holds every one of `codes`. While the user's permissions are
 * unknown (`null`) the answer is yes: the screen stays as it was, and the API
 * still refuses what the user may not do. A signed-out visitor holds nothing.
 */
export function hasPermissions(
  user: Pick<AuthUser, 'permissions'> | null,
  codes: readonly string[],
): boolean {
  if (!user) return false;
  const { permissions } = user;
  return permissions === null || codes.every((code) => permissions.includes(code));
}

export const sessionSchema = z.object({
  /** Short-lived access token, renewed with the refresh token when it expires. */
  token: z.string().min(1),
  /** Single-use; `null` for sessions from an API without refresh, which then sign out on expiry. */
  refresh_token: z.string().min(1).nullish(),
  user: authUserSchema,
});

/** What `POST /auth/refresh` returns: a new access token and the refresh token that replaces the old one. */
export const refreshedTokensSchema = z.object({
  token: z.string().min(1),
  refresh_token: z.string().min(1),
});

export type RefreshedTokens = z.infer<typeof refreshedTokensSchema>;

export type AuthUser = z.infer<typeof authUserSchema>;
export type Session = z.infer<typeof sessionSchema>;

const SESSION_KEY = 'clims.session';

/** Persists the session so a page reload does not sign the user out. */
export interface SessionStore {
  load(): Session | null;
  save(session: Session): void;
  clear(): void;
  /** The storage key, for matching cross-tab `storage` events. */
  readonly key: string;
}

export function createSessionStore(storage: StorageLike): SessionStore {
  return {
    key: SESSION_KEY,
    load: () =>
      readJson(storage, SESSION_KEY, (value) => {
        const result = sessionSchema.safeParse(value);
        return result.success ? result.data : null;
      }),
    save: (session) => {
      writeJson(storage, SESSION_KEY, session);
    },
    clear: () => {
      removeKey(storage, SESSION_KEY);
    },
  };
}
