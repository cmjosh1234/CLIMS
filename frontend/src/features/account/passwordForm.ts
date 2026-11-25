import { z } from 'zod';

import { PASSWORD_RULES } from '@/features/onboarding/passwordRules';

/*
 * The rules for a password a person chooses, as the Go API checks them
 * (`users.PasswordProblem`): at least 8 characters, a number, at most 72 bytes
 * (bcrypt reads no further). The checklist beside the fields is the onboarding
 * one, so the same three rules read the same everywhere.
 */
export { PASSWORD_RULES };

const MIN_LENGTH = 8;
const MAX_BYTES = 72;

const byteLength = (value: string) => new TextEncoder().encode(value).length;

// Never trimmed: a password may begin or end with a space.
const newPassword = z
  .string()
  .min(1, 'Choose a new password.')
  .min(MIN_LENGTH, `Use at least ${MIN_LENGTH} characters.`)
  .regex(/\d/, 'Include at least one number.')
  .refine((value) => byteLength(value) <= MAX_BYTES, 'Use a shorter password.');

const confirmation = z.string().min(1, 'Type the new password again.');

const matches = {
  check: (values: { new_password: string; confirmation: string }) =>
    values.new_password === values.confirmation,
  issue: { path: ['confirmation'], message: 'The passwords do not match.' },
};

/** The first-sign-in form: the person signed in with the old password moments ago. */
export const requiredPasswordSchema = z
  .object({ new_password: newPassword, confirmation })
  .refine(matches.check, matches.issue);

export type RequiredPasswordForm = z.infer<typeof requiredPasswordSchema>;

/** Changing a password from the profile: the current one proves it is them. */
export const passwordChangeSchema = z
  .object({
    current_password: z.string().min(1, 'Enter your current password.'),
    new_password: newPassword,
    confirmation,
  })
  .refine(matches.check, matches.issue)
  .refine((values) => values.new_password !== values.current_password, {
    path: ['new_password'],
    message: 'Choose a password different from your current one.',
  });

export type PasswordChangeForm = z.infer<typeof passwordChangeSchema>;

/** A temporary password an administrator or DCFP gives someone. */
export const temporaryPasswordSchema = z.object({ password: newPassword });

export type TemporaryPasswordForm = z.infer<typeof temporaryPasswordSchema>;

/** Letters and digits that cannot be mistaken for one another when read out over the phone. */
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';

/**
 * A temporary password that is easy to read aloud: three groups of four
 * lower-case letters and digits, such as `tika-73mo-pexa`, with at least two
 * digits. It is random (Web Crypto), and replaced at the person's next sign-in.
 */
export function generateTemporaryPassword(
  random: (count: number) => Uint32Array = (count) =>
    crypto.getRandomValues(new Uint32Array(count)),
): string {
  const alphabet = LETTERS + DIGITS;
  for (;;) {
    const values = random(12);
    const characters = Array.from(values, (value) => alphabet[value % alphabet.length] ?? 'a');
    const digits = characters.filter((character) => DIGITS.includes(character)).length;
    if (digits >= 2) {
      return [0, 4, 8].map((start) => characters.slice(start, start + 4).join('')).join('-');
    }
  }
}
