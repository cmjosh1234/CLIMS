package hotspots

import (
	"errors"
	"math"
	"strconv"
)

// MaxNearRadius caps radius_m, in metres. The near filter is for checking a hotspot's surroundings,
// such as duplicates while reviewing it, not for loading a region.
const MaxNearRadius = 5000

// metresPerDegree is the length of one degree of latitude, near enough for a bounding box.
const metresPerDegree = 111_320.0

var errNear = errors.New("near_lat, near_lng and radius_m go together: near_lat between -90 and 90, " +
	"near_lng between -180 and 180, radius_m above 0 and at most 5000")

// Near keeps the hotspots within Radius metres of a point.
type Near struct {
	Latitude, Longitude, Radius float64
}

// parseNear reads the near filter. All three values are absent, or all present and valid.
func parseNear(lat, lng, radius string) (*Near, error) {
	if lat == "" && lng == "" && radius == "" {
		return nil, nil
	}
	n := Near{}
	var errs [3]error
	n.Latitude, errs[0] = strconv.ParseFloat(lat, 64)
	n.Longitude, errs[1] = strconv.ParseFloat(lng, 64)
	n.Radius, errs[2] = strconv.ParseFloat(radius, 64)
	if errors.Join(errs[:]...) != nil || math.IsNaN(n.Latitude) || math.IsNaN(n.Longitude) || math.IsNaN(n.Radius) ||
		n.Latitude < -90 || n.Latitude > 90 || n.Longitude < -180 || n.Longitude > 180 ||
		n.Radius <= 0 || n.Radius > MaxNearRadius {
		return nil, errNear
	}
	return &n, nil
}

// box returns a latitude and longitude range that holds every point within the radius, so the
// database can narrow candidates by index before measuring the exact distance. Near the poles,
// where a degree of longitude shrinks to nothing, it spans every longitude.
func (n Near) box() (minLat, maxLat, minLng, maxLng float64) {
	dLat := n.Radius / metresPerDegree
	minLat, maxLat = n.Latitude-dLat, n.Latitude+dLat
	cos := math.Cos((math.Abs(n.Latitude) + dLat) * math.Pi / 180)
	if maxLat >= 90 || minLat <= -90 || cos <= 0.01 {
		return minLat, maxLat, -180, 180
	}
	dLng := n.Radius / (metresPerDegree * cos)
	return minLat, maxLat, n.Longitude - dLng, n.Longitude + dLng
}

// args are the near filter's query parameters: point, radius and bounding box, or all NULL.
func (n *Near) args() []any {
	if n == nil {
		return []any{nil, nil, nil, nil, nil, nil, nil}
	}
	minLat, maxLat, minLng, maxLng := n.box()
	return []any{n.Latitude, n.Longitude, n.Radius, minLat, maxLat, minLng, maxLng}
}
