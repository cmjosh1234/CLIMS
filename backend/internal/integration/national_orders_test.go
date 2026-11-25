package integration

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// testNationalOrderLists checks what MOH reads on its Orders page, signed in with the moh role's
// default grants (migrations 39 and 40): every district's stockout notifications and warehouse requests,
// narrowed on the server by district, status, type and warehouse, and no way to act on them.
// The moh role is reset to those defaults first. openReport is the notification the fulfilment checks completed: 300 male and 200 female pieces
// delivered, 290 and 100 acknowledged.
func testNationalOrderLists(t *testing.T, pool *pgxpool.Pool,
	request func(string, string, any, string, int) map[string]any,
	login func(string, string, int) string,
	admin, warehouse, district, otherStore, openReport string,
) {
	t.Helper()
	ctx := context.Background()
	var mohRole, inDistrict, otherDistrict string
	for dest, sql := range map[*string]string{
		&mohRole:       `SELECT id FROM roles WHERE name = 'moh'`,
		&inDistrict:    `SELECT district_id FROM stores WHERE id = '` + district + `'`,
		&otherDistrict: `SELECT district_id FROM stores WHERE id = '` + otherStore + `'`,
	} {
		if err := pool.QueryRow(ctx, sql).Scan(dest); err != nil {
			t.Fatal(err)
		}
	}
	// Earlier checks change the moh role; put back the defaults the suite checked at the start.
	request("PUT", "/roles/"+mohRole+"/permissions", map[string]any{"permissions": []string{"audit:read",
		"hotspots:all_districts", "hotspots:read", "hotspots:read_district", "inventory:read", "orders:all_stores",
		"orders:read", "reports:read", "roles:read", "sync_logs:read", "users:read"}}, admin, 200)
	request("POST", "/users", map[string]any{"username": "workflow-moh", "email": "workflow-moh@example.test",
		"password": "test-password-123", "role_ids": []string{mohRole}}, admin, 201)
	moh := login("workflow-moh@example.test", "test-password-123", 200)
	list := func(path string) []map[string]any {
		t.Helper()
		var rows []map[string]any
		for _, item := range request("GET", path, nil, moh, 200)["data"].([]any) {
			rows = append(rows, item.(map[string]any))
		}
		return rows
	}

	// Stockout notifications: MOH sees the district's, with the pieces delivered and acknowledged.
	var found map[string]any
	for _, row := range list("/orders/stockouts?limit=100&district_id=" + inDistrict) {
		if row["district_id"] != inDistrict {
			t.Fatalf("district filter returned another district's notification: %v", row)
		}
		if row["id"] == openReport {
			found = row
		}
	}
	if found == nil || found["status"] != "fulfilled" || found["delivered_male_pieces"] != float64(300) ||
		found["received_male_pieces"] != float64(290) || found["delivered_female_pieces"] != float64(200) ||
		found["received_female_pieces"] != float64(100) {
		t.Fatalf("MOH should see the fulfilled notification with its pieces: %v", found)
	}
	for _, row := range list("/orders/stockouts?limit=100&district_id=" + otherDistrict) {
		if row["id"] == openReport {
			t.Fatal("another district's filter returned this district's notification")
		}
	}
	for _, row := range list("/orders/stockouts?limit=100&status=fulfilled") {
		if row["status"] != "fulfilled" {
			t.Fatalf("status filter: %v", row)
		}
	}
	// Search matches the hotspot's name, village, subcounty or district, ignoring case.
	var hotSpotName, storeName string
	if err := pool.QueryRow(ctx, `SELECT h.name, s.name FROM stockout_reports r JOIN hot_spots h ON h.id = r.hot_spot_id
		JOIN stores s ON s.id = $2 WHERE r.id = $1`, openReport, district).Scan(&hotSpotName, &storeName); err != nil {
		t.Fatal(err)
	}
	searched := func(path string) map[string]bool {
		t.Helper()
		ids := map[string]bool{}
		for _, row := range list(path) {
			ids[row["id"].(string)] = true
		}
		return ids
	}
	if !searched("/orders/stockouts?limit=100&q=" + url.QueryEscape(strings.ToUpper(hotSpotName[:4])))[openReport] {
		t.Fatalf("searching for %q did not find its request", hotSpotName[:4])
	}
	if len(searched("/orders/stockouts?limit=100&q=no-such-hotspot-anywhere")) != 0 {
		t.Fatal("a search matching nothing returned requests")
	}
	// LIKE's wildcards are taken literally.
	if len(searched("/orders/stockouts?limit=100&q=%25")) != 0 {
		t.Fatal("% should match a literal percent sign, not everything")
	}
	request("GET", "/orders/stockouts?q="+strings.Repeat("a", 101), nil, moh, 400)
	// Several statuses, as the web's "Open" tab asks: the fulfilled request is not among them.
	for _, row := range list("/orders/stockouts?limit=100&status=awaiting_supply,awaiting_acknowledgement,partly_received") {
		if row["id"] == openReport || row["status"] == "fulfilled" || row["status"] == "rejected" {
			t.Fatalf("open statuses returned a closed request: %v", row)
		}
	}
	request("GET", "/orders/stockouts?status=fulfilled,closed", nil, moh, 400)
	request("GET", "/orders/stockouts?status=closed", nil, moh, 400)
	request("GET", "/orders/stockouts?district_id=nope", nil, moh, 400)

	// Warehouse requests: the district's orders to NMS or JMS, by status group and warehouse.
	requests := list("/orders?limit=100&type=warehouse_request&district_id=" + inDistrict)
	if len(requests) == 0 {
		t.Fatal("MOH should see the district's warehouse requests")
	}
	for _, row := range requests {
		if row["hot_spot_id"] != nil || row["ordered_for_store_id"] != district || row["order_status"] == "pending" {
			t.Fatalf("type and district filters: %v", row)
		}
	}
	for _, row := range list("/orders?limit=100&type=warehouse_request&warehouse_store_id=" + warehouse) {
		if row["ordered_from_store_id"] != warehouse {
			t.Fatalf("warehouse filter: %v", row)
		}
	}
	for _, row := range list("/orders?limit=100&type=warehouse_request&status=queued,reviewed,on_hold,confirmed") {
		switch row["order_status"] {
		case "queued", "reviewed", "on_hold", "confirmed":
		default:
			t.Fatalf("status group filter: %v", row)
		}
	}
	// A shipment says when it left the warehouse and when it was received, from its history.
	shipments := list("/orders?limit=100&type=warehouse_request&status=dispatched,received")
	if len(shipments) == 0 {
		t.Fatal("the workflow checks left shipments to find")
	}
	for _, row := range shipments {
		if row["dispatched_at"] == nil || (row["order_status"] == "received") != (row["received_at"] != nil) {
			t.Fatalf("a shipment should carry its dispatch time, and its receipt time once received: %v", row)
		}
	}
	for _, row := range list("/orders?limit=100&type=warehouse_request&status=queued") {
		if row["dispatched_at"] != nil || row["received_at"] != nil {
			t.Fatalf("an order not yet dispatched has no shipment times: %v", row)
		}
	}
	if rejected := list("/orders?limit=100&type=warehouse_request&status=rejected"); len(rejected) == 0 {
		t.Fatal("the rejection checks left a rejected request to find")
	}
	// Search matches the name of the district store the order is for.
	for _, row := range list("/orders?limit=100&type=warehouse_request&q=" + url.QueryEscape(strings.ToLower(storeName))) {
		if row["ordered_for_store_id"] != district {
			t.Fatalf("store search returned another store's order: %v", row)
		}
	}
	if len(list("/orders?limit=100&type=warehouse_request&q="+url.QueryEscape(storeName))) == 0 {
		t.Fatalf("searching for %q found none of its orders", storeName)
	}
	request("GET", "/orders?type=hotspot", nil, moh, 400)
	request("GET", "/orders?status=queued,lost", nil, moh, 400)

	// Distribution: every delivery line to a hotspot, narrowed by district, category, period and search,
	// with totals that match the lines.
	var delivered, acknowledged float64
	lines := list("/orders/hotspot-deliveries?limit=100&district_id=" + inDistrict)
	for _, row := range lines {
		if row["district_id"] != inDistrict {
			t.Fatalf("district filter returned another district's delivery: %v", row)
		}
		if row["stockout_report_id"] == openReport {
			delivered += row["pieces"].(float64)
			if row["acknowledged_pieces"] != nil {
				acknowledged += row["acknowledged_pieces"].(float64)
			}
			if row["hot_spot"] != hotSpotName || row["district_store_id"] != district || row["product"] == "" ||
				row["unit"] == "" || row["sent_by"] == "" {
				t.Fatalf("delivery line is missing what MOH reads: %v", row)
			}
		}
	}
	if delivered != 500 || acknowledged != 390 {
		t.Fatalf("MOH should see the notification's 500 delivered and 390 acknowledged pieces, got %v and %v", delivered, acknowledged)
	}
	for _, row := range list("/orders/hotspot-deliveries?limit=100&category=female&district_id=" + inDistrict) {
		if row["category"] != "female" {
			t.Fatalf("category filter: %v", row)
		}
	}
	for _, row := range list("/orders/hotspot-deliveries?limit=100&district_id=" + otherDistrict) {
		if row["stockout_report_id"] == openReport {
			t.Fatal("another district's filter returned this district's delivery")
		}
	}
	found = nil
	for _, row := range list("/orders/hotspot-deliveries?limit=100&q=" + url.QueryEscape(strings.ToLower(hotSpotName[:4]))) {
		if row["stockout_report_id"] == openReport {
			found = row
		}
	}
	if found == nil {
		t.Fatalf("searching deliveries for %q did not find the hotspot's", hotSpotName[:4])
	}
	if len(list("/orders/hotspot-deliveries?limit=100&from=2000-01-01&to=2000-01-31")) != 0 {
		t.Fatal("a period before any delivery returned deliveries")
	}
	summary := request("GET", "/orders/hotspot-deliveries/summary?district_id="+inDistrict, nil, moh, 200)["data"].(map[string]any)
	var linePieces, maleLines float64
	for _, row := range lines {
		linePieces += row["pieces"].(float64)
		if row["category"] == "male" {
			maleLines += row["pieces"].(float64)
		}
	}
	if summary["pieces"] != linePieces || summary["male_pieces"] != maleLines || summary["deliveries"].(float64) < 1 ||
		summary["hotspots"].(float64) < 1 {
		t.Fatalf("summary does not match the lines (%v pieces, %v male): %v", linePieces, maleLines, summary)
	}
	request("GET", "/orders/hotspot-deliveries?category=both", nil, moh, 400)
	request("GET", "/orders/hotspot-deliveries?from=24-11-2026", nil, moh, 400)
	request("GET", "/orders/hotspot-deliveries?from=2026-02-02&to=2026-02-01", nil, moh, 400)
	request("GET", "/orders/hotspot-deliveries/summary?district_id=nope", nil, moh, 400)

	// The national hotspot list searches on the server, across every district, ignoring case. The
	// whole name is searched: a prefix can match more than one page of the legacy hotspots.
	hotspotIDs := map[string]bool{}
	for _, row := range list("/hotspots?limit=100&q=" + url.QueryEscape(strings.ToUpper(hotSpotName))) {
		hotspotIDs[row["name"].(string)] = true
	}
	if !hotspotIDs[hotSpotName] {
		t.Fatalf("searching hotspots for %q did not find it", strings.ToUpper(hotSpotName))
	}
	if len(list("/hotspots?limit=100&q=no-such-hotspot-anywhere")) != 0 {
		t.Fatal("a hotspot search matching nothing returned hotspots")
	}
	request("GET", "/hotspots?q="+strings.Repeat("a", 101), nil, moh, 400)

	// Reading every district does not let MOH act on any of it.
	request("POST", "/orders/stockouts/"+openReport+"/deliveries", map[string]any{"lines": []map[string]any{}}, moh, 403)
	request("POST", "/orders/warehouse-requests", map[string]any{"warehouse_store_id": warehouse,
		"condom_category": "male", "quantity": 1}, moh, 403)
	// MOH reads accounts (migration 39) but cannot change one.
	request("GET", "/users", nil, moh, 200)
	request("POST", "/users", map[string]any{"username": "moh-made", "email": "moh-made@example.test",
		"password": "test-password-123"}, moh, 403)
}
