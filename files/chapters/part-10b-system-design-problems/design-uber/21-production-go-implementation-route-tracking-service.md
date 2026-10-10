## Production Go Implementation: Route Tracking Service

The Route Tracking Service records the actual GPS path a driver takes during a trip. This trace data serves multiple purposes: calculating the actual fare (which may differ from the estimate if the driver took a different route), detecting fraud (a driver intentionally taking a longer route), and improving ETA models with real-world data. The service filters out GPS glitches by checking for physically impossible speeds (over 200 km/h) and low-accuracy readings (over 50 meters uncertainty).

The distance loop repays a careful read, because the obvious way to skip a glitch is subtly wrong and the error lands directly on the fare. Walking the trace pairwise and `continue`-ing past an impossible segment throws away two segments, not one: the jump out to the bad fix and the jump back from it. The driver really did travel that ground, and the trace no longer says so. A single spurious fix in a five-point trace undercounts by half. The fix is to treat the glitch as a bad *point* rather than a bad *segment*: hold the last known-good fix as the anchor and measure from it to the next fix that passes, so the distance across the glitch is still counted once.

```go
package tracking

import (
	"context"
	"fmt"
	"math"
	"time"
)

// RouteTracker records the actual GPS trace during a trip
// Used for: fare calculation, ETA refinement, fraud detection, driver quality
type RouteTracker struct {
	traceDB TraceStore
	tripDB  TripStore
}

type GPSPoint struct {
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Speed     float32   `json:"speed"`     // km/h
	Heading   float32   `json:"heading"`   // degrees
	Accuracy  float32   `json:"accuracy"`  // meters
	Timestamp time.Time `json:"timestamp"`
}

type TripTrace struct {
	TripID     string     `json:"trip_id"`
	DriverID   string     `json:"driver_id"`
	Points     []GPSPoint `json:"points"`
	DistanceKm float64    `json:"distance_km"`
	DurationS  int        `json:"duration_seconds"`
}

// RecordPoint adds a GPS point to the trip trace
func (t *RouteTracker) RecordPoint(ctx context.Context, tripID string, point GPSPoint) error {
	// Filter out low-accuracy GPS readings
	if point.Accuracy > 50 {
		return nil // skip inaccurate points
	}

	return t.traceDB.AppendPoint(ctx, tripID, point)
}

// CalculateTripDistance computes actual distance from GPS trace
// Uses Haversine formula between consecutive points
func (t *RouteTracker) CalculateTripDistance(ctx context.Context, tripID string) (float64, error) {
	trace, err := t.traceDB.GetTrace(ctx, tripID)
	if err != nil {
		return 0, fmt.Errorf("get trace: %w", err)
	}

	// anchor is the index of the last fix we believed. A glitched point is
	// skipped without moving the anchor, so the distance the driver actually
	// covered while the GPS was lying still gets measured once, from the last
	// good fix to the next good one.
	totalKm := 0.0
	anchor := -1
	for i := range trace.Points {
		if anchor < 0 {
			anchor = i
			continue
		}
		p1, p2 := trace.Points[anchor], trace.Points[i]

		timeDiff := p2.Timestamp.Sub(p1.Timestamp).Seconds()
		if timeDiff <= 0 {
			continue // duplicate or out-of-order fix, and a guard against /0
		}

		dist := haversineKm(p1.Lat, p1.Lng, p2.Lat, p2.Lng)
		if dist/(timeDiff/3600) > 200 {
			continue // impossible speed: reject the point, keep the anchor
		}

		totalKm += dist
		anchor = i
	}

	return totalKm, nil
}

// DetectRouteDeviation compares actual route to expected route.
// Used for fraud detection (driver taking a longer route for a higher fare).
//
// This returns an error rather than a bool, because the two failure directions
// are not equal. Swallowing the error and returning "not suspicious" means an
// unreadable trace reads as an honest trip, so the one case where the data is
// missing is the one case fraud is never flagged.
func (t *RouteTracker) DetectRouteDeviation(ctx context.Context, tripID string, expectedKm float64) (deviationPct float64, suspicious bool, err error) {
	if expectedKm <= 0 {
		// Dividing by this would yield ±Inf or NaN. NaN > 30 is false, so a
		// zero-length expectation would silently mark every trip clean.
		return 0, false, fmt.Errorf("trip %s: expected distance must be positive, got %f", tripID, expectedKm)
	}

	actualKm, err := t.CalculateTripDistance(ctx, tripID)
	if err != nil {
		return 0, false, fmt.Errorf("trip %s: %w", tripID, err)
	}

	deviationPct = (actualKm - expectedKm) / expectedKm * 100
	return deviationPct, deviationPct > 30, nil
}

func haversineKm(lat1, lng1, lat2, lng2 float64) float64 {
	const R = 6371.0
	dLat := (lat2 - lat1) * math.Pi / 180
	dLng := (lng2 - lng1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLng/2)*math.Sin(dLng/2)
	return R * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}
```

---
