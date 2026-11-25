import {
  changesSignIn,
  PASSWORD_RULES,
  passwordReady,
  passwordTooLong,
  phoneKey,
  profileChanges,
  profileFormOf,
  profileProblems,
  type ProfileForm,
} from "../account";

const met = (password: string, confirmation = password) =>
  PASSWORD_RULES.filter((r) => r.isMet(password, confirmation)).map((r) => r.id);

describe("password rules", () => {
  it("ticks each rule off as it is met", () => {
    expect(met("")).toEqual([]);
    expect(met("abc")).toEqual(["match"]);
    expect(met("abcdefgh", "")).toEqual(["length"]);
    expect(met("abcdefg1")).toEqual(["length", "number", "match"]);
  });

  it("counts characters, not UTF-16 units, towards the minimum", () => {
    // Seven characters, one of them an emoji that takes two UTF-16 units.
    expect(met("😀bcdef1", "")).not.toContain("length");
    expect(met("ééééééé1", "")).toContain("length");
  });

  it("refuses passwords longer than the API's 72 bytes", () => {
    const longest = `${"a".repeat(71)}1`;
    expect(passwordTooLong(longest)).toBe("");
    expect(passwordReady(longest, longest)).toBe(true);
    const tooLong = `${"é".repeat(36)}1`; // 73 bytes
    expect(passwordTooLong(tooLong)).not.toBe("");
    expect(passwordReady(tooLong, tooLong)).toBe(false);
  });

  it("is ready only when both entries match", () => {
    expect(passwordReady("kampala-2026", "kampala-2026")).toBe(true);
    expect(passwordReady("kampala-2026", "kampala-2025")).toBe(false);
  });
});

describe("profile changes", () => {
  const before: ProfileForm = {
    firstName: "Grace",
    lastName: "Nakato",
    email: "grace.nakato@example.org",
    phone: "0772 418903",
  };

  it("sends only what changed, trimmed", () => {
    expect(profileChanges(before, { ...before })).toEqual({});
    expect(profileChanges(before, { ...before, firstName: " Grace ", lastName: "Nakato" })).toEqual(
      {},
    );
    expect(profileChanges(before, { ...before, lastName: " Namubiru " })).toEqual({
      last_name: "Namubiru",
    });
  });

  it("treats the same email or phone in another form as unchanged", () => {
    const same = { ...before, email: "Grace.Nakato@Example.org ", phone: "+256 772 418 903" };
    expect(profileChanges(before, same)).toEqual({});
  });

  it("needs the current password only for a new email or phone", () => {
    const named = profileChanges(before, { ...before, firstName: "Gracious" });
    expect(changesSignIn(named)).toBe(false);
    const moved = profileChanges(before, { ...before, phone: "0701-334 920" });
    expect(moved).toEqual({ phone_number: "0701334920" });
    expect(changesSignIn(moved)).toBe(true);
    expect(changesSignIn(profileChanges(before, { ...before, phone: "" }))).toBe(true);
  });

  it("explains each field that can't be sent", () => {
    expect(
      profileProblems({
        first_name: "",
        last_name: "A".repeat(21),
        email: "grace@",
        phone_number: "12",
      }),
    ).toEqual({
      first_name: expect.any(String),
      last_name: expect.any(String),
      email: expect.any(String),
      phone_number: expect.any(String),
    });
    expect(profileProblems({ email: "" })).toHaveProperty("email");
    // Removing the phone number is allowed.
    expect(profileProblems({ phone_number: "" })).toEqual({});
    expect(profileProblems({ first_name: "Gracious", phone_number: "+256772418903" })).toEqual({});
  });

  it("compares phone numbers by their national digits", () => {
    expect(phoneKey("+256 772 418 903")).toBe("0772418903");
    expect(phoneKey("0772-418-903")).toBe("0772418903");
  });

  it("starts from the saved names, or splits an older session's full name", () => {
    const base = { username: "grace.n", email: "", phone: "" };
    expect(
      profileFormOf({ ...base, name: "Grace Nakato", firstName: "Grace", lastName: "" }),
    ).toEqual({ firstName: "Grace", lastName: "", email: "", phone: "" });
    expect(profileFormOf({ ...base, name: "Grace Mary Nakato" })).toMatchObject({
      firstName: "Grace",
      lastName: "Mary Nakato",
    });
    // A session with no names showed the username in their place.
    expect(profileFormOf({ ...base, name: "grace.n" })).toMatchObject({
      firstName: "",
      lastName: "",
    });
  });
});
