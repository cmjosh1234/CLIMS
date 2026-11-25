package integration

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// testExports checks report exports (RF15, RN02) after the settings checks, with the hotspot's 290
// acknowledged male pieces this month, and that reports are no longer approved.
func testExports(t *testing.T, pool *pgxpool.Pool,
	request func(string, string, any, string, int) map[string]any,
	admin string,
) {
	t.Helper()
	data := func(method, path string, body any, token string, code int) map[string]any {
		t.Helper()
		return request(method, path, body, token, code)["data"].(map[string]any)
	}
	male := func(table map[string]any) float64 {
		var sum float64
		for _, row := range table["rows"].([]any) {
			sum += row.(map[string]any)["ct12_male_pieces"].(float64)
		}
		return sum
	}

	// An export carries the rows behind the screen with its period, scope and product (RF15, RN02).
	exported := data("GET", "/reports/export/notifications?format=json", nil, admin, 200)
	summary := data("GET", "/reports/notifications", nil, admin, 200)
	if float64(len(exported["rows"].([]any))) != summary["notifications_raised"].(float64) || exported["scope"] != "National" ||
		exported["product"] != "Male and female condoms" || exported["filters"].(map[string]any)["from"] != summary["period"].(map[string]any)["from"] {
		t.Fatalf("notification export does not match the report: %v", exported)
	}
	// Each report names the date that places a record in its period.
	if exported["date_basis"] != summary["date_basis"] || !strings.HasPrefix(exported["date_basis"].(string), "Date the notification was first raised") {
		t.Fatalf("notification export date basis: %v, report: %v", exported["date_basis"], summary["date_basis"])
	}
	if hmis := data("GET", "/reports/export/hmis-105?format=json", nil, admin, 200); male(hmis) != 290 {
		t.Fatalf("HMIS export: %v", hmis)
	}
	request("GET", "/reports/export/unknown", nil, admin, 400)
	request("GET", "/reports/export/stock?colour=red", nil, admin, 400)
	request("GET", "/reports/export/stock?format=xml", nil, admin, 400)

	// Reports are not approved (migration 43): no permission to approve remains.
	var approve int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM permissions WHERE name = 'reports:approve'`).
		Scan(&approve); err != nil || approve != 0 {
		t.Fatalf("reports:approve should be gone: %d %v", approve, err)
	}
}
