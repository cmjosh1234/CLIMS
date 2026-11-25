package auth

import (
	"time"

	"clims-backend/internal/features/users"
	"clims-backend/internal/pkg/response"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/limiter"
)

func RegisterRoutes(router fiber.Router, handler *Handler, jwtMiddleware, activeUser fiber.Handler) {
	auth := router.Group("/auth")
	auth.Post("/register", authRateLimit(false), handler.Register)
	auth.Post("/login", authRateLimit(true), handler.Login)
	auth.Post("/refresh", authRateLimit(true), handler.Refresh)
	// An account that must still replace a password someone else chose reaches only these three
	// (users.AllowPendingPasswordChange); every other route answers 403 password_change_required.
	pending := users.AllowPendingPasswordChange
	auth.Get("/me", jwtMiddleware, pending, activeUser, handler.Me)
	auth.Post("/password", jwtMiddleware, pending, activeUser, accountRateLimit(), handler.Account.ChangeMyPassword)
	auth.Post("/logout", jwtMiddleware, pending, activeUser, handler.Sessions.Logout)
	auth.Patch("/me", jwtMiddleware, activeUser, accountRateLimit(), handler.Account.UpdateMyProfile)
	auth.Get("/sessions", jwtMiddleware, activeUser, handler.Sessions.MySessions)
	auth.Delete("/sessions/:id", jwtMiddleware, activeUser, handler.Sessions.RevokeMySession)
}

// Per-process limits; forwarded headers are not trusted as client identity.
func authRateLimit(skipSuccessful bool) fiber.Handler {
	return limiter.New(limiter.Config{
		Max: 10, Expiration: time.Minute, SkipSuccessfulRequests: skipSuccessful,
		LimitReached: func(c fiber.Ctx) error { return response.Error(c, 429, "too many attempts; try again later", nil) },
	})
}

// accountRateLimit counts a signed-in account's refused profile and password changes, which check its
// current password, so a stolen session cannot guess it quickly. It is per account rather than per
// address: behind the gateway every request comes from the same address.
func accountRateLimit() fiber.Handler {
	return limiter.New(limiter.Config{
		Max: 10, Expiration: time.Minute, SkipSuccessfulRequests: true,
		KeyGenerator: func(c fiber.Ctx) string { return users.CurrentUser(c).ID },
		LimitReached: func(c fiber.Ctx) error { return response.Error(c, 429, "too many attempts; try again later", nil) },
	})
}
