import type { ProfileChanges } from "./api";
import type { SessionUser } from "./session";

/*
 * The rules a password the person chooses must meet, as the API checks them
 * (backend/internal/features/users/account.go) and the web shows them
 * (frontend/src/features/onboarding/passwordRules.ts): at least 8 characters, a number, at most
 * 72 bytes (bcrypt ignores the rest), and both entries the same. One list drives the checklist on
 * screen and the button, so they cannot disagree.
 */

export const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;

/** UTF-8 length, as the API measures it. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export interface PasswordRule {
  id: "length" | "number" | "match";
  label: string;
  isMet: (password: string, confirmation: string) => boolean;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: "length",
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    // Characters, not UTF-16 units: an accented letter or emoji counts once.
    isMet: (password) => [...password].length >= PASSWORD_MIN_LENGTH,
  },
  { id: "number", label: "Includes a number", isMet: (password) => /\d/.test(password) },
  {
    id: "match",
    label: "Both passwords match",
    isMet: (password, confirmation) => password.length > 0 && password === confirmation,
  },
];

/** What is wrong with a new password beyond the checklist, or "" when nothing is. */
export function passwordTooLong(password: string): string {
  return utf8Bytes(password) > PASSWORD_MAX_BYTES ? "Use a shorter password." : "";
}

/** True when every rule is met and the password is not too long. */
export function passwordReady(password: string, confirmation: string): boolean {
  return PASSWORD_RULES.every((r) => r.isMet(password, confirmation)) && !passwordTooLong(password);
}

// ---- Profile ------------------------------------------------------------------------------------

/** The details a person may change themselves, as the edit form holds them. */
export interface ProfileForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** The edit form's starting values. Sessions saved before names were kept apart split `name`. */
export function profileFormOf(
  me: Pick<SessionUser, "name" | "username" | "firstName" | "lastName" | "email" | "phone">,
): ProfileForm {
  let { firstName, lastName } = me;
  if (firstName === undefined) {
    const words = me.name === me.username ? [] : me.name.trim().split(/\s+/);
    firstName = words[0] ?? "";
    lastName = words.slice(1).join(" ");
  }
  return { firstName, lastName: lastName ?? "", email: me.email ?? "", phone: me.phone ?? "" };
}

const NAME_MAX = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Spaces, dashes and brackets may be typed between a phone number's digits. */
const PHONE_SEPARATORS = /[\s\-()]/g;
const PHONE = /^\+?[0-9]{9,15}$/;

const cleanPhone = (phone: string) => phone.trim().replace(PHONE_SEPARATORS, "");

/** Compares phone numbers by their digits in national form, as sign-in does: 0772… = +256772…. */
export function phoneKey(phone: string): string {
  const digits = cleanPhone(phone).replace(/^\+/, "");
  if (/^256\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  return digits;
}

/**
 * The fields that differ from `before`, trimmed, ready for PATCH /auth/me. A field typed back to
 * what it was is left out.
 */
export function profileChanges(before: ProfileForm, after: ProfileForm): ProfileChanges {
  const changes: ProfileChanges = {};
  if (after.firstName.trim() !== before.firstName.trim())
    changes.first_name = after.firstName.trim();
  if (after.lastName.trim() !== before.lastName.trim()) changes.last_name = after.lastName.trim();
  if (after.email.trim().toLowerCase() !== before.email.trim().toLowerCase())
    changes.email = after.email.trim();
  if (phoneKey(after.phone) !== phoneKey(before.phone))
    changes.phone_number = cleanPhone(after.phone);
  return changes;
}

/** Whether the changes alter how the person signs in, which needs their current password. */
export const changesSignIn = (changes: ProfileChanges) =>
  changes.email !== undefined || changes.phone_number !== undefined;

/** What is wrong with each changed field, by API field name; empty when it can be sent. */
export function profileProblems(changes: ProfileChanges): Record<string, string> {
  const problems: Record<string, string> = {};
  const name = (value: string | undefined, field: string, missing: string) => {
    if (value === undefined) return;
    if (!value) problems[field] = missing;
    else if ([...value].length > NAME_MAX) problems[field] = `Use at most ${NAME_MAX} characters.`;
  };
  name(changes.first_name, "first_name", "Enter your first name.");
  name(changes.last_name, "last_name", "Enter your last name.");
  if (changes.email !== undefined) {
    if (!changes.email) problems.email = "Enter your email address.";
    else if (!EMAIL.test(changes.email) || changes.email.length > 255)
      problems.email = "Enter a valid email address, e.g. name@example.org.";
  }
  if (changes.phone_number && !PHONE.test(changes.phone_number))
    problems.phone_number = "Use 9 to 15 digits, e.g. 0772 123456.";
  return problems;
}
