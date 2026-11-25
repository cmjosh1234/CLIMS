package users

import (
	"strings"
	"testing"
)

func TestPasswordProblem(t *testing.T) {
	for password, ok := range map[string]bool{
		"":                             false,
		"abc1234":                      false, // 7 characters
		"abcd1234":                     true,
		"no-digits-here":               false,
		"pass word 1":                  true, // spaces are part of a password
		"ééééééé1":                     true, // characters, not bytes, set the minimum
		strings.Repeat("a", 71) + "1":  true,
		strings.Repeat("é", 36) + "1":  false, // 73 bytes: bcrypt would ignore the end
		strings.Repeat("a", 72) + "11": false,
	} {
		if got := PasswordProblem(password) == ""; got != ok {
			t.Errorf("PasswordProblem(%q) accepted=%v, want %v (%q)", password, got, ok, PasswordProblem(password))
		}
	}
}

func TestProfileNormalizeLeavesUnchangedFieldsOut(t *testing.T) {
	text := func(s string) *string { return &s }
	// An imported account: no last name, no email address.
	user := &User{FirstName: "Kato", LastName: "", Email: "", Phone: "0772123456"}

	changes, problems := UpdateProfileRequest{FirstName: text(" Kato "), LastName: text(""), Email: text(" "),
		Phone: text("+256 772 123 456")}.normalize(user)
	if len(problems) != 0 || changes != (ProfileChanges{}) || changes.changesIdentifier() {
		t.Fatalf("unchanged fields: changes %+v problems %v", changes, problems)
	}

	changes, problems = UpdateProfileRequest{FirstName: text("Musa"), Email: text(" Kato@Example.ORG "),
		Phone: text("0701-555 222")}.normalize(user)
	if len(problems) != 0 || *changes.FirstName != "Musa" || *changes.Email != "kato@example.org" ||
		*changes.Phone != "0701555222" || !changes.changesIdentifier() {
		t.Fatalf("changed fields: changes %+v problems %v", changes, problems)
	}

	_, problems = UpdateProfileRequest{FirstName: text(" "), LastName: text(strings.Repeat("a", 21)),
		Email: text("nope"), Phone: text("12")}.normalize(user)
	for _, field := range []string{"first_name", "last_name", "email", "phone_number"} {
		if problems[field] == "" {
			t.Errorf("expected a problem with %s, got %v", field, problems)
		}
	}

	// Clearing the phone number is allowed, and it changes how the person can sign in.
	changes, problems = UpdateProfileRequest{Phone: text("")}.normalize(user)
	if len(problems) != 0 || changes.Phone == nil || *changes.Phone != "" || !changes.changesIdentifier() {
		t.Fatalf("clearing the phone: changes %+v problems %v", changes, problems)
	}
}
