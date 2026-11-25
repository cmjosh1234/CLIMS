package users

import (
	"errors"

	"clims-backend/internal/features/rbac"
	"clims-backend/internal/pkg/response"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// ActiveUser resolves identity and permissions from PostgreSQL for each request.
func ActiveUser(repo *Repository) fiber.Handler {
	return func(c fiber.Ctx) error {
		id, ok := c.Locals("user_id").(string)
		if !ok || id == "" {
			return response.Error(c, 401, "unauthorized", nil)
		}
		user, err := repo.GetUserByID(c.Context(), id)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return response.Error(c, 401, "unauthorized", nil)
			}
			return response.Error(c, 500, "failed to load account", nil)
		}
		if user.Status != "active" {
			return response.Error(c, 403, "account is disabled", nil)
		}
		sessionID := CurrentSessionID(c)
		if sessionID == "" {
			return response.Error(c, 401, "unauthorized", nil)
		}
		active, err := repo.sessionActive(c.Context(), id, sessionID)
		if err != nil {
			return response.Error(c, 500, "failed to load session", nil)
		}
		if !active {
			return response.Error(c, 401, "session has ended; sign in again", nil)
		}
		if user.MustChangePassword && c.Locals(passwordChangeExemptKey) == nil {
			return response.Error(c, 403, ErrPasswordChangeRequired.Error(), fiber.Map{"code": PasswordChangeRequiredCode})
		}
		c.Locals(rbac.PrincipalKey, user)
		return c.Next()
	}
}

// ErrPasswordChangeRequired refuses a request from an account that still has a password someone
// else chose (User.MustChangePassword). The client should ask for a new password first.
var ErrPasswordChangeRequired = errors.New("change your password before continuing")

// PasswordChangeRequiredCode is the `error.code` of that 403, so clients can tell it from a
// missing permission.
const PasswordChangeRequiredCode = "password_change_required"

const passwordChangeExemptKey = "users.password_change_exempt"

// AllowPendingPasswordChange marks a route that an account must reach before it has replaced its
// password: reading itself, changing the password, and signing out. Put it before ActiveUser.
func AllowPendingPasswordChange(c fiber.Ctx) error {
	c.Locals(passwordChangeExemptKey, true)
	return c.Next()
}

func CurrentUser(c fiber.Ctx) *User {
	user, _ := c.Locals(rbac.PrincipalKey).(*User)
	return user
}
