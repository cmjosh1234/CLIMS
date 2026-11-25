package integration

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// testConsumption checks the consumption report (decided 2026-11-25): how often hotspots send stockout
// requests and what their district delivers against them, and one level up how often districts order
// from the warehouses and what reaches them. Earlier checks leave requests and orders behind, so the
// figures are compared with SQL over the same records rather than with fixed numbers.
func testConsumption(t *testing.T, pool *pgxpool.Pool,
	request func(string, string, any, string, int) map[string]any,
	admin, districtToken, otherToken, district, hotSpot string,
) {
	t.Helper()
	ctx := context.Background()
	var name, inDistrict string
	if err := pool.QueryRow(ctx, `SELECT h.name, h.district_id FROM hot_spots h WHERE h.id = $1`, hotSpot).
		Scan(&name, &inDistrict); err != nil {
		t.Fatal(err)
	}
	kampala := time.FixedZone("EAT", 3*3600)
	yesterday := time.Now().In(kampala).AddDate(0, 0, -1).Format(time.DateOnly)
	from := time.Now().In(kampala).AddDate(0, 0, -1)
	from = time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, kampala)
	period := "from=" + yesterday

	// What the hotspot asked for since yesterday and what reached it, straight from the records.
	var requests, messages, rejected, deliveredMale, deliveredFemale, receivedMale, receivedFemale float64
	if err := pool.QueryRow(ctx, `SELECT count(*), coalesce(sum(1 + repeat_count), 0),
			count(*) FILTER (WHERE rejected_at IS NOT NULL),
			coalesce((SELECT sum(l.pieces) FILTER (WHERE l.category = 'male') FROM hotspot_delivery_lines l
				JOIN hotspot_deliveries d ON d.id = l.delivery_id JOIN stockout_reports x ON x.id = d.stockout_report_id
				WHERE x.hot_spot_id = $1 AND x.created_at >= $2), 0),
			coalesce((SELECT sum(l.pieces) FILTER (WHERE l.category = 'female') FROM hotspot_delivery_lines l
				JOIN hotspot_deliveries d ON d.id = l.delivery_id JOIN stockout_reports x ON x.id = d.stockout_report_id
				WHERE x.hot_spot_id = $1 AND x.created_at >= $2), 0),
			coalesce((SELECT sum(l.acknowledged_pieces) FILTER (WHERE l.category = 'male') FROM hotspot_delivery_lines l
				JOIN hotspot_deliveries d ON d.id = l.delivery_id JOIN stockout_reports x ON x.id = d.stockout_report_id
				WHERE x.hot_spot_id = $1 AND x.created_at >= $2), 0),
			coalesce((SELECT sum(l.acknowledged_pieces) FILTER (WHERE l.category = 'female') FROM hotspot_delivery_lines l
				JOIN hotspot_deliveries d ON d.id = l.delivery_id JOIN stockout_reports x ON x.id = d.stockout_report_id
				WHERE x.hot_spot_id = $1 AND x.created_at >= $2), 0)
		FROM stockout_reports WHERE hot_spot_id = $1 AND created_at >= $2`, hotSpot, from).
		Scan(&requests, &messages, &rejected, &deliveredMale, &deliveredFemale, &receivedMale, &receivedFemale); err != nil {
		t.Fatal(err)
	}
	if requests < 2 || receivedMale == 0 {
		t.Fatalf("the workflow checks should leave at least two requests and a male receipt: %v requests, %v male received",
			requests, receivedMale)
	}
	records := func(query, token string) map[string]map[string]any {
		t.Helper()
		out := map[string]map[string]any{}
		for _, raw := range request("GET", "/reports/consumption/records?limit=100&"+query, nil, token, 200)["data"].([]any) {
			row := raw.(map[string]any)
			out[row["id"].(string)] = row
		}
		return out
	}
	search := "&q=" + url.QueryEscape(name)

	// Hotspot level: one row per requesting hotspot, matching the records.
	row := records(period+search, admin)[hotSpot]
	if row == nil {
		t.Fatalf("the hotspot is missing from the consumption records")
	}
	for key, want := range map[string]float64{"requests": requests, "messages": messages, "rejected": rejected,
		"delivered_male_pieces": deliveredMale, "delivered_female_pieces": deliveredFemale,
		"received_male_pieces": receivedMale, "received_female_pieces": receivedFemale} {
		if row[key] != want {
			t.Fatalf("hotspot %s = %v, want %v (%v)", key, row[key], want, row)
		}
	}
	if row["average_days_between"] == nil || row["district_id"] != inDistrict {
		t.Fatalf("two or more requests have an average gap, and the row names its district: %v", row)
	}
	// Type sent narrows the delivery lines; type requested narrows the requests.
	if female := records(period+search+"&sent=female", admin)[hotSpot]; female["received_male_pieces"] != float64(0) ||
		female["received_female_pieces"] != receivedFemale {
		t.Fatalf("sent=female: %v", female)
	}
	var both float64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM stockout_reports WHERE hot_spot_id = $1 AND created_at >= $2
		AND selection = 'both'`, hotSpot, from).Scan(&both); err != nil {
		t.Fatal(err)
	}
	if got := records(period+search+"&requested=both", admin)[hotSpot]; both > 0 && got["requests"] != both {
		t.Fatalf("requested=both: %v, want %v requests", got, both)
	}

	// The summary adds up the rows, splits them by district and month, and counts silent hotspots.
	summary := request("GET", "/reports/consumption?"+period+"&district_id="+inDistrict, nil, admin, 200)["data"].(map[string]any)
	totals := summary["hotspots"].(map[string]any)
	if totals["requests"].(float64) < requests || summary["date_basis"] == "" || len(summary["monthly"].([]any)) == 0 ||
		summary["field_sync"] == nil {
		t.Fatalf("hotspot summary: %v", summary)
	}
	var silent float64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM hot_spots h WHERE h.status = 'active' AND h.district_id = $1
		AND NOT EXISTS (SELECT 1 FROM stockout_reports r WHERE r.hot_spot_id = h.id AND r.created_at >= $2)`,
		inDistrict, from).Scan(&silent); err != nil {
		t.Fatal(err)
	}
	if totals["silent_hotspots"] != silent {
		t.Fatalf("silent hotspots = %v, want %v", totals["silent_hotspots"], silent)
	}
	if rows := summary["by_district"].([]any); len(rows) != 1 || rows[0].(map[string]any)["district_id"] != inDistrict {
		t.Fatalf("by district: %v", rows)
	}

	// A district sees its own hotspots; another district's DCFP sees none of them.
	if records(period+search, districtToken)[hotSpot] == nil {
		t.Fatal("the district should see its hotspot's consumption")
	}
	if records(period+search, otherToken)[hotSpot] != nil {
		t.Fatal("another district's DCFP sees this district's hotspot")
	}

	// District level: the district's orders to the warehouses, compared with the orders themselves.
	var orders float64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM orders o JOIN stores fs ON fs.id = o.ordered_from_store_id
		AND fs.store_type = 'national' WHERE o.ordered_for_store_id = $1 AND o.hot_spot_id IS NULL AND NOT o.unrequested
		AND o.order_status NOT IN ('pending', 'fulfilled') AND o.created_at >= $2`, district, from.UTC().Format("2006-01-02 15:04:05")).
		Scan(&orders); err != nil {
		t.Fatal(err)
	}
	districtRow := records("level=district&"+period, admin)[inDistrict]
	if orders > 0 && (districtRow == nil || districtRow["orders"] != orders) {
		t.Fatalf("district orders = %v, want %v", districtRow, orders)
	}
	// Warehouse level: one row per warehouse asked, with its stock sent without an order.
	for id, w := range records("level=warehouse&"+period, admin) {
		if w["dispatches_without_order"] == nil || w["orders"].(float64) < 1 {
			t.Fatalf("warehouse %s row: %v", id, w)
		}
	}
	if request("GET", "/reports/consumption?level=warehouse&"+period, nil, admin, 200)["data"].(map[string]any)["dispatches_without_order"] == nil {
		t.Fatal("the warehouse summary keeps stock sent without an order apart")
	}

	// The export holds the same rows under the level's own columns.
	exported := request("GET", "/reports/export/consumption?format=json&level=district&"+period, nil, admin, 200)["data"].(map[string]any)
	if len(exported["rows"].([]any)) != len(records("level=district&"+period, admin)) || exported["title"] != "Consumption by district" {
		t.Fatalf("consumption export: %v", exported)
	}

	request("GET", "/reports/consumption?level=store", nil, admin, 400)
	request("GET", "/reports/consumption?level=district&requested=both", nil, admin, 400)
	request("GET", "/reports/consumption?sent=both", nil, admin, 400)
	request("GET", "/reports/consumption/records?condom_id=nope", nil, admin, 400)
}
