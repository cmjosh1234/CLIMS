import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { FakeReply, RecordedRequest } from '@/test/fakeAdapter';
import { AppUnderTest } from '@/test/AppUnderTest';
import { renderApp, testSession } from '@/test/renderApp';

import { TemporaryPasswordDialog } from './TemporaryPasswordDialog';

/** The signed-in admin as `GET /auth/me` sends them. */
const ME = {
  id: '1',
  username: 'snakato',
  firstname: 'Sarah',
  lastname: 'Nakato',
  first_name: 'Sarah',
  last_name: 'Nakato',
  email: 'sarah@example.org',
  phone_number: '+256772418903',
  status: 'active',
  role: { id: 'r-admin', name: 'admin', permissions: testSession.user.permissions },
  roles: [{ id: 'r-admin', name: 'admin', permissions: testSession.user.permissions }],
  created_at: '2025-03-03T07:45:00Z',
  last_login_at: '2026-11-25T07:00:00Z',
  login_count: 214,
  must_change_password: false,
  password_changed_at: '2026-09-14T08:12:00Z',
  store: { id: 's-wakiso', name: 'Wakiso', store_type: 'district', district_name: 'Wakiso' },
  hot_spot: null,
  subcounty: null,
  organisation_unit: null,
};

const ok = (data: unknown) => ({ status: 200, body: { success: true, data } });

/** The card under the heading `name`, once the profile has loaded. */
async function card(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name });
  const found = heading.closest<HTMLElement>('[data-slot="card"]');
  if (!found) throw new Error(`No card around "${name}"`);
  return found;
}

/** Answers by address; `handle` takes the ones a test is about. */
function api(handle: (request: RecordedRequest) => FakeReply | undefined = () => undefined) {
  return (request: RecordedRequest) => {
    const answer = handle(request);
    if (answer) return typeof answer === 'function' ? answer(request) : answer;
    if (request.url === '/auth/me') return ok(ME);
    return ok([]);
  };
}

describe('first sign-in', () => {
  const pending = { ...testSession, user: { ...testSession.user, must_change_password: true } };

  it('asks for a new password before anything else loads, then opens the app', async () => {
    const user = userEvent.setup();
    const { requests, store } = renderApp(<AppUnderTest />, {
      route: '/moh/users',
      session: pending,
      replies: [
        api((request) =>
          request.url === '/auth/password'
            ? ok({ user: { ...ME, must_change_password: false }, sessions_revoked: 0 })
            : undefined,
        ),
      ],
    });

    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    // The API would refuse the screen's data until the password is changed, so none is asked for.
    expect(requests.filter((request) => request.url !== '/auth/me')).toEqual([]);

    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Save password and continue' }));
    expect(await screen.findByText('Use at least 8 characters.')).toBeVisible();
    expect(requests.some((request) => request.url === '/auth/password')).toBe(false);

    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('New password'), 'kasenyi-2026');
    await user.type(screen.getByLabelText('Confirm new password'), 'kasenyi-2026');
    await user.click(screen.getByRole('button', { name: 'Save password and continue' }));

    await waitFor(() => {
      expect(store.getState().auth.session?.user.must_change_password).toBe(false);
    });
    expect(requests.find((request) => request.url === '/auth/password')?.body).toEqual({
      new_password: 'kasenyi-2026',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'User management' })).toBeVisible();
  });

  it('lets the person sign out instead', async () => {
    const user = userEvent.setup();
    const { store } = renderApp(<AppUnderTest />, {
      route: '/moh',
      session: pending,
      replies: [api()],
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(store.getState().auth.session).toBeNull();
  });
});

describe('profile page', () => {
  it('shows who is signed in, where they work and what they can open', async () => {
    renderApp(<AppUnderTest />, { route: '/profile', signedIn: true, replies: [api()] });

    expect(await screen.findByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
    expect(await screen.findByRole('heading', { level: 2, name: 'Sarah Nakato' })).toBeVisible();
    expect(screen.getByLabelText('First name')).toHaveValue('Sarah');
    expect(screen.getByLabelText(/Phone number/)).toHaveValue('+256 772 418 903');
    expect(within(await card('Your work')).getByText('Wakiso district store')).toBeVisible();
    // Nothing is changed yet, so there is nothing to save.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('saves a new name without asking for the password', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(<AppUnderTest />, {
      route: '/profile',
      signedIn: true,
      replies: [
        api((request) =>
          request.method === 'PATCH' ? ok({ ...ME, first_name: 'Sara' }) : undefined,
        ),
      ],
    });

    const details = await card('Personal details');
    const firstName = within(details).getByLabelText('First name');
    await user.clear(firstName);
    await user.type(firstName, 'Sara');
    expect(within(details).queryByLabelText(/Current password/)).not.toBeInTheDocument();
    await user.click(within(details).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({
        first_name: 'Sara',
      });
    });
  });

  it('asks for the current password to change the email, and shows the server’s answer', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(<AppUnderTest />, {
      route: '/profile',
      signedIn: true,
      replies: [
        api((request) =>
          request.method === 'PATCH'
            ? {
                status: 409,
                body: {
                  success: false,
                  message: 'that email address or phone number belongs to another account',
                  error: { email: 'Another account already uses this email address.' },
                },
              }
            : undefined,
        ),
      ],
    });

    const details = await card('Personal details');
    const email = within(details).getByLabelText('Email address');
    await user.clear(email);
    await user.type(email, 'grace@example.org');
    const save = within(details).getByRole('button', { name: 'Save changes' });
    await user.click(save);
    expect(
      await screen.findByText(
        'Enter your current password to change your email address or phone number.',
      ),
    ).toBeVisible();

    await user.type(within(details).getByLabelText('Current password'), 'old-password-1');
    await user.click(save);
    expect(
      await screen.findByText('Another account already uses this email address.'),
    ).toBeVisible();
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      email: 'grace@example.org',
      current_password: 'old-password-1',
    });
  });

  it('changes the password with the current one', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp(<AppUnderTest />, {
      route: '/profile',
      signedIn: true,
      replies: [
        api((request) =>
          request.url === '/auth/password' ? ok({ user: ME, sessions_revoked: 2 }) : undefined,
        ),
      ],
    });

    const password = await card('Password');
    await user.type(within(password).getByLabelText('Current password'), 'old-password-1');
    await user.type(within(password).getByLabelText('New password'), 'new-password-2');
    await user.type(within(password).getByLabelText('Confirm new password'), 'new-password-2');
    await user.click(within(password).getByRole('button', { name: 'Change password' }));

    await waitFor(() => {
      expect(requests.find((request) => request.url === '/auth/password')?.body).toEqual({
        current_password: 'old-password-1',
        new_password: 'new-password-2',
      });
    });
    expect(
      await screen.findByText(
        'Password changed. 2 other devices signed out and will need the new password.',
      ),
    ).toBeVisible();
  });
});

describe('TemporaryPasswordDialog', () => {
  it('starts with a password that is easy to read out, and sets it', async () => {
    const user = userEvent.setup();
    let closed = false;
    const { requests } = renderApp(
      <TemporaryPasswordDialog
        userId="u-7"
        userName="Grace Atim"
        scope="district"
        onClose={() => {
          closed = true;
        }}
      />,
      { signedIn: true, replies: [ok({ sessions_revoked: 1 })] },
    );

    const field = screen.getByLabelText('Temporary password');
    const first = (field as HTMLInputElement).value;
    expect(first).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    await user.click(screen.getByRole('button', { name: 'Generate another' }));
    expect((field as HTMLInputElement).value).not.toBe(first);

    await user.click(screen.getByRole('button', { name: 'Set temporary password' }));
    await waitFor(() => {
      expect(closed).toBe(true);
    });
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      url: '/users/district/u-7/password',
      body: { password: (field as HTMLInputElement).value },
    });
  });

  it('shows the server’s reason beside the field', async () => {
    const user = userEvent.setup();
    renderApp(
      <TemporaryPasswordDialog
        userId="u-7"
        userName="Grace Atim"
        scope="admin"
        onClose={vi.fn()}
      />,
      {
        signedIn: true,
        replies: [
          {
            status: 422,
            body: {
              success: false,
              message: 'validation failed',
              error: { password: 'Include at least one number.' },
            },
          },
        ],
      },
    );
    await user.click(screen.getByRole('button', { name: 'Set temporary password' }));
    expect(await screen.findByText('Include at least one number.')).toBeVisible();
  });
});
