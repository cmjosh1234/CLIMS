package reports

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Consumption (decided 2026-11-25) is read from demand and supply, since CLIMS does not record what
// hotspots hand out: how often a hotspot sends stockout requests and what its district delivers
// against them. One level up, a district's orders to NMS and JMS and what reached it; one more, what
// each warehouse was asked for and sent. Requests raised in the period count, with everything
// delivered against them whenever it arrived.
const (
	ConsumptionHotspot   = "hotspot"
	ConsumptionDistrict  = "district"
	ConsumptionWarehouse = "warehouse"
)

const consumptionBasis = "Requests raised in the period, in Africa/Kampala, with everything delivered against them up to the data update time."

// ConsumptionFilter narrows the consumption report.
type ConsumptionFilter struct {
	Filter
	Level       string
	WarehouseID *string
	// Requested is the type a request named: male, female or both (hotspots), male or female (orders).
	Requested string
	// Sent narrows deliveries to one type; CondomID to one product.
	Sent     string
	CondomID *string
	// Search matches the hotspot, district or warehouse name, ignoring case.
	Search string
}

// containsPattern is an ILIKE pattern for text containing search, LIKE's wildcards taken literally;
// "" for no search.
func containsPattern(search string) string {
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}

var errRequestedBoth = errors.New("requested=both applies to hotspot requests; district orders name male or female")

// Pieces are condom pieces by type.
type Pieces struct {
	Male   int64 `json:"male"`
	Female int64 `json:"female"`
}

// HotspotConsumption is what hotspots asked for and received.
type HotspotConsumption struct {
	// Requests raised, each counted once; messages adds the repeats sent against an open request.
	Requests int64 `json:"requests"`
	Messages int64 `json:"messages"`
	Rejected int64 `json:"rejected"`
	// AverageDaysBetween is the mean gap between a hotspot's requests in the period; null under two.
	AverageDaysBetween *float64 `json:"average_days_between"`
	Delivered          Pieces   `json:"delivered_pieces"`
	// Received is what the hotspot's manager acknowledged: the consumption figure.
	Received Pieces `json:"received_pieces"`
}

// OrderConsumption is what districts ordered from the warehouses and what reached them.
type OrderConsumption struct {
	Orders             int64    `json:"orders"`
	Rejected           int64    `json:"rejected"`
	AverageDaysBetween *float64 `json:"average_days_between"`
	Requested          Pieces   `json:"requested_pieces"`
	Approved           Pieces   `json:"approved_pieces"`
	Issued             Pieces   `json:"issued_pieces"`
	Received           Pieces   `json:"received_pieces"`
	// Unconverted is orders whose quantity has no pieces yet: no product chosen, or another unit.
	Unconverted int64 `json:"unconverted"`
}

// ConsumptionMonth is one Kampala month of the trend: requests raised then, and what reached them.
type ConsumptionMonth struct {
	Month    string `json:"month"`
	Requests int64  `json:"requests"`
	Received Pieces `json:"received_pieces"`
}

// ConsumptionReport is the summary of one level.
type ConsumptionReport struct {
	Level         string    `json:"level"`
	Period        Period    `json:"period"`
	DateBasis     string    `json:"date_basis"`
	DataUpdatedAt time.Time `json:"data_updated_at"`
	// Hotspot level.
	Hotspots   *HotspotTotals            `json:"hotspots,omitempty"`
	ByDistrict []HotspotConsumptionGroup `json:"by_district,omitempty"`
	// District and warehouse levels.
	Orders *OrderConsumption `json:"orders,omitempty"`
	// Warehouse level: stock sent to districts without an order, kept apart.
	WithoutOrder *UnrequestedDispatches `json:"dispatches_without_order,omitempty"`
	Monthly      []ConsumptionMonth     `json:"monthly"`
	FieldSync    *FieldSync             `json:"field_sync,omitempty"`
}

// HotspotTotals adds how many hotspots asked, and how many active hotspots in scope did not.
type HotspotTotals struct {
	HotspotConsumption
	HotspotsRequesting int64 `json:"hotspots_requesting"`
	SilentHotspots     int64 `json:"silent_hotspots"`
}

type HotspotConsumptionGroup struct {
	DistrictID *string `json:"district_id"`
	District   *string `json:"district"`
	HotspotConsumption
	HotspotsRequesting int64 `json:"hotspots_requesting"`
}

// HotspotConsumptionRecord is one requesting hotspot, flat so it exports as one row.
type HotspotConsumptionRecord struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	DistrictID         *string   `json:"district_id"`
	District           *string   `json:"district"`
	Subcounty          *string   `json:"subcounty"`
	LastRequestedAt    time.Time `json:"last_requested_at"`
	Requests           int64     `json:"requests"`
	Messages           int64     `json:"messages"`
	Rejected           int64     `json:"rejected"`
	AverageDaysBetween *float64  `json:"average_days_between"`
	DeliveredMale      int64     `json:"delivered_male_pieces"`
	DeliveredFemale    int64     `json:"delivered_female_pieces"`
	ReceivedMale       int64     `json:"received_male_pieces"`
	ReceivedFemale     int64     `json:"received_female_pieces"`
}

// OrderConsumptionRecord is one district, or one warehouse, flat so it exports as one row.
type OrderConsumptionRecord struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	DistrictID         *string   `json:"district_id"`
	LastOrderedAt      time.Time `json:"last_ordered_at"`
	Orders             int64     `json:"orders"`
	Rejected           int64     `json:"rejected"`
	AverageDaysBetween *float64  `json:"average_days_between"`
	RequestedMale      int64     `json:"requested_male_pieces"`
	RequestedFemale    int64     `json:"requested_female_pieces"`
	ApprovedMale       int64     `json:"approved_male_pieces"`
	ApprovedFemale     int64     `json:"approved_female_pieces"`
	IssuedMale         int64     `json:"issued_male_pieces"`
	IssuedFemale       int64     `json:"issued_female_pieces"`
	ReceivedMale       int64     `json:"received_male_pieces"`
	ReceivedFemale     int64     `json:"received_female_pieces"`
	Unconverted        int64     `json:"unconverted"`
	// Warehouse level: stock it sent to districts without an order.
	DispatchesWithoutOrder *int64 `json:"dispatches_without_order"`
	PiecesWithoutOrder     *int64 `json:"pieces_without_order"`
}

// ----------------------------------------------------------------------------------------- hotspots

// hotspotRequestsCTE is the stockout requests the user may see that were raised in the period and
// match the filters (r), and the delivery lines against them that match the type and product sent (l).
// $1 all, $2 store, $3 hotspot, $4 user, $5 district they work in, $6 district filter, $7 from, $8 to,
// $9 requested, $10 sent, $11 product, $12 search.
const hotspotRequestsCTE = `WITH r AS (
	SELECT r.id, r.hot_spot_id, r.repeat_count, r.created_at, r.rejected_at, h.name AS hot_spot,
		h.district_id, d.name AS district, sc.name AS subcounty
	FROM stockout_reports r
	JOIN hot_spots h ON h.id = r.hot_spot_id
	LEFT JOIN districts d ON d.id = h.district_id
	LEFT JOIN subcounties sc ON sc.id = h.subcounty_id
	WHERE ($1::boolean OR r.district_store_id = $2::uuid OR r.hot_spot_id = $3::uuid OR r.reported_by_id = $4::uuid
			OR h.district_id = $5::uuid)
		AND r.created_at >= $7 AND r.created_at < $8
		AND ($6::uuid IS NULL OR h.district_id = $6) AND ($9 = '' OR r.selection = $9)
		AND ($12 = '' OR h.name ILIKE $12 OR d.name ILIKE $12 OR sc.name ILIKE $12)),
	l AS (
	SELECT r.id AS report_id, r.hot_spot_id, r.district_id, l.category, l.pieces,
		coalesce(l.acknowledged_pieces, 0) AS received
	FROM r JOIN hotspot_deliveries hd ON hd.stockout_report_id = r.id
	JOIN hotspot_delivery_lines l ON l.delivery_id = hd.id
	WHERE ($10 = '' OR l.category = $10) AND ($11::uuid IS NULL OR l.condom_id = $11))`

const namedPieceColumns = `coalesce(sum(l.pieces) FILTER (WHERE l.category = 'male'), 0) AS male_d,
	coalesce(sum(l.pieces) FILTER (WHERE l.category = 'female'), 0) AS female_d,
	coalesce(sum(l.received) FILTER (WHERE l.category = 'male'), 0) AS male_r,
	coalesce(sum(l.received) FILTER (WHERE l.category = 'female'), 0) AS female_r`

func (s scope) consumptionArgs(f ConsumptionFilter) []any {
	return []any{s.all, s.storeID, s.hotSpotID, s.userID, s.districtID, f.DistrictID, f.From, f.To,
		f.Requested, f.Sent, f.CondomID, containsPattern(f.Search)}
}

// perHotspot is each requesting hotspot's figures; avg_days is the hotspot's mean gap between requests.
const perHotspot = `, per AS (
	SELECT r.hot_spot_id, min(r.hot_spot) AS hot_spot, min(r.district_id::text) AS district_id,
		min(r.district) AS district, min(r.subcounty) AS subcounty, count(*) AS requests,
		sum(1 + r.repeat_count) AS messages, count(*) FILTER (WHERE r.rejected_at IS NOT NULL) AS rejected,
		CASE WHEN count(*) > 1 THEN extract(epoch FROM max(r.created_at) - min(r.created_at)) / 86400 / (count(*) - 1) END AS avg_days,
		max(r.created_at) AS last_requested_at
	FROM r GROUP BY r.hot_spot_id),
	got AS (SELECT l.hot_spot_id, ` + namedPieceColumns + ` FROM l GROUP BY l.hot_spot_id)`

func (r *Repository) hotspotConsumption(ctx context.Context, s scope, f ConsumptionFilter, now time.Time) (ConsumptionReport, error) {
	out := ConsumptionReport{Level: ConsumptionHotspot, Period: periodOf(f.Filter), DateBasis: consumptionBasis,
		DataUpdatedAt: now, Hotspots: &HotspotTotals{}, ByDistrict: []HotspotConsumptionGroup{}, Monthly: []ConsumptionMonth{}}
	args := s.consumptionArgs(f)
	t := out.Hotspots
	// Silent hotspots: active ones in the reader's area (and the district filter) with no matching request.
	if err := r.db.QueryRow(ctx, hotspotRequestsCTE+perHotspot+`,
		reader AS (SELECT coalesce($5::uuid, (SELECT district_id FROM stores WHERE id = $2::uuid AND store_type = 'district')) AS district_id)
		SELECT coalesce(sum(per.requests), 0), coalesce(sum(per.messages), 0), coalesce(sum(per.rejected), 0),
			avg(per.avg_days), count(per.hot_spot_id),
			(SELECT coalesce(sum(male_d), 0) FROM got), (SELECT coalesce(sum(female_d), 0) FROM got),
			(SELECT coalesce(sum(male_r), 0) FROM got), (SELECT coalesce(sum(female_r), 0) FROM got),
			(SELECT count(*) FROM hot_spots h, reader WHERE h.status = 'active'
				AND ($1::boolean OR h.district_id = reader.district_id OR h.id = $3::uuid)
				AND ($6::uuid IS NULL OR h.district_id = $6)
				AND NOT EXISTS (SELECT 1 FROM r WHERE r.hot_spot_id = h.id))
		FROM per`, args...).Scan(&t.Requests, &t.Messages, &t.Rejected, &t.AverageDaysBetween, &t.HotspotsRequesting,
		&t.Delivered.Male, &t.Delivered.Female, &t.Received.Male, &t.Received.Female, &t.SilentHotspots); err != nil {
		return ConsumptionReport{}, err
	}
	rows, err := r.db.Query(ctx, hotspotRequestsCTE+perHotspot+`
		SELECT per.district_id, per.district, sum(per.requests), sum(per.messages), sum(per.rejected), avg(per.avg_days),
			count(*), coalesce(sum(g.male_d), 0), coalesce(sum(g.female_d), 0), coalesce(sum(g.male_r), 0),
			coalesce(sum(g.female_r), 0)
		FROM per LEFT JOIN got g ON g.hot_spot_id = per.hot_spot_id
		GROUP BY per.district_id, per.district ORDER BY per.district NULLS LAST`, args...)
	if err != nil {
		return ConsumptionReport{}, err
	}
	out.ByDistrict, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (HotspotConsumptionGroup, error) {
		var g HotspotConsumptionGroup
		c := &g.HotspotConsumption
		err := row.Scan(&g.DistrictID, &g.District, &c.Requests, &c.Messages, &c.Rejected, &c.AverageDaysBetween,
			&g.HotspotsRequesting, &c.Delivered.Male, &c.Delivered.Female, &c.Received.Male, &c.Received.Female)
		return g, err
	})
	if err != nil {
		return ConsumptionReport{}, err
	}
	rows, err = r.db.Query(ctx, hotspotRequestsCTE+`
, rr AS (SELECT l.report_id, sum(l.received) FILTER (WHERE l.category = 'male') AS male,
			sum(l.received) FILTER (WHERE l.category = 'female') AS female FROM l GROUP BY l.report_id)
		SELECT to_char(date_trunc('month', r.created_at AT TIME ZONE 'Africa/Kampala'), 'YYYY-MM') AS month, count(*),
			coalesce(sum(rr.male), 0), coalesce(sum(rr.female), 0)
		FROM r LEFT JOIN rr ON rr.report_id = r.id GROUP BY month ORDER BY month`, args...)
	if err != nil {
		return ConsumptionReport{}, err
	}
	out.Monthly, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (ConsumptionMonth, error) {
		var m ConsumptionMonth
		err := row.Scan(&m.Month, &m.Requests, &m.Received.Male, &m.Received.Female)
		return m, err
	})
	if err != nil {
		return ConsumptionReport{}, err
	}
	sync, err := r.fieldSync(ctx, s, f.DistrictID, nil, notificationActions, f.From, f.To)
	out.FieldSync = &sync
	return out, err
}

func (r *Repository) hotspotConsumptionRecords(ctx context.Context, s scope, f ConsumptionFilter) ([]HotspotConsumptionRecord, error) {
	rows, err := r.db.Query(ctx, hotspotRequestsCTE+perHotspot+`
		SELECT per.hot_spot_id::text, coalesce(per.hot_spot, 'a hotspot'), per.district_id, per.district, per.subcounty,
			per.last_requested_at, per.requests, per.messages, per.rejected, per.avg_days,
			coalesce(g.male_d, 0), coalesce(g.female_d, 0), coalesce(g.male_r, 0), coalesce(g.female_r, 0)
		FROM per LEFT JOIN got g ON g.hot_spot_id = per.hot_spot_id
		ORDER BY per.requests DESC, per.hot_spot, per.hot_spot_id LIMIT $13 OFFSET $14`,
		append(s.consumptionArgs(f), f.Limit, f.Offset)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[HotspotConsumptionRecord])
}

// ----------------------------------------------------------------------------- districts, warehouses

// orderConsumptionColumns aggregate requestsCTE (q) rows: orders, rejected, the mean gap between orders
// (null under two), pieces requested, approved, issued and received by type, and unconverted orders.
const orderConsumptionColumns = `count(*), count(*) FILTER (WHERE q.order_status = 'rejected'),
	CASE WHEN count(*) > 1 THEN extract(epoch FROM max(q.created_at) - min(q.created_at)) / 86400 / (count(*) - 1) END,
	coalesce(sum(q.requested_pieces) FILTER (WHERE q.category = 'male'), 0),
	coalesce(sum(q.requested_pieces) FILTER (WHERE q.category = 'female'), 0),
	coalesce(sum(q.approved_pieces) FILTER (WHERE q.category = 'male'), 0),
	coalesce(sum(q.approved_pieces) FILTER (WHERE q.category = 'female'), 0),
	coalesce(sum(q.issued_pieces) FILTER (WHERE q.category = 'male'), 0),
	coalesce(sum(q.issued_pieces) FILTER (WHERE q.category = 'female'), 0),
	coalesce(sum(q.received_pieces) FILTER (WHERE q.category = 'male'), 0),
	coalesce(sum(q.received_pieces) FILTER (WHERE q.category = 'female'), 0),
	count(*) FILTER (WHERE q.requested_pieces IS NULL)`

func scanOrderConsumption(c *OrderConsumption) []any {
	return []any{&c.Orders, &c.Rejected, &c.AverageDaysBetween, &c.Requested.Male, &c.Requested.Female,
		&c.Approved.Male, &c.Approved.Female, &c.Issued.Male, &c.Issued.Female, &c.Received.Male, &c.Received.Female,
		&c.Unconverted}
}

// ordersWhere narrows requestsCTE to the product and the search ($9 product, $10 search pattern).
const ordersWhere = ` WHERE ($9::uuid IS NULL OR q.condom_id = $9)
	AND ($10 = '' OR q.district ILIKE $10 OR q.district_store ILIKE $10 OR q.warehouse ILIKE $10)`

func (f ConsumptionFilter) orderArgs(s scope) []any {
	supply := SupplyFilter{Filter: f.Filter, WarehouseID: f.WarehouseID}
	// Orders name one type: the type requested and the type sent are the same.
	supply.Category = f.Requested
	if f.Sent != "" {
		supply.Category = f.Sent
	}
	return append(supply.requestArgs(s), f.CondomID, containsPattern(f.Search))
}

func (r *Repository) orderConsumption(ctx context.Context, s scope, f ConsumptionFilter, now time.Time) (ConsumptionReport, error) {
	out := ConsumptionReport{Level: f.Level, Period: periodOf(f.Filter), DateBasis: consumptionBasis,
		DataUpdatedAt: now, Orders: &OrderConsumption{}, Monthly: []ConsumptionMonth{}}
	args := f.orderArgs(s)
	if f.Requested != "" && f.Sent != "" && f.Requested != f.Sent {
		return out, nil // an order names one type, so it cannot be requested as one and sent as another
	}
	if err := r.db.QueryRow(ctx, requestsCTE+` SELECT `+orderConsumptionColumns+` FROM q`+ordersWhere,
		args...).Scan(scanOrderConsumption(out.Orders)...); err != nil {
		return ConsumptionReport{}, err
	}
	rows, err := r.db.Query(ctx, requestsCTE+`
		SELECT to_char(date_trunc('month', q.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Kampala'), 'YYYY-MM') AS month,
			count(*), coalesce(sum(q.received_pieces) FILTER (WHERE q.category = 'male'), 0),
			coalesce(sum(q.received_pieces) FILTER (WHERE q.category = 'female'), 0)
		FROM q`+ordersWhere+` GROUP BY month ORDER BY month`, args...)
	if err != nil {
		return ConsumptionReport{}, err
	}
	out.Monthly, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (ConsumptionMonth, error) {
		var m ConsumptionMonth
		err := row.Scan(&m.Month, &m.Requests, &m.Received.Male, &m.Received.Female)
		return m, err
	})
	if err != nil {
		return ConsumptionReport{}, err
	}
	if f.Level == ConsumptionWarehouse {
		w := &UnrequestedDispatches{}
		if err = r.db.QueryRow(ctx, unrequestedCTE+`
			SELECT count(*), coalesce(sum(q.issued_pieces), 0), coalesce(sum(q.received_pieces), 0),
				count(*) FILTER (WHERE q.order_status = 'dispatched')
			FROM q`+ordersWhere, args...).Scan(&w.Dispatches, &w.IssuedPieces, &w.ReceivedPieces, &w.AwaitingReceipt); err != nil {
			return ConsumptionReport{}, err
		}
		out.WithoutOrder = w
	}
	return out, nil
}

func (r *Repository) orderConsumptionRecords(ctx context.Context, s scope, f ConsumptionFilter) ([]OrderConsumptionRecord, error) {
	if f.Requested != "" && f.Sent != "" && f.Requested != f.Sent {
		return []OrderConsumptionRecord{}, nil
	}
	group := `q.district_id::text, coalesce(q.district, q.district_store), q.district_id`
	if f.Level == ConsumptionWarehouse {
		group = `q.warehouse_id::text, q.warehouse, NULL::uuid`
	}
	rows, err := r.db.Query(ctx, requestsCTE+` SELECT `+group+`, max(q.created_at), `+orderConsumptionColumns+`,
			NULL::bigint, NULL::bigint
		FROM q`+ordersWhere+` GROUP BY `+group+` ORDER BY count(*) DESC, 2 LIMIT $11 OFFSET $12`,
		append(f.orderArgs(s), f.Limit, f.Offset)...)
	if err != nil {
		return nil, err
	}
	records, err := pgx.CollectRows(rows, pgx.RowToStructByPos[OrderConsumptionRecord])
	if err != nil || f.Level != ConsumptionWarehouse {
		return records, err
	}
	// Each warehouse's stock sent without an order, kept apart from its orders.
	for i := range records {
		var dispatches, pieces int64
		if err = r.db.QueryRow(ctx, unrequestedCTE+` SELECT count(*), coalesce(sum(q.issued_pieces), 0)
			FROM q`+ordersWhere+` AND q.warehouse_id::text = $11`, append(f.orderArgs(s), records[i].ID)...).
			Scan(&dispatches, &pieces); err != nil {
			return nil, err
		}
		records[i].DispatchesWithoutOrder, records[i].PiecesWithoutOrder = &dispatches, &pieces
	}
	return records, nil
}

func (r *Repository) consumption(ctx context.Context, s scope, f ConsumptionFilter, now time.Time) (ConsumptionReport, error) {
	if f.Level == ConsumptionHotspot {
		return r.hotspotConsumption(ctx, s, f, now)
	}
	return r.orderConsumption(ctx, s, f, now)
}

// consumptionRecords returns the level's rows: []HotspotConsumptionRecord or []OrderConsumptionRecord.
func (r *Repository) consumptionRecords(ctx context.Context, s scope, f ConsumptionFilter) (any, error) {
	if f.Level == ConsumptionHotspot {
		return r.hotspotConsumptionRecords(ctx, s, f)
	}
	return r.orderConsumptionRecords(ctx, s, f)
}
