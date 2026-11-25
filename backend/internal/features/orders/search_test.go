package orders

import "testing"

func TestContainsPattern(t *testing.T) {
	for search, want := range map[string]string{
		"":        "",
		"Kisenyi": "%Kisenyi%",
		"50%_off": `%50\%\_off%`,
		`a\b`:     `%a\\b%`,
	} {
		if got := ContainsPattern(search); got != want {
			t.Errorf("ContainsPattern(%q) = %q, want %q", search, got, want)
		}
	}
}
