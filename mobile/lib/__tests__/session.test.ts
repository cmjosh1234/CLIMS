import type { ApiUser } from "../api";
import { toSessionUser } from "../session";

// The session module loads the phone's storage; these tests only map API users.
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
}));
jest.mock("expo-secure-store", () => ({}));

const apiUser = (extra: Partial<ApiUser> = {}): ApiUser => ({
  id: "6f1c2a7e-0d3b-4c1e-9a52-1f0e8f3b7a10",
  username: "grace.n",
  email: "grace.nakato@example.org",
  firstname: "Grace",
  lastname: "Nakato",
  first_name: "Grace",
  last_name: "Nakato",
  phone_number: "0772418903",
  status: "active",
  role: { id: "r", name: "hotspot manager" },
  roles: [{ id: "r", name: "hotspot manager" }],
  ...extra,
});

describe("toSessionUser", () => {
  it("keeps the names apart and whether the password must change", () => {
    const user = toSessionUser(
      apiUser({ must_change_password: true, password_changed_at: null }),
      "hm",
    );
    expect(user).toMatchObject({
      name: "Grace Nakato",
      firstName: "Grace",
      lastName: "Nakato",
      mustChangePassword: true,
      passwordChangedAt: null,
    });
  });

  it("treats an API that doesn't say as no change needed", () => {
    const user = toSessionUser(apiUser(), "hm");
    expect(user.mustChangePassword).toBe(false);
    expect(user.passwordChangedAt).toBeNull();
  });

  it("falls back to the username when the account has no names", () => {
    const user = toSessionUser(
      apiUser({ firstname: "", lastname: "", first_name: "", last_name: "" }),
      "vht",
    );
    expect(user.name).toBe("grace.n");
    expect(user).toMatchObject({ firstName: "", lastName: "" });
  });
});
