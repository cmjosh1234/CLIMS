package hotspots

import (
	"math"
	"testing"
)

func TestParseNear(t *testing.T) {
	tests := []struct {
		name             string
		lat, lng, radius string
		want             *Near
		wantErr          bool
	}{
		{"absent", "", "", "", nil, false},
		{"valid", "0.431902", "33.1970468", "1000", &Near{0.431902, 33.1970468, 1000}, false},
		{"largest radius", "0", "0", "5000", &Near{0, 0, 5000}, false},
		{"missing radius", "0.43", "33.19", "", nil, true},
		{"missing point", "", "", "1000", nil, true},
		{"radius too large", "0.43", "33.19", "5001", nil, true},
		{"zero radius", "0.43", "33.19", "0", nil, true},
		{"latitude out of range", "91", "33.19", "100", nil, true},
		{"longitude out of range", "0.43", "-181", "100", nil, true},
		{"not a number", "north", "33.19", "100", nil, true},
		{"NaN", "NaN", "33.19", "100", nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseNear(tt.lat, tt.lng, tt.radius)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if (got == nil) != (tt.want == nil) || got != nil && *got != *tt.want {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

// haversine mirrors nearDistance, so the box can be checked against the distance the query uses.
func haversine(lat1, lng1, lat2, lng2 float64) float64 {
	rad := math.Pi / 180
	a := math.Pow(math.Sin((lat2-lat1)*rad/2), 2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Pow(math.Sin((lng2-lng1)*rad/2), 2)
	return 2 * 6371008.8 * math.Asin(math.Sqrt(math.Min(1, a)))
}

func TestNearBoxHoldsTheRadius(t *testing.T) {
	for _, n := range []Near{{0.4319, 33.197, 1000}, {3.5, 30.9, 5000}, {-1.2, 29.6, 100}, {60, 10, 5000}} {
		minLat, maxLat, minLng, maxLng := n.box()
		// Walk the circle: every point at the radius lies inside the box.
		for deg := 0.0; deg < 360; deg += 5 {
			b := deg * math.Pi / 180
			lat := n.Latitude + n.Radius*math.Cos(b)/metresPerDegree
			lng := n.Longitude + n.Radius*math.Sin(b)/(metresPerDegree*math.Cos(lat*math.Pi/180))
			if d := haversine(n.Latitude, n.Longitude, lat, lng); d > n.Radius*0.99 &&
				(lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) {
				t.Fatalf("%v: point %v,%v at %.0f m falls outside box %v..%v, %v..%v", n, lat, lng, d, minLat, maxLat, minLng, maxLng)
			}
		}
	}
}

func TestNearBoxNearThePole(t *testing.T) {
	_, _, minLng, maxLng := Near{89.99, 10, 5000}.box()
	if minLng != -180 || maxLng != 180 {
		t.Fatalf("box near the pole spans %v..%v, want every longitude", minLng, maxLng)
	}
}

func TestNearArgs(t *testing.T) {
	var none *Near
	for i, arg := range none.args() {
		if arg != nil {
			t.Fatalf("arg %d = %v without the near filter, want NULL", i, arg)
		}
	}
	if got := (&Near{0.43, 33.19, 1000}).args(); len(got) != 7 || got[0] != 0.43 || got[2] != 1000.0 {
		t.Fatalf("args = %v", got)
	}
}

func TestHaversineMatchesKnownDistance(t *testing.T) {
	// 0.0024 degrees of latitude is about 267 m.
	if d := haversine(0.3476, 32.5825, 0.35, 32.5825); math.Abs(d-266.9) > 1 {
		t.Fatalf("distance = %.1f m, want about 266.9", d)
	}
}
