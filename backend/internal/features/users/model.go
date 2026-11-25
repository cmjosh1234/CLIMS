package users

import (
	"time"

	"clims-backend/internal/features/rbac"
)

type User struct {
	FacilityAssignment
	ID          string     `json:"id"`
	Username    string     `json:"username"`
	Email       string     `json:"email"`
	FirstName   string     `json:"first_name"`
	LastName    string     `json:"last_name"`
	Firstname   string     `json:"firstname"`
	Lastname    string     `json:"lastname"`
	Phone       string     `json:"phone_number"`
	Location    *string    `json:"location"`
	SubcountyID *string    `json:"subcounty_id"`
	StoreID     *string    `json:"store_id"`
	CreatedAt   *time.Time `json:"created_at"`
	UpdatedAt   *time.Time `json:"updated_at"`
	Status      string     `json:"status"`
	LastLoginAt *time.Time `json:"last_login_at"`
	LoginCount  int        `json:"login_count"`
	// MustChangePassword is true while the account still has a password someone else chose (an
	// administrator or DCFP created it or set a temporary one). Until it is changed with
	// POST /auth/password, the API refuses every other request with 403 password_change_required.
	MustChangePassword bool `json:"must_change_password"`
	// PasswordChangedAt is when the account's holder last chose their password; null if never.
	PasswordChangedAt *time.Time `json:"password_changed_at"`
	// ActiveSessions counts the devices currently signed in.
	ActiveSessions int         `json:"active_sessions"`
	Role           *rbac.Role  `json:"role"`
	Roles          []rbac.Role `json:"roles"`
	PasswordHash   string      `json:"-"`

	OrganisationUnit *AssignedOrganisationUnit `json:"organisation_unit"`
	HotSpot          *AssignedHotSpot          `json:"hot_spot"`
	Subcounty        *AssignedSubcounty        `json:"subcounty"`
	Store            *AssignedStore            `json:"store"`
}

type AssignedOrganisationUnit struct {
	ID        string `json:"id"`
	UID       string `json:"uid"`
	Name      string `json:"name"`
	ShortName string `json:"short_name"`
	Subcounty string `json:"subcounty"`
	District  string `json:"district"`
	Region    string `json:"region"`
}

type AssignedHotSpot struct {
	ID        string   `json:"id"`
	Name      *string  `json:"name"`
	Type      *string  `json:"type"`
	Status    string   `json:"status"`
	Village   *string  `json:"village"`
	Subcounty *string  `json:"subcounty"`
	District  *string  `json:"district"`
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
}

type AssignedSubcounty struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	DistrictID   string `json:"district_id"`
	DistrictName string `json:"district_name"`
}

type AssignedStore struct {
	ID           string  `json:"id"`
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	StoreType    string  `json:"store_type"`
	DistrictID   *string `json:"district_id"`
	DistrictName *string `json:"district_name"`
}

func (u *User) HasPermission(code string) bool {
	if u == nil {
		return false
	}
	for _, role := range u.Roles {
		for _, permission := range role.Permissions {
			if permission == code {
				return true
			}
		}
	}
	return false
}
