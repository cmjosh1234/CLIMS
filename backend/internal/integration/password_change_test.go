package integration

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// passwordFlags are the only response fields that may mention a password: whether one must be
// changed, and when it last was. Never the password or its hash.
var passwordFlags = map[string]bool{"must_change_password": true, "password_changed_at": true}

// assertNoPasswordField fails when any key in a decoded response names a password.
func assertNoPasswordField(t *testing.T, where string, value any) {
	t.Helper()
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			if strings.Contains(strings.ToLower(key), "password") && !passwordFlags[key] {
				t.Fatalf("%s: response exposed a password field %q", where, key)
			}
			assertNoPasswordField(t, where, child)
		}
	case []any:
		for _, child := range v {
			assertNoPasswordField(t, where, child)
		}
	}
}

// clearPasswordChange lifts the first-sign-in password change from the account a successful login
// response is for, so tests about other things can use its token.
func clearPasswordChange(t *testing.T, pool *pgxpool.Pool, login map[string]any) {
	t.Helper()
	data, _ := login["data"].(map[string]any)
	user, _ := data["user"].(map[string]any)
	if user == nil || user["must_change_password"] != true {
		return
	}
	if _, err := pool.Exec(context.Background(), `UPDATE users SET must_change_password = false WHERE id = $1`, user["id"]); err != nil {
		t.Fatal(err)
	}
}

// testPasswordChange covers the first sign-in of an account someone else created, changing one's own
// password and profile, and an administrator's temporary password.
func testPasswordChange(t *testing.T, pool *pgxpool.Pool, request func(string, string, any, string, int) map[string]any,
	adminToken, roleID string) {
	t.Helper()
	ctx := context.Background()
	data := func(result map[string]any) map[string]any { return result["data"].(map[string]any) }
	fieldProblem := func(result map[string]any, field string) {
		t.Helper()
		problems, _ := result["error"].(map[string]any)
		if message, _ := problems[field].(string); message == "" {
			t.Fatalf("expected a problem with %s, got %v", field, result)
		}
	}
	flag := func(id string, on bool) {
		t.Helper()
		if _, err := pool.Exec(ctx, `UPDATE users SET must_change_password = $2 WHERE id = $1`, id, on); err != nil {
			t.Fatal(err)
		}
	}
	signIn := func(login, password string) (string, map[string]any) {
		t.Helper()
		result := data(request("POST", "/auth/login", map[string]any{"login": login, "password": password}, "", 200))
		return result["token"].(string), result["user"].(map[string]any)
	}

	id := data(request("POST", "/users", map[string]any{
		"username": "first-login", "email": "first-login@example.test", "phone_number": "0772555111",
		"first_name": "First", "last_name": "Login", "password": "temp-password-1", "role_ids": []string{roleID},
	}, adminToken, 201))["user_id"].(string)
	request("POST", "/users", map[string]any{
		"username": "phone-owner", "email": "phone-owner@example.test", "phone_number": "0772555333",
		"password": "temp-password-1", "role_ids": []string{roleID},
	}, adminToken, 201)

	// The password the administrator chose must be replaced at the first sign-in.
	token, user := signIn("first-login", "temp-password-1")
	if user["must_change_password"] != true || user["password_changed_at"] != nil {
		t.Fatalf("a new account should have to change its password: %v", user)
	}
	secondDevice, _ := signIn("first-login@example.test", "temp-password-1")
	flag(id, true) // signIn lifted it, as it does for every other test

	// Until then only GET /auth/me, POST /auth/password and POST /auth/logout answer.
	blocked := request("GET", "/auth/sessions", nil, token, 403)
	if code := blocked["error"].(map[string]any)["code"]; code != "password_change_required" {
		t.Fatalf("blocked request: %v", blocked)
	}
	request("PATCH", "/auth/me", map[string]any{"first_name": "Early"}, token, 403)
	request("GET", "/users", nil, token, 403)
	if data(request("GET", "/auth/me", nil, token, 200))["must_change_password"] != true {
		t.Fatal("GET /auth/me should say the password must change")
	}

	// The new password follows the rules, differs from the old one, and a wrong current one is refused.
	for _, weak := range []string{"", "short-1", "no-digits-here", "temp-password-1", strings.Repeat("é", 36) + "1"} {
		fieldProblem(request("POST", "/auth/password", map[string]any{"new_password": weak}, token, 422), "new_password")
	}
	fieldProblem(request("POST", "/auth/password", map[string]any{
		"current_password": "wrong-password-1", "new_password": "chosen-password-2"}, token, 422), "current_password")

	// While required, the current password may be left out. The other device is signed out.
	changed := data(request("POST", "/auth/password", map[string]any{"new_password": "chosen-password-2"}, token, 200))
	if changed["sessions_revoked"] != float64(1) {
		t.Fatalf("changing the password should sign out the other device: %v", changed)
	}
	if profile := changed["user"].(map[string]any); profile["must_change_password"] != false || profile["password_changed_at"] == nil {
		t.Fatalf("password change not recorded: %v", profile)
	}
	request("GET", "/auth/sessions", nil, token, 200)
	request("GET", "/auth/me", nil, secondDevice, 401)
	request("POST", "/auth/login", map[string]any{"login": "first-login", "password": "temp-password-1"}, "", 401)
	signIn("first-login", "chosen-password-2")

	// From now on the current password is required.
	fieldProblem(request("POST", "/auth/password", map[string]any{"new_password": "another-password-3"}, token, 422), "current_password")
	request("POST", "/auth/password", map[string]any{
		"current_password": "chosen-password-2", "new_password": "another-password-3"}, token, 200)

	// Names change freely; an email address or phone number, which sign in, needs the password.
	profile := data(request("PATCH", "/auth/me", map[string]any{"first_name": "  Firsta ", "last_name": "Logina"}, token, 200))
	if profile["first_name"] != "Firsta" || profile["last_name"] != "Logina" || profile["email"] != "first-login@example.test" {
		t.Fatalf("profile update: %v", profile)
	}
	fieldProblem(request("PATCH", "/auth/me", map[string]any{"first_name": " "}, token, 422), "first_name")
	fieldProblem(request("PATCH", "/auth/me", map[string]any{"last_name": strings.Repeat("a", 21)}, token, 422), "last_name")
	fieldProblem(request("PATCH", "/auth/me", map[string]any{"email": "not-an-email"}, token, 422), "email")
	fieldProblem(request("PATCH", "/auth/me", map[string]any{"phone_number": "call me"}, token, 422), "phone_number")
	fieldProblem(request("PATCH", "/auth/me", map[string]any{"email": "renamed@example.test"}, token, 422), "current_password")
	fieldProblem(request("PATCH", "/auth/me", map[string]any{
		"email": "renamed@example.test", "current_password": "wrong-password-1"}, token, 422), "current_password")
	fieldProblem(request("PATCH", "/auth/me", map[string]any{
		"email": "Phone-Owner@example.test", "current_password": "another-password-3"}, token, 409), "email")
	fieldProblem(request("PATCH", "/auth/me", map[string]any{
		"phone_number": "+256 772 555 333", "current_password": "another-password-3"}, token, 409), "phone_number")
	// Sending a field unchanged needs no password.
	request("PATCH", "/auth/me", map[string]any{"email": " FIRST-LOGIN@example.test", "phone_number": "+256772555111",
		"first_name": "Firsta"}, token, 200)
	profile = data(request("PATCH", "/auth/me", map[string]any{"email": " Renamed@Example.test ",
		"phone_number": "0701 555 222", "current_password": "another-password-3"}, token, 200))
	if profile["email"] != "renamed@example.test" || profile["phone_number"] != "0701555222" {
		t.Fatalf("identifier update: %v", profile)
	}
	signIn("+256701555222", "another-password-3")
	// Roles and assignments are not the account holder's to change.
	request("PATCH", "/auth/me", map[string]any{"role_ids": []string{roleID}}, token, 400)
	request("PATCH", "/auth/me", map[string]any{"store_id": nil}, token, 400)

	// An administrator's temporary password signs the account out everywhere and must be replaced.
	fieldProblem(request("PUT", "/users/"+id+"/password", map[string]any{"password": "short"}, adminToken, 422), "password")
	reset := data(request("PUT", "/users/"+id+"/password", map[string]any{"password": "reset-password-4"}, adminToken, 200))
	if reset["sessions_revoked"].(float64) < 2 {
		t.Fatalf("a temporary password should end every session: %v", reset)
	}
	request("GET", "/auth/me", nil, token, 401)
	if token, user = signIn("renamed@example.test", "reset-password-4"); user["must_change_password"] != true {
		t.Fatalf("a temporary password should have to be changed: %v", user)
	}
	request("PUT", "/users/00000000-0000-4000-8000-000000000000/password", map[string]any{"password": "reset-password-4"}, adminToken, 404)
	adminID := data(request("GET", "/auth/me", nil, adminToken, 200))["id"].(string)
	request("PUT", "/users/"+adminID+"/password", map[string]any{"password": "reset-password-4"}, adminToken, 422)
	// Without users:update, nobody else's password can be set.
	request("PUT", "/users/"+adminID+"/password", map[string]any{"password": "reset-password-4"}, token, 403)

	// Each change is audited, and no password or hash is ever stored there.
	var audited, leaked int
	if err := pool.QueryRow(ctx, `SELECT
		count(DISTINCT action) FILTER (WHERE action IN ('auth.password_changed', 'user.profile_updated', 'user.password_reset')),
		count(*) FILTER (WHERE concat(changes::text, details::text) ~ '(password-[0-9]|\$2[ay]\$)')
		FROM audit_log WHERE target_type = 'user' AND target_id = $1`, id).Scan(&audited, &leaked); err != nil {
		t.Fatal(err)
	}
	if audited != 3 || leaked != 0 {
		t.Fatalf("audit: %d of 3 actions recorded, %d entries mention a password", audited, leaked)
	}
}
