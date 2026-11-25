package orders

import (
	"errors"
	"log/slog"
	"slices"
	"strconv"
	"strings"

	"clims-backend/internal/features/rbac"
	"clims-backend/internal/features/users"
	"clims-backend/internal/pkg/request"
	"clims-backend/internal/pkg/response"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type Handler struct {
	repo *Repository
}

func RegisterRoutes(router fiber.Router, repo *Repository, jwt, activeUser fiber.Handler) {
	h := &Handler{repo: repo}
	group := router.Group("/orders", jwt, activeUser)
	group.Get("/", rbac.RequirePermission("orders:read"), h.list)
	group.Post("/stockouts", rbac.RequirePermission("orders:stockout"), h.stockout)
	group.Get("/stockouts", rbac.RequirePermission("orders:read"), h.stockouts)
	group.Get("/stockouts/:id", requireReportReader, h.stockoutDetail)
	group.Get("/stockouts/:id/riders", rbac.RequirePermission("orders:supply_hotspots"), h.riders)
	group.Post("/stockouts/:id/deliveries", rbac.RequirePermission("orders:supply_hotspots"), h.delivery)
	group.Post("/stockouts/:id/rejection", rbac.RequirePermission("orders:supply_hotspots"), h.rejection)
	group.Get("/deliveries", rbac.RequirePermission("orders:deliver"), h.myDeliveries)
	group.Get("/hotspot-deliveries", rbac.RequirePermission("orders:read"), h.distributions)
	group.Get("/hotspot-deliveries/summary", rbac.RequirePermission("orders:read"), h.distributionSummary)
	group.Post("/stockouts/:id/acknowledgements", requireAcknowledger, h.acknowledgement)
	group.Post("/warehouse-requests", rbac.RequirePermission("orders:replenish"), h.warehouseRequest)
	group.Post("/district-dispatches", rbac.RequirePermission("orders:process"), h.districtDispatch)
	group.Get("/:id/events", rbac.RequirePermission("orders:read"), h.events)
	group.Post("/:id/actions/:action", h.action, h.performAction)
	group.Get("/:id", rbac.RequirePermission("orders:read"), h.get)
}

func scopeFor(user *users.User) scope {
	return scope{
		storeID:          user.StoreID,
		hotSpotID:        user.HotSpotID,
		userID:           user.ID,
		allStores:        user.HasPermission("orders:all_stores"),
		stockoutDistrict: user.HasPermission("orders:stockout_district"),
		carrier:          user.HasPermission("orders:deliver"),
	}
}

func (h *Handler) list(c fiber.Ctx) error {
	limit, offset, ok := page(c)
	if !ok {
		return response.Error(c, 400, pageError, nil)
	}
	filter := OrderFilter{Type: c.Query("type")}
	filter.Search = strings.TrimSpace(c.Query("q"))
	if len(filter.Search) > MaxSearch {
		return response.Error(c, 400, "q must be at most 100 characters", nil)
	}
	if filter.Type != "" && filter.Type != TypeWarehouseRequest {
		return response.Error(c, 400, "type must be warehouse_request", nil)
	}
	if raw := c.Query("status"); raw != "" {
		for _, status := range strings.Split(raw, ",") {
			if !slices.Contains(OrderStatuses, status) {
				return response.Error(c, 400, "status must be order statuses separated by commas, such as queued,reviewed", nil)
			}
			filter.Statuses = append(filter.Statuses, status)
		}
	}
	for name, target := range map[string]**string{"district_id": &filter.DistrictID, "warehouse_store_id": &filter.WarehouseID} {
		if raw := c.Query(name); raw != "" {
			id, err := request.ParseUUID(raw)
			if err != nil {
				return response.Error(c, 400, name+" must be a UUID", nil)
			}
			*target = &id
		}
	}
	orders, err := h.repo.list(c.Context(), scopeFor(users.CurrentUser(c)), filter, limit, offset)
	if err != nil {
		return orderError(c, err)
	}
	return response.Success(c, 200, "", orders)
}

func (h *Handler) get(c fiber.Ctx) error {
	id, err := request.UUIDParam(c)
	if err != nil {
		return response.Error(c, 400, err.Error(), nil)
	}
	order, err := h.repo.get(c.Context(), scopeFor(users.CurrentUser(c)), id)
	if err != nil {
		return orderError(c, err)
	}
	return response.Success(c, 200, "", order)
}

func orderError(c fiber.Ctx, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return response.Error(c, 404, "order not found", nil)
	}
	if errors.Is(err, errInactiveProduct) {
		const message = "This product is inactive and cannot be ordered."
		return response.Error(c, 422, message, map[string]string{"condom_id": message})
	}
	var dbError *pgconn.PgError
	if errors.As(err, &dbError) {
		switch dbError.Code {
		case "23503":
			return response.Error(c, 422, "a referenced user, store, product or unit does not exist", nil)
		case "23514":
			return response.Error(c, 422, "the order's quantities do not fit together", nil)
		}
	}
	slog.Error("orders operation failed", "error", err)
	return response.Error(c, 500, "orders operation failed", nil)
}

const pageError = "limit must be between 1 and 100 and offset must be nonnegative"

// page reads a list's limit (default 50, at most 100) and offset (default 0).
func page(c fiber.Ctx) (int32, int32, bool) {
	limit, limitErr := strconv.ParseInt(c.Query("limit", "50"), 10, 32)
	offset, offsetErr := strconv.ParseInt(c.Query("offset", "0"), 10, 32)
	if limitErr != nil || offsetErr != nil || limit < 1 || limit > 100 || offset < 0 {
		return 0, 0, false
	}
	return int32(limit), int32(offset), true
}
