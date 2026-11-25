import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import {
  accountErrorMessage,
  api,
  changePassword,
  configureAuth,
  fieldErrors,
  getTokens,
  isPasswordChangeRequired,
  login,
  loginErrorMessage,
  setTokens,
  tokenClient,
  updateProfile,
  type StoredTokens,
} from "../api";

type Reply = { status: number; data?: unknown };

/** An adapter that answers from `handler` and records every request it sees. */
function stub(handler: (cfg: InternalAxiosRequestConfig) => Reply | Promise<Reply>) {
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (cfg) => {
    seen.push(cfg);
    const r = await handler(cfg);
    const res = { data: r.data, status: r.status, statusText: "", headers: {}, config: cfg };
    if (r.status >= 400) {
      throw new AxiosError("fail", String(r.status), cfg, null, res as never);
    }
    return res;
  };
  return { adapter, seen };
}

const pair = (n: number) => ({
  token: `access-${n}`,
  token_type: "Bearer",
  expires_in: 900,
  refresh_token: `refresh-${n}`,
  refresh_expires_in: 30 * 24 * 3600,
  session_id: "s-1",
});

const tokensAt = (accessExp: number): StoredTokens => ({
  access: "access-0",
  accessExp,
  refresh: "refresh-0",
  refreshExp: Date.now() + 86_400_000,
  sessionId: "s-1",
});

const body = (cfg: InternalAxiosRequestConfig) =>
  typeof cfg.data === "string" ? JSON.parse(cfg.data) : cfg.data;

let tokensChanged: jest.Mock;
let sessionEnded: jest.Mock;

beforeEach(() => {
  tokensChanged = jest.fn();
  sessionEnded = jest.fn();
  configureAuth({ tokensChanged, sessionEnded });
  setTokens(null);
});

describe("login", () => {
  it("sends the identifier as `login`, trimmed", async () => {
    const t = stub(() => ({
      status: 200,
      data: { success: true, data: { ...pair(1), user: { id: "u" } } },
    }));
    tokenClient.defaults.adapter = t.adapter;
    const res = await login("  0772 123456 ", "pw");
    expect(t.seen[0].url).toBe("/auth/login");
    expect(body(t.seen[0])).toEqual({ login: "0772 123456", password: "pw" });
    expect(res.refresh_token).toBe("refresh-1");
  });
});

describe("token refresh", () => {
  it("refreshes an expired access token once for concurrent requests", async () => {
    setTokens(tokensAt(Date.now() - 1000));
    const tc = stub(() => ({ status: 200, data: { success: true, data: pair(1) } }));
    tokenClient.defaults.adapter = tc.adapter;
    const a = stub(() => ({ status: 200, data: { ok: true } }));
    api.defaults.adapter = a.adapter;

    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);

    expect(tc.seen).toHaveLength(1);
    expect(body(tc.seen[0])).toEqual({ refresh_token: "refresh-0" });
    expect(a.seen.map((c) => c.headers.Authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-1",
      "Bearer access-1",
    ]);
    expect(tokensChanged).toHaveBeenCalledTimes(1);
    expect(getTokens()?.refresh).toBe("refresh-1");
  });

  it("retries once with a new token after a 401", async () => {
    setTokens(tokensAt(Date.now() + 600_000));
    tokenClient.defaults.adapter = stub(() => ({
      status: 200,
      data: { success: true, data: pair(2) },
    })).adapter;
    const a = stub((cfg) =>
      cfg.headers.Authorization === "Bearer access-2"
        ? { status: 200, data: "ok" }
        : { status: 401 },
    );
    api.defaults.adapter = a.adapter;

    const res = await api.get("/x");
    expect(res.data).toBe("ok");
    expect(a.seen).toHaveLength(2);
  });

  it("ends the session when the refresh token is refused", async () => {
    setTokens(tokensAt(Date.now() - 1000));
    tokenClient.defaults.adapter = stub(() => ({ status: 401 })).adapter;
    const a = stub(() => ({ status: 200 }));
    api.defaults.adapter = a.adapter;

    await expect(api.get("/x")).rejects.toThrow(/session has ended/);
    expect(sessionEnded).toHaveBeenCalledTimes(1);
    expect(getTokens()).toBeNull();
    expect(a.seen).toHaveLength(0);
  });

  it("keeps the session when offline", async () => {
    setTokens(tokensAt(Date.now() - 1000));
    tokenClient.defaults.adapter = async (cfg) => {
      throw new AxiosError("Network Error", "ERR_NETWORK", cfg);
    };
    api.defaults.adapter = stub(() => ({ status: 200, data: "cached" })).adapter;

    await api.get("/x");
    expect(sessionEnded).not.toHaveBeenCalled();
    expect(getTokens()?.refresh).toBe("refresh-0");
  });
});

describe("loginErrorMessage", () => {
  const err = (status: number) =>
    new AxiosError("x", String(status), undefined, null, { status } as never);

  it("tells the user to use their email on a 409", () => {
    expect(loginErrorMessage(err(409))).toMatch(/email address/);
  });
  it("explains a disabled account", () => {
    expect(loginErrorMessage(err(403))).toMatch(/switched off/);
  });
});

describe("own account", () => {
  const signedIn = () => setTokens(tokensAt(Date.now() + 600_000));

  it("changes the password, leaving out a current password that wasn't asked for", async () => {
    signedIn();
    const a = stub(() => ({
      status: 200,
      data: { success: true, data: { user: { id: "u" }, sessions_revoked: 2 } },
    }));
    api.defaults.adapter = a.adapter;
    const forced = await changePassword({ new_password: "kampala-2026" });
    expect(a.seen[0].method).toBe("post");
    expect(a.seen[0].url).toBe("/auth/password");
    expect(body(a.seen[0])).toEqual({ new_password: "kampala-2026" });
    expect(forced.sessions_revoked).toBe(2);
    await changePassword({ current_password: "old-pass-1", new_password: "kampala-2026" });
    expect(body(a.seen[1])).toEqual({
      current_password: "old-pass-1",
      new_password: "kampala-2026",
    });
  });

  it("sends profile changes to PATCH /auth/me", async () => {
    signedIn();
    const a = stub(() => ({
      status: 200,
      data: { success: true, data: { id: "u", email: "g@x.org" } },
    }));
    api.defaults.adapter = a.adapter;
    const user = await updateProfile({ email: "g@x.org", current_password: "pw-12345" });
    expect(a.seen[0].method).toBe("patch");
    expect(a.seen[0].url).toBe("/auth/me");
    expect(body(a.seen[0])).toEqual({ email: "g@x.org", current_password: "pw-12345" });
    expect(user.email).toBe("g@x.org");
  });

  const refused = (status: number, error?: unknown, data?: object) =>
    new AxiosError("x", String(status), undefined, null, {
      status,
      data: data ?? { success: false, message: "validation failed", error },
    } as never);

  it("reads the per-field messages of a refused change", () => {
    expect(fieldErrors(refused(422, { new_password: "Include at least one number." }))).toEqual({
      new_password: "Include at least one number.",
    });
    expect(
      fieldErrors(
        refused(409, { phone_number: "Another account already uses this phone number." }),
      ),
    ).toHaveProperty("phone_number");
    expect(fieldErrors(refused(422, "a string, not fields"))).toEqual({});
    expect(fieldErrors(refused(500, { email: "x" }))).toEqual({});
    expect(fieldErrors(new Error("x"))).toEqual({});
  });

  it("explains failures no field explains", () => {
    expect(accountErrorMessage(refused(429))).toMatch(/Wait a minute/);
    const offline = new AxiosError("Network Error", "ERR_NETWORK");
    expect(accountErrorMessage(offline)).toMatch(/network/);
    expect(accountErrorMessage(offline)).toMatch(/offline/);
  });

  it("asks the session for a new password when the API requires one", async () => {
    const passwordChangeRequired = jest.fn();
    configureAuth({ tokensChanged, sessionEnded, passwordChangeRequired });
    signedIn();
    const blocked = {
      success: false,
      message: "change your password before continuing",
      error: { code: "password_change_required" },
    };
    api.defaults.adapter = stub(() => ({ status: 403, data: blocked })).adapter;
    const err = await api.get("/orders").catch((e: unknown) => e);
    expect(isPasswordChangeRequired(err)).toBe(true);
    expect(passwordChangeRequired).toHaveBeenCalledTimes(1);
    expect(sessionEnded).not.toHaveBeenCalled();

    // A 403 for a missing permission is not that.
    api.defaults.adapter = stub(() => ({
      status: 403,
      data: { success: false, message: "forbidden" },
    })).adapter;
    expect(isPasswordChangeRequired(await api.get("/orders").catch((e: unknown) => e))).toBe(false);
    expect(passwordChangeRequired).toHaveBeenCalledTimes(1);
  });
});
