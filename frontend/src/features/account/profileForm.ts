import { z } from 'zod';

import { formatUgandanMobile, parseUgandanMobile, UGANDAN_MOBILE_EXAMPLE } from '@/lib/phone';

import type { Profile, ProfileInput } from './api';

/*
 * The personal details form on the profile page. It mirrors `PATCH /auth/me`
 * (`users.UpdateProfileRequest`): names 1–20 characters, a valid email address
 * that cannot be removed once there is one, and a phone number that may be
 * cleared. Only what changed is checked and sent, so an account imported
 * without a last name or with an old landline can still correct its first name.
 * A new email address or phone number, which sign in, needs the current
 * password.
 */

const NAME_MAX_LENGTH = 20;
const PHONE_SEPARATORS = /[\s().-]/g;

export interface ProfileFormValues {
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  current_password: string;
}

export const PROFILE_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'phone_number',
  'current_password',
] as const satisfies readonly (keyof ProfileFormValues)[];

/** The form's starting values: what the account holds now, the phone shown grouped. */
export function profileFormValues(profile: Profile): ProfileFormValues {
  return {
    first_name: profile.first_name ?? '',
    last_name: profile.last_name ?? '',
    email: profile.email ?? '',
    phone_number: profile.phone_number ? formatUgandanMobile(profile.phone_number) : '',
    current_password: '',
  };
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether two phone numbers are the same number, however each is written. */
export function samePhone(a: string, b: string): boolean {
  const first = parseUgandanMobile(a);
  const second = parseUgandanMobile(b);
  if (first && second) return first === second;
  return a.replace(PHONE_SEPARATORS, '') === b.replace(PHONE_SEPARATORS, '');
}

export interface ProfileChanges {
  /** The body for `PATCH /auth/me`: only the fields that changed. */
  input: ProfileInput;
  /** A new email address or phone number, which needs the current password. */
  changesSignIn: boolean;
  /** Anything to save at all. */
  hasChanges: boolean;
}

/** What `values` changes about the account `initial` describes. */
export function profileChanges(
  initial: ProfileFormValues,
  values: ProfileFormValues,
): ProfileChanges {
  const input: ProfileInput = {};
  const firstName = values.first_name.trim();
  const lastName = values.last_name.trim();
  if (firstName !== initial.first_name.trim()) input.first_name = firstName;
  if (lastName !== initial.last_name.trim()) input.last_name = lastName;
  if (!sameEmail(values.email, initial.email)) input.email = values.email.trim().toLowerCase();
  if (!samePhone(values.phone_number, initial.phone_number)) {
    const phone = values.phone_number.trim();
    input.phone_number = phone === '' ? '' : (parseUgandanMobile(phone) ?? phone);
  }
  const changesSignIn = input.email !== undefined || input.phone_number !== undefined;
  if (changesSignIn) input.current_password = values.current_password;
  return { input, changesSignIn, hasChanges: Object.keys(input).length > 0 };
}

/** The form's checks, against the account as it stands. */
export function profileFormSchema(initial: ProfileFormValues) {
  return z
    .object({
      first_name: z.string(),
      last_name: z.string(),
      email: z.string(),
      phone_number: z.string(),
      current_password: z.string(),
    })
    .superRefine((values, context) => {
      const problem = (path: keyof ProfileFormValues, message: string) => {
        context.addIssue({ code: 'custom', path: [path], message });
      };
      const { input, changesSignIn } = profileChanges(initial, values);
      const checkName = (field: 'first_name' | 'last_name', value: string | undefined) => {
        if (value === undefined) return;
        if (value === '')
          problem(field, `Enter your ${field === 'first_name' ? 'first' : 'last'} name.`);
        else if (value.length > NAME_MAX_LENGTH)
          problem(field, `Use at most ${NAME_MAX_LENGTH} characters.`);
      };
      checkName('first_name', input.first_name);
      checkName('last_name', input.last_name);
      if (input.email !== undefined) {
        if (input.email === '') problem('email', 'Enter your email address.');
        else if (!z.email().max(255).safeParse(input.email).success)
          problem('email', 'Enter a valid email address, e.g. name@example.org.');
      }
      if (input.phone_number && !parseUgandanMobile(input.phone_number)) {
        problem('phone_number', `Enter a Ugandan mobile number, e.g. ${UGANDAN_MOBILE_EXAMPLE}.`);
      }
      if (changesSignIn && values.current_password === '') {
        problem(
          'current_password',
          'Enter your current password to change your email address or phone number.',
        );
      }
    });
}
