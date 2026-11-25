-- An account whose password someone else chose must replace it at its next sign-in: one an
-- administrator or district focal person created, or gave a temporary password. Until then the API
-- answers only GET /auth/me, POST /auth/password and POST /auth/logout for it. Existing accounts
-- keep their passwords: the flag starts false for all of them.
ALTER TABLE users
    ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
    -- When the account's holder last chose their own password; NULL when they never have here.
    ADD COLUMN password_changed_at timestamptz;
