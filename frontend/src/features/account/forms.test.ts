import { describe, expect, it } from 'vitest';

import {
  generateTemporaryPassword,
  passwordChangeSchema,
  requiredPasswordSchema,
  temporaryPasswordSchema,
} from './passwordForm';
import {
  profileChanges,
  profileFormSchema,
  samePhone,
  type ProfileFormValues,
} from './profileForm';

const initial: ProfileFormValues = {
  first_name: 'Sarah',
  last_name: 'Nakato',
  email: 'sarah@example.org',
  phone_number: '+256 772 418 903',
  current_password: '',
};

const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('profileChanges', () => {
  it('sends only what changed, and asks for the password only for email or phone', () => {
    expect(profileChanges(initial, { ...initial, first_name: ' Sara ' })).toEqual({
      input: { first_name: 'Sara' },
      changesSignIn: false,
      hasChanges: true,
    });
    expect(
      profileChanges(initial, {
        ...initial,
        email: ' Sarah.N@Example.org ',
        current_password: 'secret-1',
      }),
    ).toEqual({
      input: { email: 'sarah.n@example.org', current_password: 'secret-1' },
      changesSignIn: true,
      hasChanges: true,
    });
  });

  it('treats the same email or phone written differently as unchanged', () => {
    const same = { ...initial, email: 'SARAH@example.org ', phone_number: '0772418903' };
    expect(profileChanges(initial, same)).toEqual({
      input: {},
      changesSignIn: false,
      hasChanges: false,
    });
  });

  it('sends a new phone in E.164 and an empty one to clear it', () => {
    expect(profileChanges(initial, { ...initial, phone_number: '0701 334 920' }).input).toEqual({
      phone_number: '+256701334920',
      current_password: '',
    });
    expect(profileChanges(initial, { ...initial, phone_number: ' ' }).input.phone_number).toBe('');
  });
});

describe('profileFormSchema', () => {
  it('checks only the fields that changed', () => {
    // An imported account with no last name and an old landline can still fix its first name.
    const imported = { ...initial, last_name: '', email: '', phone_number: '0414 123456' };
    const schema = profileFormSchema(imported);
    expect(schema.safeParse({ ...imported, first_name: 'Sara' }).success).toBe(true);
    expect(issues(schema.safeParse({ ...imported, phone_number: '0414 999999' }))).toEqual([
      'phone_number',
      'current_password',
    ]);
  });

  it('refuses empty or long names, a removed or invalid email, and a missing password', () => {
    const schema = profileFormSchema(initial);
    expect(issues(schema.safeParse({ ...initial, first_name: ' ' }))).toEqual(['first_name']);
    expect(issues(schema.safeParse({ ...initial, last_name: 'a'.repeat(21) }))).toEqual([
      'last_name',
    ]);
    expect(issues(schema.safeParse({ ...initial, email: '', current_password: 'x' }))).toEqual([
      'email',
    ]);
    expect(issues(schema.safeParse({ ...initial, email: 'nope', current_password: 'x' }))).toEqual([
      'email',
    ]);
    expect(issues(schema.safeParse({ ...initial, email: 'new@example.org' }))).toEqual([
      'current_password',
    ]);
  });
});

describe('samePhone', () => {
  it('compares Ugandan mobiles by number and anything else by its digits', () => {
    expect(samePhone('+256 772 418 903', '0772418903')).toBe(true);
    expect(samePhone('0414-123456', '0414 123456')).toBe(true);
    expect(samePhone('0772418903', '0772418904')).toBe(false);
  });
});

describe('password schemas', () => {
  it('follow the server: 8 characters, a number, 72 bytes, both typed the same', () => {
    const required = (new_password: string, confirmation = new_password) =>
      issues(requiredPasswordSchema.safeParse({ new_password, confirmation }));
    expect(required('abcd1234')).toEqual([]);
    expect(required('abc1234')).toEqual(['new_password']);
    expect(required('abcdefgh')).toEqual(['new_password']);
    expect(required(`${'é'.repeat(36)}1`)).toEqual(['new_password']);
    expect(required('abcd1234', 'abcd12345')).toEqual(['confirmation']);
  });

  it('refuse the current password as the new one', () => {
    const result = passwordChangeSchema.safeParse({
      current_password: 'abcd1234',
      new_password: 'abcd1234',
      confirmation: 'abcd1234',
    });
    expect(issues(result)).toEqual(['new_password']);
  });
});

describe('generateTemporaryPassword', () => {
  it('reads aloud easily and passes the password rules', () => {
    for (let index = 0; index < 50; index += 1) {
      const password = generateTemporaryPassword();
      expect(password).toMatch(/^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
      expect(password.replace(/\D/g, '').length).toBeGreaterThanOrEqual(2);
      expect(temporaryPasswordSchema.safeParse({ password }).success).toBe(true);
    }
  });

  it('draws again until it has two digits', () => {
    const draws = [new Uint32Array(12).fill(0), new Uint32Array(12).fill(23)];
    // All letters first ("aaaa…"), then all digits.
    expect(generateTemporaryPassword(() => draws.shift() ?? new Uint32Array(12))).toBe(
      '2222-2222-2222',
    );
  });
});
