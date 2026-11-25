# Users module

[Module architecture](README.md) · [OpenAPI contract](../api/openapi.json)

Source: `backend/internal/features/users/`.

| File            | Responsibility                                                                |
| --------------- | ----------------------------------------------------------------------------- |
| `model.go`      | Account response model and `HasPermission` implementation                     |
| `dto.go`        | Account input, admin creation, role assignment, status change, normalization  |
| `repository.go` | Account SQL, identity lookup, paginated listing, transactional access changes |
| `service.go`    | Shared bcrypt hashing and account creation                                    |
| `middleware.go` | Active-account resolution, current-user retrieval, the password-change gate   |
| `account.go`    | Own profile and password changes, temporary passwords, password rules         |
| `handler.go`    | Management requests, validation, pagination, and HTTP responses               |
| `routes.go`     | User routes and required permission gates                                     |

## Management routes

All routes require JWT authentication and an active account.

| Method | Route                                  | Required permissions                   |
| ------ | -------------------------------------- | -------------------------------------- |
| GET    | `/api/v1/users`                        | `users:read`                           |
| GET    | `/api/v1/users/{id}`                   | `users:read`                           |
| POST   | `/api/v1/users`                        | Both `users:create` and `roles:assign` |
| PATCH  | `/api/v1/users/{id}/role`              | `roles:assign`                         |
| PUT    | `/api/v1/users/{id}/roles`             | `roles:assign`                         |
| PATCH  | `/api/v1/users/{id}/status`            | `users:update`                         |
| PATCH  | `/api/v1/users/{id}/store`             | `users:update`                         |
| PUT    | `/api/v1/users/{id}/password`          | `users:update`                         |
| GET    | `/api/v1/users/district`               | `users:district_read`                  |
| POST   | `/api/v1/users/district`               | `users:district_create`                |
| PUT    | `/api/v1/users/district/{id}/password` | `users:district_create`                |

Listing defaults to `limit=50&offset=0`, allows limits from 1 to 100, and orders by user ID. Account responses include names, email, phone, status, and the complete `roles` array with each role’s permissions. The legacy `role` field contains the assigned role with the lowest UUID, or null when there are no assignments. `PasswordHash` has `json:"-"` and is never serialized.

Admin creation accepts signup fields plus either one existing `role_id` or a nonempty `role_ids` array. Unknown roles reject the entire transaction. Supplying only `users:create` does not allow a caller to create an administrator; the route also requires `roles:assign`.

## Account creation and persistence

`Service.Create` hashes the password and calls the repository. Signup, admin creation, and `cmd/create-admin` share it. Its callers perform normalization and input validation before invoking it. The repository stores hashes in the legacy `users.password` column and writes role assignments to `role_user` in the same transaction.

Public signup starts with `roles: []` and `role: null`. Legacy imports map recognized numeric role IDs to assignments. Unresolved legacy values grant no management permissions. Legacy accounts with a null email return an empty email string in responses.

The repository joins roles and permission mappings when looking up users.

Email addresses, usernames and phone numbers each belong to one account, since all three sign users in. Unique indexes enforce this, so concurrent requests cannot create duplicates: emails and usernames are compared case-insensitively, and phone numbers by the national form of their digits (`normalize_phone`), so `0772 123456` and `+256772123456` conflict. Accounts without a phone number do not conflict. Creating an account with a taken value returns 409 naming the field: `email already exists`, `username already exists` or `phone number already belongs to another account`. Other database failures return a server error.

The legacy data shared some usernames and phone numbers. Migration 12 kept each on the oldest account, by creation time and then legacy ID. Later accounts with the same username were renamed by appending their legacy ID, for example `Ritah` became `Ritah-1208`, and later accounts with the same phone number had it cleared. The original values are kept in `previous_username` and `previous_phone_number` for an administrator to review. Importing the legacy backup after migrations applies the same rule; accounts created through the API never are renamed or cleared.

## Work context

Administrator creation accepts existing `organisation_unit_id` and `hot_spot_id` UUIDs. Migration 5 resolves unambiguous legacy references to these UUIDs, and the legacy import uses the same lookup. User profiles include nullable `store_id` and `subcounty_id` fields. The orders API uses `store_id` to scope order access. Both assignments are read-only through the users API.

## Access changes and administrator protection

`UpdateUserAccess` updates role or account status inside a transaction. It takes a PostgreSQL transaction advisory lock before reading and updating the account, serializing account-access changes. A request that would disable or demote the last active account with the `admin` role returns 409. This guard applies to concurrent API requests; operators with direct database access must preserve the invariant themselves.

Allowed status updates are `active` and `disabled`. Use `PUT /api/v1/users/{id}/roles` with up to 100 existing role UUIDs in `role_ids` to replace the full set. Duplicate IDs collapse into one assignment, and an empty array clears the set. The legacy `PATCH /api/v1/users/{id}/role` endpoint replaces the full set with one role. There is no user deletion endpoint, and no organization-scoped access. People change their own name, email address, phone number and password through [auth](auth.md#your-own-profile-and-password).

## Temporary passwords

Someone who has forgotten their password gets a temporary one. `PUT /api/v1/users/{id}/password` (`users:update`) lets an administrator set it on any account; only an administrator may set one on an administrator's account (403), and nobody sets their own this way (422, use `POST /auth/password`). `PUT /api/v1/users/district/{id}/password` (`users:district_create`) lets a DCFP set it on a VHT, hotspot manager or delivery agent in their own district, the accounts `GET /users/district` lists; any other account is a 404. The body is `{ "password": "…" }` under the same rules as a chosen password (at least 8 characters with a number, at most 72 bytes).

A temporary password signs the account out everywhere and sets `must_change_password`, so the person chooses their own at their next sign-in ([auth](auth.md#changing-a-password-someone-else-chose)). Accounts created with `POST /users` or `POST /users/district` start the same way, since someone else chose their password. Each reset is audited as `user.password_reset` with the number of sessions it ended; the password itself is never recorded. The web app offers "Set temporary password" in Users & access and on the DCFP's Field users page, filled with a random password that is easy to read out over the phone.

## Stores

An account's `store_id` decides which orders and stock it works with: a DCFP or delivery agent works at their district's store, and NMS or JMS staff at their national warehouse. `POST /api/v1/users` accepts an optional `store_id`, and `PATCH /api/v1/users/{id}/store` sets it (`{ "store_id": "<uuid>" }`) or clears it (`{ "store_id": null }`); leaving the field out is a 422. `users.store_id` has no foreign key, because the column predates the `stores` table, so both endpoints check the store exists and answer 422 with `error.store_id` otherwise. The web app picks the store from the role and the district chosen; list stores with `GET /api/v1/locations/stores`.

Migration 20 adds National Medical Stores beside the Joint Medical Store and fills in missing stores with `assign_user_stores()`: `nms` and `jms` staff get their warehouse, and DCFPs and delivery agents the store of their legacy district. It never replaces a store already set, and the legacy seed importer calls it too.

## Administrator provisioning

Use imported active admin accounts, or set `CLIMS_ADMIN_EMAIL`, `CLIMS_ADMIN_PASSWORD`, and optionally `CLIMS_ADMIN_USERNAME` before running `make create-admin`. The command applies migrations and creates a new administrator without overwriting an existing account. It requires operator database access and Go 1.26+; the HTTP API offers no unauthenticated admin-bootstrap route.
