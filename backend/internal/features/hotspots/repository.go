package hotspots

import (
	"context"
	"errors"
	"slices"

	"clims-backend/internal/features/audit"
	"clims-backend/internal/features/notifications"
	"clims-backend/internal/features/orders"
	"clims-backend/internal/features/users"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidLocation   = errors.New("subcounty must belong to the district, and the district to the region")
	ErrDuplicateName     = errors.New("a hotspot with this name already exists in the village")
	ErrNotEditable       = errors.New("active hotspots cannot be edited")
	ErrDistrictLocked    = errors.New("a deactivated hotspot cannot move to another district")
	ErrInvalidTransition = errors.New("action is unavailable in the hotspot's current review status")
)

// transition is a DCFP decision: the review statuses it applies to, the review
// status it sets, and the comment action and event it records.
type transition struct {
	from          []string
	review        string
	commentAction string
	event         string
}

var transitions = map[string]transition{
	"activate":   {[]string{ReviewSubmitted, ReviewDeactivated}, ReviewActive, ActionActivated, EventActivated},
	"deactivate": {[]string{ReviewActive}, ReviewDeactivated, ActionDeactivated, EventDeactivated},
	// A rejected hotspot must be resubmitted by its VHT before it can be activated.
	"reject": {[]string{ReviewSubmitted}, ReviewRejected, ActionRejected, EventRejected},
}

// scope decides which hotspots a user sees: their own submissions (submit),
// every hotspot in the district of their assigned store (activate), the active
// hotspots in the district they work in (readDistrict), or every hotspot
// (allDistricts).
type scope struct {
	userID       string
	storeID      *string
	submit       bool
	activate     bool
	readDistrict bool
	allDistricts bool
}

// District visibility modes, passed as $3 so callers keep $5 onwards for their own parameters.
const (
	districtNone   = 0
	districtAll    = 1 // every hotspot in the district of the assigned store (DCFPs)
	districtActive = 2 // active hotspots in the district the user works in (VHTs requesting stock)
)

// districtMode picks the widest district visibility the scope allows.
func (s scope) districtMode() int {
	switch {
	case s.activate:
		return districtAll
	case s.readDistrict:
		return districtActive
	default:
		return districtNone
	}
}

type Repository struct {
	db       *pgxpool.Pool
	notifier notifications.Notifier
	audit    audit.Auditor
}

// NewRepository needs a notifier with NotificationTypes registered.
func NewRepository(db *pgxpool.Pool, notifier notifications.Notifier, auditor audit.Auditor) *Repository {
	return &Repository{db: db, notifier: notifier, audit: auditor}
}

// The district a DCFP is responsible for, from their assigned store ($1 is the user).
const assignedDistrict = `(SELECT s.district_id FROM users u JOIN stores s ON s.id = u.store_id WHERE u.id = $1::uuid)`

// Parameters $1 user ID, $2 submit, $3 district mode and $4 all districts are reserved by this filter.
const visibleHotSpots = `($4::boolean OR ($2::boolean AND h.submitted_by_id = $1::uuid)
	OR ($3::int = 1 AND h.district_id = ` + assignedDistrict + `)
	OR ($3::int = 2 AND h.status = 'active' AND h.district_id = ` + users.DistrictOfUser + `))`

func visibleArgs(access scope, args ...any) []any {
	return append([]any{access.userID, access.submit, access.districtMode(), access.allDistricts}, args...)
}

// preciseLocation decides who sees a hotspot's coordinates, village and contact (reporting
// requirements RF12, "protect precise coordinates and contacts"): national users, the DCFPs of its
// district, the VHT who submitted it and its manager. Others who may see it, such as VHTs choosing a
// hotspot in their district, see where it is to the subcounty. It uses the parameters of visibleHotSpots,
// and an unknown comparison (no submitter, no assigned hotspot) counts as not precise.
const preciseLocation = `coalesce($4::boolean OR h.submitted_by_id = $1::uuid
	OR h.id = (SELECT pu.hot_spot_id FROM users pu WHERE pu.id = $1::uuid)
	OR ($3::int = 1 AND h.district_id = ` + assignedDistrict + `), false)`

// notificationStatus is the status of the hotspot's open stockout notification, or none.
const notificationStatus = `coalesce(ns.status, 'none')`

const hotSpotColumns = `h.id, h.name, h.type, h.village,
	r.id, r.name, d.id, d.name, sc.id, sc.name,
	h.latitude::float8, h.longitude::float8, h.has_condom_dispenser, h.dispenser_condition,
	h.status, h.review_status, h.submitted_by_id, cp.id, cp.name, cp.phone_number, h.created_at, h.updated_at,
	` + preciseLocation + `, ` + notificationStatus

const hotSpotTables = ` FROM hot_spots h
	LEFT JOIN districts d ON d.id = h.district_id
	LEFT JOIN regions r ON r.id = d.region_id
	LEFT JOIN subcounties sc ON sc.id = h.subcounty_id
	LEFT JOIN LATERAL (SELECT id, name, phone_number FROM contact_persons
		WHERE hot_spot_id = h.id ORDER BY created_at DESC, id DESC LIMIT 1) cp ON true
	LEFT JOIN LATERAL (SELECT ` + orders.NotificationStatus + ` AS status FROM stockout_reports r` + orders.NotificationFacts + `
		WHERE r.hot_spot_id = h.id AND r.fulfilled_at IS NULL AND r.rejected_at IS NULL ORDER BY r.created_at DESC, r.id DESC LIMIT 1) ns ON true`

func place(id, name *string) *Place {
	if id == nil || name == nil {
		return nil
	}
	return &Place{ID: *id, Name: *name}
}

func scanHotSpot(row pgx.Row) (HotSpot, error) {
	var h HotSpot
	var regionID, regionName, districtID, districtName, subcountyID, subcountyName *string
	var contactID, contactName, contactPhone *string
	var precise bool
	if err := row.Scan(&h.ID, &h.Name, &h.Type, &h.Village,
		&regionID, &regionName, &districtID, &districtName, &subcountyID, &subcountyName,
		&h.Latitude, &h.Longitude, &h.HasCondomDispenser, &h.DispenserCondition,
		&h.Status, &h.ReviewStatus, &h.SubmittedByID, &contactID, &contactName, &contactPhone,
		&h.CreatedAt, &h.UpdatedAt, &precise, &h.NotificationStatus); err != nil {
		return HotSpot{}, err
	}
	h.LocationPrecision = PrecisionExact
	if !precise {
		h.LocationPrecision = PrecisionSubcounty
		h.Village, h.Latitude, h.Longitude = nil, nil, nil
		contactID = nil
	}
	h.Region = place(regionID, regionName)
	h.District = place(districtID, districtName)
	h.Subcounty = place(subcountyID, subcountyName)
	if contactID != nil {
		h.ContactPerson = &ContactPerson{ID: *contactID, Name: contactName, PhoneNumber: contactPhone}
	}
	return h, nil
}

// Filter narrows a list within what the user can already see. Empty fields match everything.
type Filter struct {
	Status        string
	ReviewStatus  string
	SubmittedByID *string
	DistrictID    *string
	// NotificationStatus is none, or the status of the hotspot's open stockout notification.
	NotificationStatus string
	// Search matches the hotspot's name, village, subcounty or district, or its manager's name or
	// phone, ignoring case.
	Search string
}

// list returns visible hotspots, most recently updated first.
func (r *Repository) list(ctx context.Context, access scope, f Filter, limit, offset int32) ([]HotSpot, error) {
	rows, err := r.db.Query(ctx, `SELECT `+hotSpotColumns+hotSpotTables+
		` WHERE `+visibleHotSpots+` AND ($5 = '' OR h.status = $5) AND ($6 = '' OR h.review_status = $6)
			AND ($7::uuid IS NULL OR h.submitted_by_id = $7) AND ($8::uuid IS NULL OR h.district_id = $8)
			AND ($9 = '' OR `+notificationStatus+` = $9)
			AND ($12 = '' OR h.name ILIKE $12 OR h.village ILIKE $12 OR sc.name ILIKE $12 OR d.name ILIKE $12
				OR cp.name ILIKE $12 OR cp.phone_number ILIKE $12)
		ORDER BY h.updated_at DESC, h.id DESC LIMIT $10 OFFSET $11`,
		visibleArgs(access, f.Status, f.ReviewStatus, f.SubmittedByID, f.DistrictID, f.NotificationStatus, limit, offset,
			orders.ContainsPattern(f.Search))...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (HotSpot, error) { return scanHotSpot(row) })
}

func (r *Repository) get(ctx context.Context, access scope, id string) (Detail, error) {
	h, err := scanHotSpot(r.db.QueryRow(ctx, `SELECT `+hotSpotColumns+hotSpotTables+
		` WHERE `+visibleHotSpots+` AND h.id = $5`, visibleArgs(access, id)...))
	if err != nil {
		return Detail{}, err
	}
	rows, err := r.db.Query(ctx, `SELECT id, user_id, action, comment, created_at FROM hot_spot_comments
		WHERE hot_spot_id = $1 ORDER BY created_at, id`, id)
	if err != nil {
		return Detail{}, err
	}
	comments, err := pgx.CollectRows(rows, pgx.RowToStructByPos[Comment])
	return Detail{HotSpot: h, Comments: comments}, err
}

// submit records a VHT's new hotspot as submitted and inactive, and notifies the district.
func (r *Repository) submit(ctx context.Context, actorID string, input SubmitRequest) (string, error) {
	var id string
	err := pgx.BeginFunc(ctx, r.db, func(tx pgx.Tx) error {
		if err := checkDetails(ctx, tx, input.Details, nil); err != nil {
			return err
		}
		d := input.Details
		if err := tx.QueryRow(ctx, `INSERT INTO hot_spots (name, type, village, district_id, subcounty_id,
			submitted_by_id, latitude, longitude, has_condom_dispenser, dispenser_condition, status, review_status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'inactive', 'submitted') RETURNING id`,
			d.Name, d.Type, d.Village, d.DistrictID, d.SubcountyID, actorID,
			d.Latitude, d.Longitude, d.HasCondomDispenser, d.DispenserCondition).Scan(&id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO contact_persons (name, phone_number, hot_spot_id)
			VALUES ($1, $2, $3)`, d.ContactPersonName, d.ContactPersonPhone, id); err != nil {
			return err
		}
		if input.Comment != nil {
			if err := addComment(ctx, tx, id, actorID, ActionComment, *input.Comment); err != nil {
				return err
			}
		}
		return r.record(ctx, tx, id, actorID, EventSubmitted, nil, true, nil, nil)
	})
	return id, err
}

// update lets the submitting VHT correct their hotspot while it is inactive.
// Editing a rejected hotspot resubmits it for review. A deactivated hotspot keeps
// its district, so moving it cannot hand the decision to another district's DCFP.
func (r *Repository) update(ctx context.Context, actorID, id string, d Details) error {
	return pgx.BeginFunc(ctx, r.db, func(tx pgx.Tx) error {
		var status, review string
		var district *string
		if err := tx.QueryRow(ctx, `SELECT status, review_status, district_id FROM hot_spots
			WHERE id = $1 AND submitted_by_id = $2 FOR UPDATE`, id, actorID).Scan(&status, &review, &district); err != nil {
			return err
		}
		if status != StatusInactive {
			return ErrNotEditable
		}
		before, err := snapshot(ctx, tx, id)
		if err != nil {
			return err
		}
		if review == ReviewDeactivated && (district == nil || *district != d.DistrictID) {
			return ErrDistrictLocked
		}
		if err := checkDetails(ctx, tx, d, &id); err != nil {
			return err
		}
		event := EventUpdated
		if review == ReviewRejected {
			review, event = ReviewSubmitted, EventResubmitted
		}
		if _, err := tx.Exec(ctx, `UPDATE hot_spots SET name = $2, type = $3, village = $4, district_id = $5,
			subcounty_id = $6, latitude = $7, longitude = $8, has_condom_dispenser = $9,
			dispenser_condition = $10, review_status = $11, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
			id, d.Name, d.Type, d.Village, d.DistrictID, d.SubcountyID,
			d.Latitude, d.Longitude, d.HasCondomDispenser, d.DispenserCondition, review); err != nil {
			return err
		}
		// Keep earlier contacts as history; add a row only when the contact changed.
		if _, err := tx.Exec(ctx, `INSERT INTO contact_persons (name, phone_number, hot_spot_id)
			SELECT $2::varchar, $3::varchar, $1::uuid WHERE NOT EXISTS (
				SELECT 1 FROM (SELECT name, phone_number FROM contact_persons WHERE hot_spot_id = $1::uuid
					ORDER BY created_at DESC, id DESC LIMIT 1) latest
				WHERE latest.name IS NOT DISTINCT FROM $2::varchar
					AND latest.phone_number IS NOT DISTINCT FROM $3::varchar)`,
			id, d.ContactPersonName, d.ContactPersonPhone); err != nil {
			return err
		}
		return r.record(ctx, tx, id, actorID, event, before, true, nil, nil)
	})
}

// comment adds to a visible hotspot's thread. A comment from the submitter
// notifies the district; anyone else's comment notifies the submitter.
func (r *Repository) comment(ctx context.Context, access scope, id, text string) error {
	// Seeing a district's active hotspots is for requesting stock; it doesn't open their threads,
	// which stay between the submitter and the DCFP (9).
	access.readDistrict = false
	// Seeing every district is for oversight: MOH reads every thread but writes in none. Only someone
	// who also submits or reviews hotspots may comment beyond their own.
	if !access.submit && !access.activate {
		access.allDistricts = false
	}
	return pgx.BeginFunc(ctx, r.db, func(tx pgx.Tx) error {
		var submittedBy *string
		if err := tx.QueryRow(ctx, `SELECT h.submitted_by_id FROM hot_spots h WHERE `+visibleHotSpots+
			` AND h.id = $5 FOR UPDATE OF h`, visibleArgs(access, id)...).Scan(&submittedBy); err != nil {
			return err
		}
		before, err := snapshot(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := addComment(ctx, tx, id, access.userID, ActionComment, text); err != nil {
			return err
		}
		// Comments count as activity so the thread surfaces at the top of lists.
		if _, err := tx.Exec(ctx, `UPDATE hot_spots SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, id); err != nil {
			return err
		}
		fromSubmitter := submittedBy != nil && *submittedBy == access.userID
		var notifyUser *string
		if !fromSubmitter {
			notifyUser = submittedBy
		}
		return r.record(ctx, tx, id, access.userID, EventCommented, before, fromSubmitter, notifyUser, &text)
	})
}

// decide applies a DCFP decision to a hotspot in their district, recording the
// required comment and notifying the submitter.
func (r *Repository) decide(ctx context.Context, access scope, id, action, text string) error {
	step := transitions[action]
	return pgx.BeginFunc(ctx, r.db, func(tx pgx.Tx) error {
		var review string
		var submittedBy *string
		if err := tx.QueryRow(ctx, `SELECT h.review_status, h.submitted_by_id FROM hot_spots h
			WHERE h.id = $2 AND ($3::boolean OR h.district_id = `+assignedDistrict+`) FOR UPDATE OF h`,
			access.userID, id, access.allDistricts).Scan(&review, &submittedBy); err != nil {
			return err
		}
		if !slices.Contains(step.from, review) {
			return ErrInvalidTransition
		}
		before, err := snapshot(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE hot_spots SET status = $2, review_status = $3,
			updated_at = CURRENT_TIMESTAMP WHERE id = $1`, id, statusFor(step.review), step.review); err != nil {
			return err
		}
		if err := addComment(ctx, tx, id, access.userID, step.commentAction, text); err != nil {
			return err
		}
		return r.record(ctx, tx, id, access.userID, step.event, before, false, submittedBy, &text)
	})
}

// events returns a visible hotspot's workflow history, oldest first.
func (r *Repository) events(ctx context.Context, access scope, id string) ([]Event, error) {
	var visible bool
	if err := r.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM hot_spots h WHERE `+visibleHotSpots+
		` AND h.id = $5)`, visibleArgs(access, id)...).Scan(&visible); err != nil {
		return nil, err
	}
	if !visible {
		return nil, pgx.ErrNoRows
	}
	rows, err := r.db.Query(ctx, `SELECT e.id, e.hot_spot_id, h.name, e.actor_id, e.action, e.status, e.created_at
		FROM hot_spot_events e JOIN hot_spots h ON h.id = e.hot_spot_id
		WHERE e.hot_spot_id = $1 ORDER BY e.created_at, e.id`, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Event])
}

// notifications is the inbox: events addressed to the user, their district's
// events for DCFPs, and every addressed event with all districts.
func (r *Repository) notifications(ctx context.Context, access scope, limit, offset int32) ([]Event, error) {
	rows, err := r.db.Query(ctx, `SELECT e.id, e.hot_spot_id, h.name, e.actor_id, e.action, e.status, e.created_at
		FROM hot_spot_events e JOIN hot_spots h ON h.id = e.hot_spot_id
		WHERE e.notify_user_id = $1::uuid
			OR ($2::boolean AND e.notify_district_id = `+assignedDistrict+`)
			OR ($3::boolean AND (e.notify_district_id IS NOT NULL OR e.notify_user_id IS NOT NULL))
		ORDER BY e.created_at DESC, e.id DESC LIMIT $4 OFFSET $5`,
		access.userID, access.activate, access.allDistricts, limit, offset)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Event])
}

// checkDetails validates the location chain and the "no duplicate name in the
// same village" rule. Hotspots without a village are compared with each other;
// legacy hotspots without a subcounty are compared by district.
func checkDetails(ctx context.Context, tx pgx.Tx, d Details, excludeID *string) error {
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM subcounties s JOIN districts d ON d.id = s.district_id
		WHERE s.id = $1 AND d.id = $2 AND d.region_id = $3)`, d.SubcountyID, d.DistrictID, d.RegionID).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return ErrInvalidLocation
	}
	// Serialize concurrent submissions of the same name in the same village.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(
		$1 || '|' || hot_spot_label($2) || '|' || hot_spot_label($3), 8))`,
		d.DistrictID, d.Village, d.Name); err != nil {
		return err
	}
	var duplicate bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM hot_spots h
		WHERE hot_spot_label(h.name) = hot_spot_label($1) AND hot_spot_label(h.village) = hot_spot_label($2)
			AND (h.subcounty_id = $3 OR (h.subcounty_id IS NULL AND h.district_id = $4))
			AND h.id IS DISTINCT FROM $5::uuid)`,
		d.Name, d.Village, d.SubcountyID, d.DistrictID, excludeID).Scan(&duplicate); err != nil {
		return err
	}
	if duplicate {
		return ErrDuplicateName
	}
	return nil
}

func addComment(ctx context.Context, tx pgx.Tx, hotSpotID, userID, action, text string) error {
	_, err := tx.Exec(ctx, `INSERT INTO hot_spot_comments (hot_spot_id, user_id, action, comment)
		VALUES ($1, $2, $3, $4)`, hotSpotID, userID, action, text)
	return err
}
