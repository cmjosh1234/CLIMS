# Auth module

[Module architecture](README.md) · [OpenAPI contract](../api/openapi.json)

Source: `backend/internal/features/auth/`.

| File              | Responsibility                                                                     |
| ----------------- | ---------------------------------------------------------------------------------- |
| `dto.go`          | Signup and login request shapes; signup embeds `users.AccountInput`                |
| `handler.go`      | Registration validation, credential checking, token issuance, own-profile response |
| `routes.go`       | Auth routes, per-process rate limiting, the routes open during a password change   |
| `handler_test.go` | Login-attempt rate-limit regression test                                           |

## Endpoints

| Method | Route                   | Access                                       |
| ------ | ----------------------- | -------------------------------------------- |
| POST   | `/api/v1/auth/register` | Public; active account with the default role |
| POST   | `/api/v1/auth/login`    | Public; valid credentials and active account |
| GET    | `/api/v1/auth/me`       | Valid JWT and active account                 |
| PATCH  | `/api/v1/auth/me`       | Valid JWT and active account                 |
| POST   | `/api/v1/auth/password` | Valid JWT and active account                 |

Registration trims usernames, trims and lowercases emails, rejects unknown fields, validates request fields, and delegates hashing and persistence to the users service. Signup accepts `first_name`, `last_name`, and optional `location`. The older `firstname` and `lastname` inputs are accepted as fallbacks. Signup assigns the `registered user` role, which starts with no permissions. Administrators manage subsequent role changes, account status, and facility or hot spot assignments. The response contains `data.user_id`; registration does not issue a token.

Passwords need at least eight characters and at most 72 UTF-8 bytes. Validation's 72-character limit is supplemented by an explicit byte-length check. Existing legacy usernames can repeat; email uniqueness is enforced by PostgreSQL after trimming and lowercasing.

## Login and identity

Login accepts an email address, username or phone number in `login` (older clients may still send `email`) and compares the password using bcrypt, including legacy `$2y$` hashes. Email addresses are unique and are tried first, case-insensitively. Usernames match case-insensitively and phone numbers by their digits, so `0772 123456`, `0772123456` and `+256772123456` are the same number. Each of the three belongs to one account (see [users](users.md)). In the rare case that one account's username equals another's phone number and the password opens both, the response is 409 and the user signs in with their email address. Wrong credentials return 401. A correct password for a disabled account returns 403. Successful login returns a Bearer access token, a refresh token (described below), and the current user profile, including names, location, work context UUIDs, and account timestamps. Login and the profile endpoint omit the password hash and remember token.

JWTs use HS256 with `JWT_SECRET`, contain `sub`, `sid`, `iat`, and `exp`, and are access tokens that last 15 minutes. `sub` is the user ID encoded as a string. `sid` names the login session in `user_sessions`, which owns the session's tokens: it records the device's user agent and IP address, and stores only a SHA-256 hash of the current refresh token. Every protected request checks that the session is neither revoked nor expired, so revoking a session rejects its access token at once, and records activity at most once a minute.

Login also returns a single-use `refresh_token`. `POST /auth/refresh` exchanges it for a new access token and a new refresh token on the same session, so a session lasts 30 days from login before the user signs in again. Reusing a refresh token more than 30 seconds after it was replaced is treated as a stolen copy and revokes the session; within those 30 seconds it is only refused, so two browser tabs refreshing together do not sign the user out. The web app refreshes automatically when an access token expires and retries the request.

Each successful login updates the account's `last_login_at` and `login_count`. Account responses also include `active_sessions`, the number of devices currently signed in.

Registration allows ten requests per IP per minute. Login allows ten failed requests per IP per minute; successful responses do not consume the limit. Limits are independent, in memory, per process, and reset on restart. Forwarded headers are not trusted as client identity by default.

## Your own profile and password

`PATCH /auth/me` changes the signed-in person's `first_name`, `last_name`, `email` and `phone_number`, and returns the updated profile. Fields left out keep their value, and a field sent unchanged (the same email in other letter case, the same phone number written another way) is ignored, so an imported account with no last name can still correct its first name. Names are 1 to 20 characters. An email address is stored in lower case and cannot be removed once set. A phone number is 9 to 15 digits with an optional leading `+`; spaces, dashes and brackets are dropped, and an empty string removes it. Changing the email address or phone number, which both sign in, needs `current_password`. A taken email address or phone number is a 409 with `error.email` or `error.phone_number`. Username, roles, store, hotspot and place of work stay with administrators: those fields are refused as unknown (400). The change is audited as `user.profile_updated`.

`POST /auth/password` takes `current_password` and `new_password`. A new password has at least 8 characters, at least one number and at most 72 bytes, and differs from the current one; the web and mobile forms check the same rules (`users.PasswordProblem`). Every other session of the account is signed out, the one making the request stays signed in, and the response carries the profile and `sessions_revoked`. It sets `password_changed_at` and is audited as `auth.password_changed`.

Both count refused attempts towards ten per account per minute (429), since they check the current password: a stolen session cannot guess it quickly. The limit is per account rather than per address because every request reaches the API from the gateway's address.

### Changing a password someone else chose

An account an administrator or DCFP creates, and one they give a temporary password ([users](users.md#temporary-passwords)), has `must_change_password: true` (migration 42). Until it sets its own password, the API answers only `GET /auth/me`, `POST /auth/password` and `POST /auth/logout` for it (`users.AllowPendingPasswordChange`); every other request is a 403 with `error.code` = `password_change_required`. `current_password` may be left out of that first change: the person signed in with it moments ago, and every older session ended when it was set. Self sign-up and `make create-admin` choose their own password and are never flagged, and existing accounts kept their passwords when the column was added.

The web app shows a "Choose a new password" screen in place of the whole app while the flag is set, and the mobile app does the same before its tabs, store and push registration start, so neither fills with refusals. Portal (SSO) sign-in does not lift the flag: such an account sets a CLIMS password once.

## Boundaries and limitations

Auth uses the users repository for credential lookup and the shared users service to create the account and assign its default role in one transaction. The server supplies JWT and active-account middleware during route registration.

VHTs, hotspot managers and delivery agents work only in the mobile app. The API signs them in as usual, since the mobile app uses the same endpoints, but the web app refuses them. When every role an account holds is a field role (`vht`, `hotspot manager`, `delivery agent`), web sign-in by password or from the portal calls `POST /auth/logout` with the new token at once, keeps nothing, and tells the person to use the mobile app. An account that also holds a web role (a DCFP who is a VHT, say) signs in to that role's workspace. The roles are listed in `frontend/src/navigation/access.ts`.

`POST /auth/logout` ends the current session, and the web app calls it when a user signs out. `GET /auth/sessions` lists a user's own sessions and `DELETE /auth/sessions/{id}` signs out one of them, such as a lost device. Administrators list a user's sessions with `GET /users/{id}/sessions` (`users:read`) and sign them out everywhere with `DELETE /users/{id}/sessions` (`users:update`). Disabling an account revokes its sessions, so reactivation requires a new login. Tokens issued before sessions existed have no `sid` and are rejected; those users sign in again. There is no email verification and no password reset by email or SMS: someone who has forgotten their password asks an administrator, or their DCFP, for a temporary one. See [users](users.md) and [RBAC](rbac.md) for administration.
