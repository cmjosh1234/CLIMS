package users

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"unicode/utf8"

	"clims-backend/internal/features/audit"
	"clims-backend/internal/pkg/request"
	"clims-backend/internal/pkg/response"
	"clims-backend/internal/pkg/validator"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

// A person's own account: their profile (PATCH /auth/me) and password (POST /auth/password), and the
// temporary password an administrator (PUT /users/:id/password) or a DCFP for their field workers
// (PUT /users/district/:id/password) gives an account. A temporary password, like the one an account
// is created with, must be replaced at the next sign-in (User.MustChangePassword).

const (
	passwordMinLength = 8
	// bcrypt reads at most 72 bytes; anything after them would be ignored.
	passwordMaxBytes = 72
	nameMaxLength    = 20
)

// PasswordProblem says what is wrong with a password someone chooses, or "" when it will do: at least
// 8 characters, at most 72 bytes, with at least one number. The web and mobile forms check the same.
func PasswordProblem(password string) string {
	switch {
	case password == "":
		return "This field is required."
	case utf8.RuneCountInString(password) < passwordMinLength:
		return "Use at least 8 characters."
	case len(password) > passwordMaxBytes:
		return "Use a shorter password: at most 72 bytes."
	case !strings.ContainsAny(password, "0123456789"):
		return "Include at least one number."
	}
	return ""
}

func passwordMatches(hash, password string) bool {
	return len(password) <= passwordMaxBytes && bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// UpdateProfileRequest is the body of PATCH /auth/me. Fields left out keep their value. Changing the
// email address or phone number, which the person signs in with, needs their current password.
type UpdateProfileRequest struct {
	FirstName       *string `json:"first_name"`
	LastName        *string `json:"last_name"`
	Email           *string `json:"email"`
	Phone           *string `json:"phone_number"`
	CurrentPassword string  `json:"current_password"`
}

// ProfileChanges are the profile fields to set; nil keeps a field.
type ProfileChanges struct {
	FirstName, LastName, Email, Phone *string
}

// phoneSeparators may be typed between a phone number's digits; they are not stored.
var phoneSeparators = strings.NewReplacer(" ", "", "-", "", "(", "", ")", "")

// normalize trims and checks the request against the user's current profile, returning the changes
// or the problem with each field. A field sent unchanged is left out and not checked, so an imported
// account with no last name or email address can still correct its first name.
func (req UpdateProfileRequest) normalize(user *User) (ProfileChanges, map[string]string) {
	var changes ProfileChanges
	problems := map[string]string{}
	name := func(value *string, current, field, missing string) *string {
		if value == nil {
			return nil
		}
		trimmed := strings.TrimSpace(*value)
		switch {
		case trimmed == strings.TrimSpace(current):
			return nil
		case trimmed == "":
			problems[field] = missing
		case utf8.RuneCountInString(trimmed) > nameMaxLength:
			problems[field] = "Use at most 20 characters."
		}
		return &trimmed
	}
	changes.FirstName = name(req.FirstName, user.FirstName, "first_name", "Enter your first name.")
	changes.LastName = name(req.LastName, user.LastName, "last_name", "Enter your last name.")
	if req.Email != nil {
		email := strings.ToLower(strings.TrimSpace(*req.Email))
		switch {
		case email == strings.ToLower(strings.TrimSpace(user.Email)):
		case email == "":
			problems["email"] = "Enter your email address."
		case validator.Validate.Var(email, "email,max=255") != nil:
			problems["email"] = "Enter a valid email address, e.g. name@example.org."
		default:
			changes.Email = &email
		}
	}
	if req.Phone != nil {
		// No phone number is allowed, as when an administrator creates the account.
		phone := phoneSeparators.Replace(strings.TrimSpace(*req.Phone))
		switch {
		case phoneKey(phone) == phoneKey(user.Phone):
		case phone != "" && validator.Validate.Var(phone, "phone,max=15") != nil:
			problems["phone_number"] = "Use 9 to 15 digits with an optional leading +."
		default:
			changes.Phone = &phone
		}
	}
	return changes, problems
}

// phoneKey compares phone numbers as the sign-in lookup does.
func phoneKey(phone string) string {
	if normalized := NormalizePhone(phone); normalized != "" {
		return normalized
	}
	return strings.TrimSpace(phone)
}

// changesIdentifier reports whether the changes give the user a new email address or phone number;
// normalize leaves out the ones sent unchanged.
func (changes ProfileChanges) changesIdentifier() bool {
	return changes.Email != nil || changes.Phone != nil
}

// profileFields is what a profile change's audit entry compares.
type profileFields struct {
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Email     string `json:"email"`
	Phone     string `json:"phone_number"`
}

// UpdateProfile sets the user's own name, email address and phone number.
func (r *Repository) UpdateProfile(ctx context.Context, id string, changes ProfileChanges) error {
	return pgx.BeginFunc(ctx, r.DB, func(tx pgx.Tx) error {
		var before profileFields
		if err := tx.QueryRow(ctx, `SELECT firstname, lastname, COALESCE(email, ''), phone_number
			FROM users WHERE id = $1 FOR UPDATE`, id).
			Scan(&before.FirstName, &before.LastName, &before.Email, &before.Phone); err != nil {
			return err
		}
		after := before
		for _, field := range []struct{ from, to *string }{
			{changes.FirstName, &after.FirstName}, {changes.LastName, &after.LastName},
			{changes.Email, &after.Email}, {changes.Phone, &after.Phone},
		} {
			if field.from != nil {
				*field.to = *field.from
			}
		}
		diff := audit.Diff(before, after)
		if len(diff) == 0 {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET firstname = $2, lastname = $3, email = NULLIF($4, ''),
			phone_number = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
			id, after.FirstName, after.LastName, after.Email, after.Phone); err != nil {
			return err
		}
		return r.audit.Record(ctx, tx, audit.Entry{Action: "user.profile_updated",
			Target: &audit.Subject{Type: "user", ID: id}, Changes: diff})
	})
}

// ChangePassword sets the password the user chose, clears MustChangePassword, and signs out every
// other session, keeping keepSessionID: the device the change was made on. It returns how many
// sessions it ended.
func (r *Repository) ChangePassword(ctx context.Context, id, keepSessionID, hash string, wasRequired bool) (int64, error) {
	var revoked int64
	err := pgx.BeginFunc(ctx, r.DB, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE users SET password = $2, must_change_password = false,
			password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, id, hash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return pgx.ErrNoRows
		}
		if tag, err = tx.Exec(ctx, revokeAll+` AND id <> $2::uuid`, id, keepSessionID); err != nil {
			return err
		}
		revoked = tag.RowsAffected()
		return r.audit.Record(ctx, tx, audit.Entry{Action: "auth.password_changed",
			Target: &audit.Subject{Type: "user", ID: id}, Related: []audit.Subject{{Type: "session", ID: keepSessionID}},
			Details: map[string]any{"sessions_revoked": revoked, "required": wasRequired}})
	})
	return revoked, err
}

// SetTemporaryPassword gives the account a password chosen by someone else, which its holder must
// replace at their next sign-in, and signs it out everywhere. It returns how many sessions it ended.
func (r *Repository) SetTemporaryPassword(ctx context.Context, id, hash string) (int64, error) {
	var revoked int64
	err := pgx.BeginFunc(ctx, r.DB, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE users SET password = $2, must_change_password = true,
			updated_at = CURRENT_TIMESTAMP WHERE id = $1`, id, hash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return pgx.ErrNoRows
		}
		if tag, err = tx.Exec(ctx, revokeAll, id); err != nil {
			return err
		}
		revoked = tag.RowsAffected()
		return r.audit.Record(ctx, tx, audit.Entry{Action: "user.password_reset",
			Target: &audit.Subject{Type: "user", ID: id}, Details: map[string]any{"sessions_revoked": revoked}})
	})
	return revoked, err
}

// fieldUserInDistrict reports whether the user is a field worker in the district: one the DCFP of
// that district lists and manages (GET /users/district).
func (r *Repository) fieldUserInDistrict(ctx context.Context, districtID, userID string) (bool, error) {
	var found bool
	err := r.DB.QueryRow(ctx, `SELECT EXISTS (`+userSelect+fieldUserWhere+`AND u.id = $3::uuid)`,
		districtID, FieldRoles, userID).Scan(&found)
	return found, err
}

// duplicateField places a unique-constraint error on the profile field it is about.
func duplicateField(err error) (map[string]string, bool) {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return nil, false
	}
	switch pgErr.ConstraintName {
	case "users_email_unique", "users_email_normalized_unique":
		return map[string]string{"email": "Another account already uses this email address."}, true
	case "users_phone_unique":
		return map[string]string{"phone_number": "Another account already uses this phone number."}, true
	}
	return nil, false
}

// UpdateMyProfile is PATCH /auth/me: the signed-in person changes their own name, email address or
// phone number. Roles, store, hotspot and place of work stay with administrators.
func (h *Handler) UpdateMyProfile(c fiber.Ctx) error {
	me := CurrentUser(c)
	var req UpdateProfileRequest
	if err := request.DecodeJSON(c, &req); err != nil {
		return response.Error(c, 400, "invalid request body", err.Error())
	}
	changes, problems := req.normalize(me)
	if len(problems) == 0 && changes.changesIdentifier() {
		switch {
		case req.CurrentPassword == "":
			problems["current_password"] = "Enter your current password to change your email address or phone number."
		case !passwordMatches(me.PasswordHash, req.CurrentPassword):
			problems["current_password"] = "That is not your current password."
		}
	}
	if len(problems) > 0 {
		return response.Error(c, 422, "validation failed", problems)
	}
	if err := h.Repo.UpdateProfile(c.Context(), me.ID, changes); err != nil {
		if fields, ok := duplicateField(err); ok {
			return response.Error(c, 409, "that email address or phone number belongs to another account", fields)
		}
		slog.Error("update profile failed", "error", err)
		return response.Error(c, 500, "failed to update your profile", nil)
	}
	user, err := h.Repo.GetUserByID(c.Context(), me.ID)
	if err != nil {
		return response.Error(c, 500, "failed to load account", nil)
	}
	return response.Success(c, 200, "profile updated", user)
}

// ChangePasswordRequest is the body of POST /auth/password.
type ChangePasswordRequest struct {
	// CurrentPassword is required, except while the account must replace a password someone else
	// chose: the person proved it to sign in moments ago, and every older session was ended when it
	// was set.
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// ChangeMyPassword is POST /auth/password: the signed-in person chooses a new password. Every other
// device they are signed in on is signed out; this one stays signed in.
func (h *Handler) ChangeMyPassword(c fiber.Ctx) error {
	me := CurrentUser(c)
	var req ChangePasswordRequest
	if err := request.DecodeJSON(c, &req); err != nil {
		return response.Error(c, 400, "invalid request body", err.Error())
	}
	problems := map[string]string{}
	if problem := PasswordProblem(req.NewPassword); problem != "" {
		problems["new_password"] = problem
	}
	if !me.MustChangePassword || req.CurrentPassword != "" {
		switch {
		case req.CurrentPassword == "":
			problems["current_password"] = "Enter your current password."
		case !passwordMatches(me.PasswordHash, req.CurrentPassword):
			problems["current_password"] = "That is not your current password."
		}
	}
	if len(problems) == 0 && passwordMatches(me.PasswordHash, req.NewPassword) {
		problems["new_password"] = "Choose a password different from your current one."
	}
	if len(problems) > 0 {
		return response.Error(c, 422, "validation failed", problems)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		return response.Error(c, 500, "failed to hash password", nil)
	}
	revoked, err := h.Repo.ChangePassword(c.Context(), me.ID, CurrentSessionID(c), string(hash), me.MustChangePassword)
	if err != nil {
		slog.Error("change password failed", "error", err)
		return response.Error(c, 500, "failed to change your password", nil)
	}
	user, err := h.Repo.GetUserByID(c.Context(), me.ID)
	if err != nil {
		return response.Error(c, 500, "failed to load account", nil)
	}
	return response.Success(c, 200, "password changed", fiber.Map{"user": user, "sessions_revoked": revoked})
}

// TemporaryPasswordRequest is the body of PUT /users/:id/password and PUT /users/district/:id/password.
type TemporaryPasswordRequest struct {
	Password string `json:"password"`
}

// SetTemporaryPassword is PUT /users/:id/password: an administrator gives an account a temporary
// password. The account is signed out everywhere and must choose its own password at its next
// sign-in. Only an administrator may do this to an administrator's account.
func (h *Handler) SetTemporaryPassword(c fiber.Ctx) error {
	id, err := request.UUIDParam(c)
	if err != nil {
		return response.Error(c, 400, err.Error(), nil)
	}
	if _, err = h.Repo.GetUserByID(c.Context(), id); err != nil {
		return accessError(c, err)
	}
	if refused, refuseErr := h.refuseAdminChange(c, id, nil); refused {
		return refuseErr
	}
	return h.setTemporaryPassword(c, id)
}

// SetDistrictUserTemporaryPassword is PUT /users/district/:id/password: a DCFP gives one of their
// district's field workers a temporary password, for instance when they have forgotten theirs.
func (h *Handler) SetDistrictUserTemporaryPassword(c fiber.Ctx) error {
	id, err := request.UUIDParam(c)
	if err != nil {
		return response.Error(c, 400, err.Error(), nil)
	}
	district, ok, err := h.callerDistrict(c)
	if !ok {
		return err
	}
	found, err := h.Repo.fieldUserInDistrict(c.Context(), district, id)
	if err != nil {
		return response.Error(c, 500, "failed to find the user", nil)
	}
	if !found {
		return response.Error(c, 404, "user not found in your district", nil)
	}
	// A field worker who also holds the administrator role is still an administrator's account.
	if refused, refuseErr := h.refuseAdminChange(c, id, nil); refused {
		return refuseErr
	}
	return h.setTemporaryPassword(c, id)
}

func (h *Handler) setTemporaryPassword(c fiber.Ctx, id string) error {
	var req TemporaryPasswordRequest
	if err := request.DecodeJSON(c, &req); err != nil {
		return response.Error(c, 400, "invalid request body", err.Error())
	}
	if problem := PasswordProblem(req.Password); problem != "" {
		return response.Error(c, 422, "validation failed", map[string]string{"password": problem})
	}
	if caller := CurrentUser(c); caller != nil && caller.ID == id {
		return response.Error(c, 422, "change your own password from your profile", nil)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return response.Error(c, 500, "failed to hash password", nil)
	}
	revoked, err := h.Repo.SetTemporaryPassword(c.Context(), id, string(hash))
	if errors.Is(err, pgx.ErrNoRows) {
		return response.Error(c, 404, "user not found", nil)
	}
	if err != nil {
		slog.Error("set temporary password failed", "error", err)
		return response.Error(c, 500, "failed to set the password", nil)
	}
	return response.Success(c, 200, "temporary password set", fiber.Map{"sessions_revoked": revoked})
}
