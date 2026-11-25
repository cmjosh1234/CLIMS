package orders

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"clims-backend/internal/features/stock"
	"clims-backend/internal/features/users"
	"clims-backend/internal/pkg/request"
	"clims-backend/internal/pkg/response"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// DistributionLine is one product a district store delivered to a hotspot against its stockout
// notification, in the product's unit and in pieces, with the manager's acknowledgement once recorded.
// It is the distribution ledger MOH reads on its Distribution screen: one row per delivery line.
type DistributionLine struct {
	ID                 string     `json:"id"`
	DeliveryID         string     `json:"delivery_id"`
	StockoutReportID   string     `json:"stockout_report_id"`
	DeliveredAt        time.Time  `json:"delivered_at"`
	HotSpotID          string     `json:"hot_spot_id"`
	HotSpot            string     `json:"hot_spot"`
	Village            *string    `json:"village"`
	Subcounty          *string    `json:"subcounty"`
	DistrictID         *string    `json:"district_id"`
	District           *string    `json:"district"`
	DistrictStoreID    string     `json:"district_store_id"`
	DistrictStore      string     `json:"district_store"`
	Category           string     `json:"category"`
	CondomID           string     `json:"condom_id"`
	Product            string     `json:"product"`
	Unit               string     `json:"unit"`
	Quantity           int32      `json:"quantity"`
	Pieces             int32      `json:"pieces"`
	SentBy             string     `json:"sent_by"`
	Rider              *string    `json:"rider"`
	RiderPhone         *string    `json:"rider_phone"`
	AcknowledgedPieces *int32     `json:"acknowledged_pieces"`
	AcknowledgedAt     *time.Time `json:"acknowledged_at"`
}

// DistributionSummary totals the delivery lines a DistributionFilter matches.
type DistributionSummary struct {
	Deliveries   int64 `json:"deliveries"`
	Hotspots     int64 `json:"hotspots"`
	Pieces       int64 `json:"pieces"`
	MalePieces   int64 `json:"male_pieces"`
	FemalePieces int64 `json:"female_pieces"`
	// AcknowledgedPieces is what hotspot managers confirmed receiving.
	AcknowledgedPieces int64 `json:"acknowledged_pieces"`
	// UnacknowledgedLines are delivery lines no manager has confirmed yet.
	UnacknowledgedLines int64 `json:"unacknowledged_lines"`
}

// DistributionFilter narrows the distribution ledger. From and To bound the delivery time, To exclusive.
type DistributionFilter struct {
	DistrictID *string
	Category   string
	From, To   *time.Time
	// Search matches the hotspot, its village, subcounty or district, the product or the rider, ignoring case.
	Search string
}

const distributionTables = ` FROM hotspot_delivery_lines l
	JOIN hotspot_deliveries hd ON hd.id = l.delivery_id
	JOIN stockout_reports r ON r.id = hd.stockout_report_id
	JOIN hot_spots h ON h.id = r.hot_spot_id
	JOIN stores s ON s.id = hd.district_store_id
	JOIN condoms c ON c.id = l.condom_id
	JOIN unit_of_measures um ON um.id = l.unit_of_measure_id
	JOIN users sb ON sb.id = hd.delivered_by_id
	LEFT JOIN users ru ON ru.id = hd.rider_id
	LEFT JOIN districts d ON d.id = h.district_id
	LEFT JOIN subcounties sc ON sc.id = h.subcounty_id`

// distributionWhere limits the ledger to the notifications the user may see (visibleReports, $1–$4)
// and to the filter ($5 district, $6 category, $7 from, $8 to, $9 search pattern).
const distributionWhere = ` WHERE ` + visibleReports + `
	AND ($5::uuid IS NULL OR h.district_id = $5) AND ($6 = '' OR l.category = $6)
	AND ($7::timestamptz IS NULL OR hd.created_at >= $7) AND ($8::timestamptz IS NULL OR hd.created_at < $8)
	AND ($9 = '' OR h.name ILIKE $9 OR h.village ILIKE $9 OR sc.name ILIKE $9 OR d.name ILIKE $9
		OR ` + productLabel + ` ILIKE $9 OR ` + riderName + ` ILIKE $9)`

func distributionArgs(access scope, f DistributionFilter, more ...any) []any {
	return append([]any{access.allStores, access.storeID, access.hotSpotID, access.userID,
		f.DistrictID, f.Category, f.From, f.To, ContainsPattern(f.Search)}, more...)
}

// listDistributions returns delivery lines, newest delivery first.
func (r *Repository) listDistributions(ctx context.Context, access scope, f DistributionFilter, limit, offset int32) ([]DistributionLine, error) {
	rows, err := r.db.Query(ctx, `SELECT l.id, hd.id, r.id, hd.created_at, h.id, coalesce(h.name, 'a hotspot'),
			h.village, sc.name, h.district_id, d.name, s.id, s.name, l.category, l.condom_id, `+productLabel+`,
			um.name, l.quantity, l.pieces,
			coalesce(nullif(btrim(concat_ws(' ', sb.firstname, sb.lastname)), ''), sb.username, 'someone'),
			CASE WHEN ru.id IS NULL THEN NULL ELSE `+riderName+` END, ru.phone_number,
			l.acknowledged_pieces, l.acknowledged_at`+distributionTables+distributionWhere+`
		ORDER BY hd.created_at DESC, hd.id DESC, l.category, l.id LIMIT $10 OFFSET $11`,
		distributionArgs(access, f, limit, offset)...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[DistributionLine])
}

func (r *Repository) summarizeDistributions(ctx context.Context, access scope, f DistributionFilter) (DistributionSummary, error) {
	var s DistributionSummary
	err := r.db.QueryRow(ctx, `SELECT count(DISTINCT hd.id), count(DISTINCT h.id), coalesce(sum(l.pieces), 0),
			coalesce(sum(l.pieces) FILTER (WHERE l.category = 'male'), 0),
			coalesce(sum(l.pieces) FILTER (WHERE l.category = 'female'), 0),
			coalesce(sum(l.acknowledged_pieces), 0), count(l.id) FILTER (WHERE l.acknowledged_at IS NULL)`+
		distributionTables+distributionWhere, distributionArgs(access, f)...).Scan(&s.Deliveries, &s.Hotspots,
		&s.Pieces, &s.MalePieces, &s.FemalePieces, &s.AcknowledgedPieces, &s.UnacknowledgedLines)
	return s, err
}

// distributionFilter reads district_id, category (male or female), from and to (YYYY-MM-DD in Kampala,
// both inclusive) and q.
func distributionFilter(c fiber.Ctx) (DistributionFilter, error) {
	f := DistributionFilter{Category: c.Query("category"), Search: strings.TrimSpace(c.Query("q"))}
	if len(f.Search) > MaxSearch {
		return f, errors.New("q must be at most 100 characters")
	}
	if f.Category != "" && !slices.Contains([]string{"male", "female"}, f.Category) {
		return f, errors.New("category must be male or female")
	}
	if raw := c.Query("district_id"); raw != "" {
		id, err := request.ParseUUID(raw)
		if err != nil {
			return f, errors.New("district_id must be a UUID")
		}
		f.DistrictID = &id
	}
	for _, bound := range []struct {
		name string
		dst  **time.Time
		end  bool
	}{{"from", &f.From, false}, {"to", &f.To, true}} {
		raw := c.Query(bound.name)
		if raw == "" {
			continue
		}
		day, err := time.ParseInLocation(time.DateOnly, raw, stock.Kampala)
		if err != nil {
			return f, errors.New(bound.name + " must be a YYYY-MM-DD date")
		}
		if bound.end {
			day = day.AddDate(0, 0, 1)
		}
		*bound.dst = &day
	}
	if f.From != nil && f.To != nil && !f.From.Before(*f.To) {
		return f, errors.New("from must not be after to")
	}
	return f, nil
}

// distributions lists hotspot delivery lines the user may see, newest first, a page at a time.
func (h *Handler) distributions(c fiber.Ctx) error {
	limit, offset, ok := page(c)
	if !ok {
		return response.Error(c, 400, pageError, nil)
	}
	f, err := distributionFilter(c)
	if err != nil {
		return response.Error(c, 400, err.Error(), nil)
	}
	lines, err := h.repo.listDistributions(c.Context(), scopeFor(users.CurrentUser(c)), f, limit, offset)
	if err != nil {
		return orderError(c, err)
	}
	return response.Success(c, 200, "", lines)
}

// distributionSummary totals what distributions would list with the same filters.
func (h *Handler) distributionSummary(c fiber.Ctx) error {
	f, err := distributionFilter(c)
	if err != nil {
		return response.Error(c, 400, err.Error(), nil)
	}
	summary, err := h.repo.summarizeDistributions(c.Context(), scopeFor(users.CurrentUser(c)), f)
	if err != nil {
		return orderError(c, err)
	}
	return response.Success(c, 200, "", summary)
}
