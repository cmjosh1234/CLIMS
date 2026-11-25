package auth

import (
	"errors"
	"strings"
	"time"

	"clims-backend/internal/features/audit"
	"clims-backend/internal/features/rbac"
	"clims-backend/internal/features/users"
	"clims-backend/internal/pkg/request"
	"clims-backend/internal/pkg/response"
	"clims-backend/internal/pkg/validator"

	"github.com/gofiber/fiber/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

type Handler struct {
	Repo      *users.Repository
	Service   *users.Service
	JWTSecret string
	// Sessions serves sign-out and a user's own session list.
	Sessions *users.Handler
	// Account serves the signed-in user's own profile and password.
	Account *users.Handler
	Audit   audit.Auditor
}

func NewHandler(repo *users.Repository, service *users.Service, secret string, auditor audit.Auditor) *Handler {
	own := users.NewHandler(repo, service)
	return &Handler{Repo: repo, Service: service, JWTSecret: secret, Sessions: own, Account: own, Audit: auditor}
}

// loginFailed audits a refused login with the identifier that was typed and, when it
// names one account, that account. The password is never recorded.
func (h *Handler) loginFailed(c fiber.Ctx, identifier, reason, accountID string) error {
	entry := audit.Entry{Action: "auth.login_failed", Outcome: audit.OutcomeFailure, Reason: reason,
		Details: map[string]any{"identifier": identifier}}
	if accountID != "" {
		entry.Target = &audit.Subject{Type: "user", ID: accountID}
	}
	return h.Audit.RecordNow(c.Context(), entry)
}

func (h *Handler) Register(c fiber.Ctx) error {
	var req RegisterRequest
	if err := request.DecodeJSON(c, &req); err != nil {
		return response.Error(c, 400, "invalid request body", err.Error())
	}
	req.AccountInput.Normalize()
	// Send validation errors before hashing or writing to the database.
	if err := validator.Validate.Struct(req); err != nil {
		return response.Error(c, 422, "validation failed", validator.FormatErrors(err))
	}
	if len(req.Password) > 72 {
		return response.Error(c, 422, "password must not exceed 72 bytes", nil)
	}

	id, err := h.Service.Create(c.Context(), req.AccountInput, rbac.RegisteredUserRoleID)
	if errors.Is(err, users.ErrHashPassword) {
		return response.Error(c, 500, "failed to hash password", nil)
	}
	if err != nil {
		if message, ok := users.DuplicateIdentifier(err); ok {
			return response.Error(c, 409, message, nil)
		}
		return response.Error(c, 500, "failed to create user", nil)
	}
	return response.Success(c, 201, "user registered successfully", fiber.Map{"user_id": id})
}

func (h *Handler) Login(c fiber.Ctx) error {
	var req LoginRequest
	if err := request.DecodeJSON(c, &req); err != nil {
		return response.Error(c, 400, "invalid request body", err.Error())
	}
	if err := validator.Validate.Struct(req); err != nil {
		return response.Error(c, 422, "validation failed", validator.FormatErrors(err))
	}
	identifier := strings.TrimSpace(req.Login)
	if identifier == "" {
		identifier = strings.TrimSpace(req.Email)
	}
	if identifier == "" {
		return response.Error(c, 422, "provide login: an email address, username or phone number", nil)
	}
	if len(req.Password) > 72 {
		return response.Error(c, 422, "password must not exceed 72 bytes", nil)
	}
	user, matched, err := h.authenticate(c, identifier, req.Password)
	switch {
	case errors.Is(err, errInvalidCredentials):
		if err = h.loginFailed(c, identifier, "invalid_credentials", matched); err != nil {
			return response.Error(c, 500, "failed to authenticate", nil)
		}
		return response.Error(c, 401, "invalid credentials", nil)
	case errors.Is(err, errAmbiguousLogin):
		if err = h.loginFailed(c, identifier, "ambiguous_identifier", ""); err != nil {
			return response.Error(c, 500, "failed to authenticate", nil)
		}
		return response.Error(c, 409, errAmbiguousLogin.Error(), nil)
	case err != nil:
		return response.Error(c, 500, "failed to authenticate", nil)
	}
	if user.Status != "active" {
		if err = h.loginFailed(c, identifier, "account_disabled", user.ID); err != nil {
			return response.Error(c, 500, "failed to authenticate", nil)
		}
		return response.Error(c, 403, "account is disabled", nil)
	}
	session, err := h.Repo.CreateSession(c.Context(), user.ID, c.Get(fiber.HeaderUserAgent), c.IP())
	if err != nil {
		return response.Error(c, 500, "failed to start session", nil)
	}
	tokens, err := h.issueTokens(session)
	if err != nil {
		return response.Error(c, 500, "failed to generate token", nil)
	}
	// Reload so the profile shows this login in last_login_at, login_count and active_sessions.
	if user, err = h.Repo.GetUserByID(c.Context(), user.ID); err != nil {
		return response.Error(c, 500, "failed to load account", nil)
	}
	tokens["user"] = user
	return response.Success(c, 200, "login successful", tokens)
}

var (
	errInvalidCredentials = errors.New("invalid credentials")
	errAmbiguousLogin     = errors.New("this username or phone number belongs to more than one account; sign in with your email address")
)

// authenticate finds the one account that identifier and password open. Email is unique, so an
// email match is decisive. Usernames and phone numbers are not unique in legacy data: the password
// must then match exactly one of the accounts that share them. On a wrong password it also returns
// the ID of the account the identifier names, when it names exactly one, for the audit log.
func (h *Handler) authenticate(c fiber.Ctx, identifier, password string) (*users.User, string, error) {
	matches := func(u *users.User) bool {
		return bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) == nil
	}
	byEmail, err := h.Repo.GetUserByEmail(c.Context(), identifier)
	if err == nil && matches(byEmail) {
		return byEmail, "", nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, "", err
	}
	candidates, err := h.Repo.FindByUsernameOrPhone(c.Context(), identifier)
	if err != nil {
		return nil, "", err
	}
	if len(candidates) > users.MaxLoginMatches {
		return nil, "", errAmbiguousLogin
	}
	named := map[string]bool{}
	if byEmail != nil {
		named[byEmail.ID] = true
	}
	var found *users.User
	for _, candidate := range candidates {
		named[candidate.ID] = true
		if byEmail != nil && candidate.ID == byEmail.ID {
			continue // its password was checked above
		}
		if matches(candidate) {
			if found != nil {
				return nil, "", errAmbiguousLogin
			}
			found = candidate
		}
	}
	if found == nil {
		var account string
		if len(named) == 1 {
			for id := range named {
				account = id
			}
		}
		return nil, account, errInvalidCredentials
	}
	return found, "", nil
}

// Refresh exchanges a refresh token for a new access token and a new refresh token. Each refresh
// token works once; replaying an old one signs that session out.
func (h *Handler) Refresh(c fiber.Ctx) error {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := request.DecodeJSON(c, &req); err != nil || req.RefreshToken == "" || len(req.RefreshToken) > 128 {
		return response.Error(c, 400, "provide refresh_token", nil)
	}
	session, err := h.Repo.RefreshSession(c.Context(), req.RefreshToken, c.Get(fiber.HeaderUserAgent), c.IP())
	if errors.Is(err, users.ErrRefreshInvalid) {
		return response.Error(c, 401, err.Error(), nil)
	}
	if errors.Is(err, users.ErrAccountDisabled) {
		return response.Error(c, 403, err.Error(), nil)
	}
	if err != nil {
		return response.Error(c, 500, "failed to refresh session", nil)
	}
	tokens, err := h.issueTokens(session)
	if err != nil {
		return response.Error(c, 500, "failed to generate token", nil)
	}
	return response.Success(c, 200, "session refreshed", tokens)
}

func (h *Handler) issueTokens(session users.IssuedSession) (fiber.Map, error) {
	return signTokens(h.JWTSecret, session)
}

// signTokens signs a short-lived access token for the session. It never outlives the session.
func signTokens(secret string, session users.IssuedSession) (fiber.Map, error) {
	now := time.Now()
	expires := now.Add(users.AccessTokenLifetime)
	if session.ExpiresAt.Before(expires) {
		expires = session.ExpiresAt
	}
	claims := jwt.MapClaims{"sub": session.UserID, "sid": session.ID, "iat": now.Unix(), "exp": expires.Unix()}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	if err != nil {
		return nil, err
	}
	return fiber.Map{
		"token": token, "token_type": "Bearer", "expires_in": int(time.Until(expires).Round(time.Second).Seconds()),
		"refresh_token": session.RefreshToken, "refresh_expires_in": int(time.Until(session.ExpiresAt).Round(time.Second).Seconds()),
		"session_id": session.ID,
	}, nil
}

func (h *Handler) Me(c fiber.Ctx) error {
	return response.Success(c, 200, "user profile retrieved successfully", users.CurrentUser(c))
}
