package hotspots

import "time"

// Hotspot statuses. Only an active hotspot is in use.
const (
	StatusActive   = "active"
	StatusInactive = "inactive"
)

// Review statuses: the workflow step behind the status. Every review status
// other than active means the hotspot is inactive.
const (
	ReviewSubmitted   = "submitted"
	ReviewRejected    = "rejected"
	ReviewActive      = "active"
	ReviewDeactivated = "deactivated"
)

// statusFor returns the stored status for a review status.
func statusFor(review string) string {
	if review == ReviewActive {
		return StatusActive
	}
	return StatusInactive
}

// Place is a region, district or subcounty from the DHIS2 hierarchy.
type Place struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ContactPerson is the hotspot's manager on site.
type ContactPerson struct {
	ID          string  `json:"id"`
	Name        *string `json:"name"`
	PhoneNumber *string `json:"phone_number"`
}

// HotSpot fields are nullable because converted legacy rows can lack them;
// hotspots submitted through the API always have the required ones.
type HotSpot struct {
	ID                 string         `json:"id"`
	Name               *string        `json:"name"`
	Type               *string        `json:"type"`
	Village            *string        `json:"village"`
	Region             *Place         `json:"region"`
	District           *Place         `json:"district"`
	Subcounty          *Place         `json:"subcounty"`
	Latitude           *float64       `json:"latitude"`
	Longitude          *float64       `json:"longitude"`
	HasCondomDispenser *bool          `json:"has_condom_dispenser"`
	DispenserCondition *string        `json:"dispenser_condition"`
	Status             string         `json:"status"`
	ReviewStatus       string         `json:"review_status"`
	SubmittedByID      *string        `json:"submitted_by_id"`
	ContactPerson      *ContactPerson `json:"contact_person"`
	CreatedAt          time.Time      `json:"created_at"`
	UpdatedAt          time.Time      `json:"updated_at"`
	// LocationPrecision is exact, or subcounty when the reader may not see the village, coordinates
	// and contact, which are then null.
	LocationPrecision string `json:"location_precision"`
	// NotificationStatus is none, or the status of the open stockout notification: awaiting_supply,
	// awaiting_acknowledgement or partly_received.
	NotificationStatus string `json:"notification_status"`
	// DistanceM is the distance in metres from the point of the near filter, present only with it.
	DistanceM *float64 `json:"distance_m,omitempty"`
}

// Location precisions.
const (
	PrecisionExact     = "exact"
	PrecisionSubcounty = "subcounty"
)

// NotificationStatuses are the values of the notification_status filter.
var NotificationStatuses = []string{"none", "awaiting_supply", "awaiting_acknowledgement", "partly_received"}

// Comment actions: a plain comment, or the reason recorded with a DCFP decision.
const (
	ActionComment     = "comment"
	ActionActivated   = "activated"
	ActionDeactivated = "deactivated"
	ActionRejected    = "rejected"
)

type Comment struct {
	ID        string    `json:"id"`
	UserID    *string   `json:"user_id"`
	Action    string    `json:"action"`
	Comment   string    `json:"comment"`
	CreatedAt time.Time `json:"created_at"`
}

// Detail is a hotspot with its comment thread.
type Detail struct {
	HotSpot
	Comments []Comment `json:"comments"`
}

// Event actions recorded in hot_spot_events.
const (
	EventSubmitted   = "submitted"
	EventUpdated     = "updated"
	EventCommented   = "commented"
	EventActivated   = "activated"
	EventDeactivated = "deactivated"
	EventRejected    = "rejected"
	// A rejected hotspot edited by its submitter goes back for review.
	EventResubmitted = "resubmitted"
)

// Event is one workflow step; Status is the review status after it. Events
// with a recipient form the notification inbox.
type Event struct {
	ID          string    `json:"id"`
	HotSpotID   string    `json:"hot_spot_id"`
	HotSpotName *string   `json:"hot_spot_name"`
	ActorID     string    `json:"actor_id"`
	Action      string    `json:"action"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}
