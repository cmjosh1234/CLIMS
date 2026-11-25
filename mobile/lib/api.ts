import axios, { isAxiosError, type AxiosError, type InternalAxiosRequestConfig } from "axios";

/**
 * API base. Defaults to production; for local development set EXPO_PUBLIC_API_URL in
 * mobile/.env.local (or infra/env/dev.env for Compose), e.g. http://192.168.1.50:8080/api/v1.
 */
export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL || "https://clims.health.go.ug/api/v1"
).replace(/\/$/, "");

export const api = axios.create({ baseURL: API_URL, timeout: 15000 });

/** Bare client for token endpoints, so refreshing never re-enters the interceptors. */
export const tokenClient = axios.create({ baseURL: API_URL, timeout: 15000 });

export interface ApiRole {
  id: string;
  name: string;
  permissions?: string[];
}

/** `User` in docs/api/openapi.json. */
export interface ApiUser {
  id: string;
  username: string;
  email: string;
  firstname: string;
  lastname: string;
  first_name?: string;
  last_name?: string;
  phone_number: string;
  status: string;
  role: ApiRole | null;
  roles: ApiRole[];
  organisation_unit_id?: string | null;
  hot_spot_id?: string | null;
  subcounty_id?: string | null;
  store_id?: string | null;
  location?: string | null;
  organisation_unit?: {
    id: string;
    uid: string;
    name: string;
    short_name: string;
    subcounty: string;
    district: string;
    region: string;
  } | null;
  hot_spot?: {
    id: string;
    name: string | null;
    type: string | null;
    status: string;
    village: string | null;
    subcounty: string | null;
    district: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  subcounty?: { id: string; name: string; district_id: string; district_name: string } | null;
  store?: {
    id: string;
    code: string;
    name: string;
    store_type: "national" | "district";
    district_id: string | null;
    district_name: string | null;
  } | null;
  /**
   * True while the account still has a password someone else chose (the DCFP or an administrator
   * created it, or set a temporary one). Until it is changed, the API answers only GET /auth/me,
   * POST /auth/password and POST /auth/logout.
   */
  must_change_password?: boolean;
  /** When the account holder last chose their own password; null if never. */
  password_changed_at?: string | null;
}

/** `TokenPair` in docs/api/openapi.json. */
export interface TokenPair {
  token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  session_id: string;
}

export interface LoginResult extends TokenPair {
  user: ApiUser;
}

/** Tokens as the app keeps them: absolute expiry times in ms since the epoch. */
export interface StoredTokens {
  access: string;
  accessExp: number;
  refresh: string;
  refreshExp: number;
  sessionId: string;
}

export function toStoredTokens(p: TokenPair, now = Date.now()): StoredTokens {
  return {
    access: p.token,
    accessExp: now + p.expires_in * 1000,
    refresh: p.refresh_token,
    refreshExp: now + p.refresh_expires_in * 1000,
    sessionId: p.session_id,
  };
}

// ---- Token state -------------------------------------------------------------------------

/** Refresh this long before the access token expires, to absorb clock skew and latency. */
const EARLY_MS = 30_000;

let tokens: StoredTokens | null = null;
let onTokens: (t: StoredTokens) => void = () => {};
let onSessionEnded: () => void = () => {};
let onPasswordChangeRequired: () => void = () => {};
let inflight: Promise<StoredTokens> | null = null;

/**
 * Wire the session layer in: `tokensChanged` persists rotated tokens and `sessionEnded`
 * signs the user out when the server refuses the refresh token (401) or the account (403).
 * `passwordChangeRequired` runs when the API refuses a request until the password is changed.
 */
export function configureAuth(handlers: {
  tokensChanged: (t: StoredTokens) => void;
  sessionEnded: () => void;
  passwordChangeRequired?: () => void;
}) {
  onTokens = handlers.tokensChanged;
  onSessionEnded = handlers.sessionEnded;
  onPasswordChangeRequired = handlers.passwordChangeRequired ?? (() => {});
}

/** `error.code` of the API's 403 for an account that must change its password first. */
export const PASSWORD_CHANGE_REQUIRED = "password_change_required";

/** True for the API's 403 that asks for a new password before anything else. */
export function isPasswordChangeRequired(err: unknown): boolean {
  if (!isAxiosError(err) || err.response?.status !== 403) return false;
  const error = (err.response.data as { error?: unknown } | undefined)?.error;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PASSWORD_CHANGE_REQUIRED
  );
}

export function setTokens(t: StoredTokens | null) {
  tokens = t;
  inflight = null;
}

export function getTokens() {
  return tokens;
}

class SessionEndedError extends Error {
  constructor() {
    super("Your session has ended. Sign in again.");
    this.name = "SessionEndedError";
  }
}

/**
 * Exchange the refresh token for a new pair. Concurrent callers share one request, because
 * refresh tokens are single use: a second exchange of the same token would be refused.
 */
export function refreshSession(): Promise<StoredTokens> {
  if (inflight) return inflight;
  const current = tokens;
  if (!current || current.refreshExp <= Date.now()) {
    tokens = null;
    onSessionEnded();
    return Promise.reject(new SessionEndedError());
  }
  const p = tokenClient
    .post<{ data: TokenPair }>("/auth/refresh", { refresh_token: current.refresh })
    .then(({ data }) => {
      const next = toStoredTokens(data.data);
      // Ignore the result if the user signed out or in again while it was in flight.
      if (tokens === current) {
        tokens = next;
        onTokens(next);
      }
      return next;
    })
    .catch((err: unknown) => {
      const s = isAxiosError(err) ? err.response?.status : undefined;
      if ((s === 401 || s === 403) && tokens === current) {
        tokens = null;
        onSessionEnded();
        throw new SessionEndedError();
      }
      // Offline or a server error: keep the session and let the caller fail normally.
      throw err;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

type Cfg = InternalAxiosRequestConfig & { _retried?: boolean };

api.interceptors.request.use(async (cfg) => {
  if (!tokens) return cfg;
  let t = tokens;
  if (t.accessExp - EARLY_MS <= Date.now()) {
    try {
      t = await refreshSession();
    } catch (err) {
      if (err instanceof SessionEndedError) throw err;
      // Offline: send the old token and let the server decide.
    }
  }
  cfg.headers.set("Authorization", `Bearer ${t.access}`);
  return cfg;
});

api.interceptors.response.use(undefined, async (err: AxiosError) => {
  // A session saved before the account had to change its password (or by an older app) learns it
  // here, and the app asks for a new password instead of failing every request.
  if (isPasswordChangeRequired(err) && tokens) onPasswordChangeRequired();
  const cfg = err.config as Cfg | undefined;
  if (err.response?.status !== 401 || !cfg || cfg._retried || !tokens) throw err;
  // The access token was rejected early (revoked, clock skew); refresh once and retry.
  cfg._retried = true;
  const t = await refreshSession();
  cfg.headers.set("Authorization", `Bearer ${t.access}`);
  return api.request(cfg);
});

// ---- Auth endpoints ------------------------------------------------------------------------

/** POST /auth/login. `identifier` is an email address, username or phone number. */
export async function login(identifier: string, password: string): Promise<LoginResult> {
  const { data } = await tokenClient.post<{ data: LoginResult }>("/auth/login", {
    login: identifier.trim(),
    password,
  });
  return data.data;
}

/**
 * POST /auth/logout for a session the app has already forgotten locally. Best effort: if the
 * access token has expired it refreshes first, and any failure is ignored.
 */
export async function endRemoteSession(t: StoredTokens): Promise<void> {
  try {
    let access = t.access;
    if (t.accessExp - EARLY_MS <= Date.now()) {
      if (t.refreshExp <= Date.now()) return;
      const { data } = await tokenClient.post<{ data: TokenPair }>("/auth/refresh", {
        refresh_token: t.refresh,
      });
      access = data.data.token;
    }
    await tokenClient.post("/auth/logout", null, {
      headers: { Authorization: `Bearer ${access}` },
      timeout: 8000,
    });
  } catch {
    // The session expires on its own; nothing more to do from the phone.
  }
}

/** A sentence a field worker can act on, from any login failure. */
export function loginErrorMessage(err: unknown): string {
  if (isAxiosError(err)) {
    const s = err.response?.status;
    if (s === 401)
      return "Those sign-in details and password don't match. Check them and try again.";
    if (s === 403) return "Your account is switched off. Call your district focal person.";
    if (s === 409)
      return "That name matches more than one account. Sign in with your email address.";
    if (s === 429) return "Too many attempts. Wait a minute, then try again.";
    if (s === 422 || s === 400) return "Enter your email address, username or phone number.";
    if (!err.response) return "Can't reach CLIMS. Check your network and try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Try again.";
}

// ---- The signed-in person's own account -------------------------------------------------------

/** GET /auth/me: the account as the server has it now. */
export async function getMe(): Promise<ApiUser> {
  const { data } = await api.get<{ data: ApiUser }>("/auth/me");
  return data.data;
}

export interface PasswordChange {
  /** Required, except while the account must replace a password someone else chose. */
  current_password?: string;
  new_password: string;
}

export interface PasswordChanged {
  user: ApiUser;
  /** How many other devices were signed out. */
  sessions_revoked: number;
}

/** POST /auth/password. This phone stays signed in; every other device is signed out. */
export async function changePassword(change: PasswordChange): Promise<PasswordChanged> {
  const body: PasswordChange = { new_password: change.new_password };
  if (change.current_password) body.current_password = change.current_password;
  const { data } = await api.post<{ data: PasswordChanged }>("/auth/password", body);
  return data.data;
}

/** The profile fields a person may change themselves; any left out keep their value. */
export interface ProfileChanges {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
  /** Required when the email address or phone number changes: both sign in. */
  current_password?: string;
}

/** PATCH /auth/me: the updated account. */
export async function updateProfile(changes: ProfileChanges): Promise<ApiUser> {
  const { data } = await api.patch<{ data: ApiUser }>("/auth/me", changes);
  return data.data;
}

/**
 * The API's per-field messages from a refused change (422 validation, 409 taken email or phone), by
 * field name; empty when the failure was about something else.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!isAxiosError(err)) return {};
  const s = err.response?.status;
  if (s !== 422 && s !== 409) return {};
  const error = (err.response?.data as { error?: unknown } | undefined)?.error;
  if (typeof error !== "object" || error === null) return {};
  const out: Record<string, string> = {};
  for (const [field, message] of Object.entries(error)) {
    if (typeof message === "string" && message.trim()) out[field] = message;
  }
  return out;
}

/** A sentence for a profile or password change that failed for a reason no field explains. */
export function accountErrorMessage(err: unknown): string {
  if (isAxiosError(err)) {
    const s = err.response?.status;
    if (!err.response)
      return "Can't reach CLIMS. Check your network and try again. This can't be saved offline.";
    if (s === 429) return "Too many attempts. Wait a minute, then try again.";
    if (s === 401) return "Your session has ended. Sign in again.";
    if (s === 403) return "Your account is switched off. Call your district focal person.";
    if (s === 409) return "That email address or phone number belongs to another account.";
    if (s === 400 || s === 422) return "Some details weren't accepted. Check them and try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Try again.";
}
