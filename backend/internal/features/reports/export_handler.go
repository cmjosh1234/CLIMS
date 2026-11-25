package reports

import (
	"bytes"
	"errors"
	"log/slog"
	"time"

	"clims-backend/internal/features/users"
	"clims-backend/internal/pkg/response"

	"github.com/gofiber/fiber/v3"
)

// export downloads a report's rows as calculated now: format=csv, or JSON for the web's Excel export.
func (h *Handler) export(c fiber.Ctx) error {
	p := params(c.Queries())
	format := p["format"]
	delete(p, "format")
	if format != "" && format != "csv" && format != "json" {
		return response.Error(c, 400, "format must be csv or json", nil)
	}
	_, table, err := h.build(c.Context(), users.CurrentUser(c), c.Params("report"), p)
	if err != nil {
		return h.buildError(c, err)
	}
	return sendTable(c, table, format)
}

func sendTable(c fiber.Ctx, t Table, format string) error {
	if format != "csv" {
		return response.Success(c, 200, "", t)
	}
	var buf bytes.Buffer
	buf.Write([]byte{0xEF, 0xBB, 0xBF}) // a byte order mark lets Excel read the CSV as UTF-8
	if err := writeCSV(&buf, t); err != nil {
		slog.Error("CSV export failed", "error", err)
		return response.Error(c, 500, "the export could not be written", nil)
	}
	c.Set(fiber.HeaderContentType, "text/csv; charset=utf-8")
	c.Set(fiber.HeaderContentDisposition, `attachment; filename="clims-`+t.Report+`-`+
		t.DataUpdatedAt.In(Kampala).Format(time.DateOnly)+`.csv"`)
	return c.Send(buf.Bytes())
}

func (h *Handler) buildError(c fiber.Ctx, err error) error {
	var invalid errInvalid
	var internal errInternal
	if errors.As(err, &invalid) && !errors.As(err, &internal) {
		return response.Error(c, 400, err.Error(), nil)
	}
	slog.Error("report build failed", "error", err)
	return response.Error(c, 500, "the report could not be calculated", nil)
}
