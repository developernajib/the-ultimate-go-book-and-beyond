## Core Components

The following sections walk through each microservice in Go, covering the location tracker, driver scorer, trip state machine, surge pricing engine, payment processor, and ETA predictor.

### 1. Location Service

The Location Service receives GPS updates from every online driver every 4 seconds and stores them in Redis GEO for sub-5ms geospatial queries. When a rider requests a ride, this service finds all available drivers within a given radius in under 5 milliseconds. The TTL on driver status keys ensures that drivers who go offline (crash, lose connectivity) are automatically removed from the active pool.

```go
package location

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/uber/h3-go/v4"
)

// LocationService manages real-time driver locations
type LocationService struct {
	rdb *redis.ClusterClient
}

const (
	DriversGeoKey      = "drivers:geo"    // Redis GEO set
	DriverStatusPrefix = "driver:status:" // driver status hash
	DriverTTL          = 5 * time.Minute  // remove stale drivers
)

// DriverLocation is a driver's current location
type DriverLocation struct {
	DriverID  string    `json:"driver_id"`
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Heading   float32   `json:"heading"`
	Speed     float32   `json:"speed"`
	Status    string    `json:"status"` // "available", "on_trip", "offline"
	UpdatedAt time.Time `json:"updated_at"`
}

// UpdateLocation processes a driver's location update
func (s *LocationService) UpdateLocation(ctx context.Context, loc DriverLocation) error {
	pipe := s.rdb.Pipeline()

	// Redis GEO: stores geospatial index using sorted sets internally
	pipe.GeoAdd(ctx, DriversGeoKey, &redis.GeoLocation{
		Name:      loc.DriverID,
		Longitude: loc.Lng,
		Latitude:  loc.Lat,
	})

	// Store driver status and metadata
	statusKey := DriverStatusPrefix + loc.DriverID
	pipe.HSet(ctx, statusKey,
		"status", loc.Status,
		"lat", loc.Lat,
		"lng", loc.Lng,
		"heading", loc.Heading,
		"speed", loc.Speed,
		"updated_at", loc.UpdatedAt.Unix(),
	)
	pipe.Expire(ctx, statusKey, DriverTTL) // remove stale drivers

	_, err := pipe.Exec(ctx)
	return err
}

// FindNearbyDrivers finds available drivers within radius meters
func (s *LocationService) FindNearbyDrivers(ctx context.Context, lat, lng float64, radiusMeters float64, limit int) ([]NearbyDriver, error) {
	// GEOSEARCH replaces the deprecated GEORADIUS from Redis 6.2 onward.
	// GeoSearchLocation is the variant that returns coordinates and distances,
	// GeoSearch alone returns only member names.
	results, err := s.rdb.GeoSearchLocation(ctx, DriversGeoKey, &redis.GeoSearchLocationQuery{
		GeoSearchQuery: redis.GeoSearchQuery{
			Longitude:  lng,
			Latitude:   lat,
			// Distances come back in RadiusUnit, so asking in km keeps
			// GeoLocation.Dist in km and matches NearbyDriver.DistanceKm.
			Radius:     radiusMeters / 1000,
			RadiusUnit: "km",
			Sort:       "ASC",
			Count:      limit,
		},
		WithCoord: true,
		WithDist:  true,
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("geo search: %w", err)
	}

	// Batch fetch driver statuses
	pipe := s.rdb.Pipeline()
	statusCmds := make([]*redis.StringCmd, len(results))
	for i, r := range results {
		statusCmds[i] = pipe.HGet(ctx, DriverStatusPrefix+r.Name, "status")
	}
	// redis.Nil here just means some driver's status hash expired, which the
	// per-command check below handles. Any other error means the batch never
	// ran, and returning an empty slice would look like "no drivers nearby".
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, fmt.Errorf("batch driver status: %w", err)
	}

	var drivers []NearbyDriver
	for i, r := range results {
		status, err := statusCmds[i].Result()
		if err != nil || status != "available" {
			continue
		}

		drivers = append(drivers, NearbyDriver{
			DriverID:   r.Name,
			Lat:        r.Latitude,
			Lng:        r.Longitude,
			DistanceKm: r.Dist,
			EtaMinutes: r.Dist * 60 / 30, // assume 30km/h average urban speed
		})
	}
	return drivers, nil
}

type NearbyDriver struct {
	DriverID   string
	Lat        float64
	Lng        float64
	DistanceKm float64
	EtaMinutes float64
}

// H3 hexagonal grid for geofencing. H3 is Uber's own open-source geospatial
// index, and it divides the Earth into hexagonal cells at 16 resolutions.
// Resolution 9 cells average ~0.105 km² in AREA, with an edge roughly 200m
// long. That is a city block or two, the right granularity for surge pricing.
// Do not confuse the edge length with the area: they differ by a factor of
// hundreds, and reading one as the other misreads the whole grid.
type H3Cell string

func LatLngToH3(lat, lng float64, resolution int) (H3Cell, error) {
	cell, err := h3.LatLngToCell(h3.NewLatLng(lat, lng), resolution)
	if err != nil {
		return "", fmt.Errorf("h3 index lat=%f lng=%f res=%d: %w", lat, lng, resolution, err)
	}
	return H3Cell(cell.String()), nil
}
```

### 2. Driver Scoring & Matching

Simply assigning the nearest driver produces poor outcomes: the closest driver might have a low rating, a history of cancellations, or be about to end their shift. The matching algorithm instead ranks candidate drivers using a composite weighted score that balances three factors: estimated time of arrival (60% weight, because minimizing rider wait time is the primary objective), driver rating (20% weight, ensuring quality), and reliability (20% weight, combining acceptance rate and completion rate to penalize drivers who cherry-pick rides). The weights below are a starting point, not a universal answer. Real platforms tune them per market against measured offer-acceptance and cancellation rates, and the only defensible way to pick them is an online experiment.

```go
package matching

import (
	"context"
	"math"
	"sort"
)

// DriverScorer ranks candidate drivers for a given trip request
type DriverScorer struct {
	etaClient ETAClient // calls routing API (Google Maps / OSRM)
}

type ScoredDriver struct {
	DriverID   string
	Score      float64
	EtaMinutes float64
	DistanceKm float64
}

type DriverProfile struct {
	DriverID       string
	Rating         float64 // 1.0 to 5.0
	AcceptanceRate float64 // 0.0 to 1.0, penalizes drivers who cherry-pick
	CompletionRate float64 // 0.0 to 1.0, penalizes early cancellations
	TotalTrips     int
}

// ScoreDrivers ranks candidates using composite weighted score
//
// Score = w1 * ETAScore + w2 * RatingScore + w3 * ReliabilityScore
//
// Weights are a per-market tuning knob, shown here at a plausible starting point:
//
//	w1=0.6 (ETA dominates, fastest pickup usually wins)
//	w2=0.2 (quality matters but not at the expense of wait)
//	w3=0.2 (penalizes flaky drivers)
func (s *DriverScorer) ScoreDrivers(ctx context.Context, candidates []NearbyDriver, req TripRequest) []ScoredDriver {
	const (
		wETA         = 0.60
		wRating      = 0.20
		wReliability = 0.20
		maxEtaMin    = 15.0 // ETA > 15 min scores 0
	)

	// Fetch accurate ETAs from routing API in parallel
	etaResults := s.etaClient.BatchETA(ctx, candidates, req.PickupLat, req.PickupLng)
	if len(etaResults) != len(candidates) {
		return nil // a short result slice would silently misalign driver to ETA
	}

	// Fetch driver profiles (from cache)
	profiles := s.fetchProfiles(ctx, candidates)

	scored := make([]ScoredDriver, 0, len(candidates))
	for i, d := range candidates {
		etaMin := etaResults[i]

		// A cache miss must not become a zero-valued profile. Rating 0 would
		// score -0.25 on the line below and quietly bury a good driver.
		profile, ok := profiles[d.DriverID]
		if !ok {
			continue
		}

		// ETA score: linear decay, 0 at maxEtaMin
		etaScore := math.Max(0, 1.0-(etaMin/maxEtaMin))

		// Rating score: normalized 1-5 → 0-1, clamped against bad cache data
		ratingScore := math.Min(1.0, math.Max(0, (profile.Rating-1.0)/4.0))

		// Reliability: combined acceptance + completion
		reliabilityScore := (profile.AcceptanceRate + profile.CompletionRate) / 2.0

		total := wETA*etaScore + wRating*ratingScore + wReliability*reliabilityScore

		scored = append(scored, ScoredDriver{
			DriverID:   d.DriverID,
			Score:      total,
			EtaMinutes: etaMin,
			DistanceKm: d.DistanceKm,
		})
	}

	sort.Slice(scored, func(i, j int) bool {
		return scored[i].Score > scored[j].Score
	})
	return scored
}

func (s *DriverScorer) fetchProfiles(ctx context.Context, drivers []NearbyDriver) map[string]DriverProfile {
	// In practice: batch Redis GET or DB lookup
	profiles := make(map[string]DriverProfile, len(drivers))
	for _, d := range drivers {
		profiles[d.DriverID] = DriverProfile{
			DriverID:       d.DriverID,
			Rating:         4.8,  // from cache
			AcceptanceRate: 0.92,
			CompletionRate: 0.98,
			TotalTrips:     500,
		}
	}
	return profiles
}
```

### 3. Trip Matching Service

The Trip Matching Service is the orchestrator that ties everything together when a rider requests a ride. It queries the Location Service for nearby drivers, uses the Driver Scorer to rank them, fetches the current surge multiplier, calculates a price estimate, and creates the trip record. Notice the expanding search radius strategy, it starts with a 3km radius and widens to 7km and then 15km if no drivers are found, ensuring riders in less dense areas still get matched.

The subtle part is the assignment itself. A Redis lookup telling you a driver is "available" is a fact about the past, not a reservation. Two riders half a block apart can query at the same millisecond, see the same top-ranked driver, and both write a trip row naming them. Nothing in the read path prevents it, because the read path cannot. The only durable answer is to let the database refuse the second write: a unique index that permits at most one active trip per driver, which the database schema section defines as `uniq_driver_active_trip`. `Create` returns `ErrDriverUnavailable` when that index rejects the insert, and the loop below simply moves to the next-best candidate. The check is not "is this driver free" but "did my claim on this driver win", and only a write can answer that.

```go
package matching

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"
)

// ErrDriverUnavailable is returned by TripRepository.Create when the unique
// index on active trips rejects the insert, meaning another rider's claim on
// this driver committed first.
var ErrDriverUnavailable = errors.New("driver already assigned to an active trip")

// MatchingService orchestrates driver-rider matching
type MatchingService struct {
	locationSvc   *LocationService
	scorer        *DriverScorer
	pricingEngine *SurgePricingEngine
	tripRepo      TripRepository
}

// TripRequest is a rider's request for a trip
type TripRequest struct {
	RiderID     string
	PickupLat   float64
	PickupLng   float64
	DropoffLat  float64
	DropoffLng  float64
	RideType    string // "UberX", "UberBlack", "Pool"
	RequestedAt time.Time
}

// MatchResult is the result of matching
type MatchResult struct {
	TripID        string
	DriverID      string
	EtaMinutes    float64
	PriceEstimate PriceEstimate
}

// FindMatch finds the best available driver for a rider
func (s *MatchingService) FindMatch(ctx context.Context, req TripRequest) (*MatchResult, error) {
	// Expand search radius if needed
	var drivers []NearbyDriver
	var err error
	for _, radius := range []float64{3000, 7000, 15000} { // 3km, 7km, 15km
		drivers, err = s.locationSvc.FindNearbyDrivers(ctx, req.PickupLat, req.PickupLng, radius, 20)
		if err != nil {
			return nil, fmt.Errorf("find nearby drivers: %w", err)
		}
		if len(drivers) > 0 {
			break
		}
	}
	if len(drivers) == 0 {
		return nil, fmt.Errorf("no drivers available in area")
	}

	// Score and rank drivers
	scored := s.scorer.ScoreDrivers(ctx, drivers, req)
	if len(scored) == 0 {
		return nil, fmt.Errorf("no drivers available in area")
	}

	// Get surge multiplier for pickup location
	cell, err := LatLngToH3(req.PickupLat, req.PickupLng, 9)
	if err != nil {
		return nil, fmt.Errorf("index pickup: %w", err)
	}
	surge, err := s.pricingEngine.GetSurge(ctx, cell)
	if err != nil {
		return nil, fmt.Errorf("get surge: %w", err)
	}

	// Estimate price
	distanceKm := haversineDistance(req.PickupLat, req.PickupLng, req.DropoffLat, req.DropoffLng)
	price := calculatePrice(distanceKm, req.RideType, surge)

	// Walk the ranked list until one claim commits. The unique index on active
	// trips is what makes the assignment exclusive, so a driver lost to a
	// concurrent rider costs us one rejected insert, not a double booking.
	for _, cand := range scored {
		tripID := generateTripID()
		trip := Trip{
			ID:                  tripID,
			RiderID:             req.RiderID,
			DriverID:            cand.DriverID,
			Status:              TripStatusDriverAssigned,
			RideType:            req.RideType,
			SurgeMultiplier:     surge,
			EstimatedPriceCents: price.TotalCents,
			Currency:            price.Currency,
			RequestedAt:         req.RequestedAt,
			PickupLat:           req.PickupLat,
			PickupLng:           req.PickupLng,
			DropoffLat:          req.DropoffLat,
			DropoffLng:          req.DropoffLng,
		}

		err := s.tripRepo.Create(ctx, trip)
		if errors.Is(err, ErrDriverUnavailable) {
			continue // another rider claimed this driver first
		}
		if err != nil {
			return nil, fmt.Errorf("create trip: %w", err)
		}

		return &MatchResult{
			TripID:        tripID,
			DriverID:      cand.DriverID,
			EtaMinutes:    cand.EtaMinutes,
			PriceEstimate: price,
		}, nil
	}

	return nil, fmt.Errorf("no drivers available in area")
}

// Haversine formula for distance between two GPS coordinates
func haversineDistance(lat1, lng1, lat2, lng2 float64) float64 {
	const earthRadiusKm = 6371
	dLat := (lat2 - lat1) * math.Pi / 180
	dLng := (lng2 - lng1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLng/2)*math.Sin(dLng/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusKm * c
}

// PriceEstimate carries money as integer minor units (cents for USD). Fares are
// never float64: 2.00+1.10*distance in binary floating point drifts, and the
// drift is real money once you multiply it by ten million trips a day.
type PriceEstimate struct {
	BaseCents  int64   `json:"base_cents"`
	PerKmCents int64   `json:"per_km_cents"`
	DistanceKm float64 `json:"distance_km"`
	Surge      float64 `json:"surge"`
	TotalCents int64   `json:"total_cents"`
	Currency   string  `json:"currency"`
}

// fareRates maps a ride type to {base fare, per-km rate}, both in cents.
var fareRates = map[string][2]int64{
	"UberX":     {200, 110},
	"UberBlack": {700, 275},
	"Pool":      {150, 75},
}

func calculatePrice(distanceKm float64, rideType string, surge float64) PriceEstimate {
	rates, ok := fareRates[rideType]
	if !ok {
		rates = fareRates["UberX"]
	}
	// Distance and surge are genuinely fractional, so the arithmetic happens in
	// float and rounds to cents exactly once, at the end. Rounding intermediate
	// terms is what quietly creates or destroys value.
	totalCents := int64(math.Round((float64(rates[0]) + float64(rates[1])*distanceKm) * surge))
	return PriceEstimate{
		BaseCents:  rates[0],
		PerKmCents: rates[1],
		DistanceKm: distanceKm,
		Surge:      surge,
		TotalCents: totalCents,
		Currency:   "USD",
	}
}
```

### 4. Trip State Machine

Every ride follows a strict lifecycle: requested → driver_assigned → driver_arrived → on_trip → completed (or canceled at eligible stages). Enforcing valid transitions through a state machine prevents impossible states like jumping from "requested" directly to "completed" and ensures that business logic fires at exactly the right moment. All transitions are persisted to the database and published to Kafka, so downstream services like notifications, billing, analytics, and fraud detection can react independently without coupling to the trip service. Charging the rider is one of those consumers rather than a step inside the transition, which matters more than it looks: money that moves inside a request handler moves at the mercy of that request's timeouts and retries, while money that moves off a durable, replayable event can be retried on its own terms.

The transition table alone does not make the state machine safe. A table lookup only rejects transitions that are illegal from the state you happened to read a moment ago. Two concurrent requests can both read the same state and both pass validation, which is how a trip gets canceled and started at once. The table encodes the rules, and the conditional write below enforces them.

```go
package trip

import (
	"context"
	"fmt"
	"math"
	"time"
)

type TripStatus string

const (
	TripStatusRequested      TripStatus = "requested"
	TripStatusDriverAssigned TripStatus = "driver_assigned"
	TripStatusDriverArrived  TripStatus = "driver_arrived"
	TripStatusOnTrip         TripStatus = "on_trip"
	TripStatusCompleted      TripStatus = "completed"
	TripStatusCanceled       TripStatus = "canceled"
)

// validTransitions defines allowed state transitions
var validTransitions = map[TripStatus][]TripStatus{
	TripStatusRequested:      {TripStatusDriverAssigned, TripStatusCanceled},
	TripStatusDriverAssigned: {TripStatusDriverArrived, TripStatusCanceled},
	TripStatusDriverArrived:  {TripStatusOnTrip, TripStatusCanceled},
	TripStatusOnTrip:         {TripStatusCompleted},
	TripStatusCompleted:      {},
	TripStatusCanceled:       {},
}

type Trip struct {
	ID                  string
	RiderID             string
	DriverID            string
	Status              TripStatus
	RideType            string
	PickupLat           float64
	PickupLng           float64
	DropoffLat          float64
	DropoffLng          float64
	SurgeMultiplier     float64
	EstimatedPriceCents int64 // minor units, never float
	FinalPriceCents     int64
	Currency            string
	DistanceKm          float64
	DurationSeconds     int
	RequestedAt         time.Time
	StartedAt           *time.Time
	CompletedAt         *time.Time
}

type TripService struct {
	repo     TripRepository
	eventBus EventPublisher
}

// Transition moves a trip to a new state with validation.
//
// Reading the status and then writing it is not atomic. Two concurrent calls
// can both read "driver_arrived" and both conclude their transition is legal.
// UpdateStatus therefore carries the status we read and applies the write only
// if the row still holds it, returning ErrStaleTrip otherwise. The validation
// below catches programmer errors, the conditional write catches races, and
// only the second one is load-bearing under concurrency.
func (s *TripService) Transition(ctx context.Context, tripID string, newStatus TripStatus, meta map[string]any) error {
	trip, err := s.repo.Get(ctx, tripID)
	if err != nil {
		return fmt.Errorf("get trip: %w", err)
	}
	prev := trip.Status

	// Validate transition
	if !isValidTransition(prev, newStatus) {
		return fmt.Errorf("invalid transition: %s → %s", prev, newStatus)
	}

	// Apply state-specific logic
	now := time.Now()
	switch newStatus {
	case TripStatusOnTrip:
		trip.StartedAt = &now
	case TripStatusCompleted:
		// Only on_trip reaches here, so StartedAt should be set. Check anyway:
		// the alternative is a nil dereference on the line that computes
		// duration, taking down the service on one bad row.
		if trip.StartedAt == nil {
			return fmt.Errorf("trip %s is on_trip with no start time", tripID)
		}
		distKm, ok := meta["distance_km"].(float64)
		if !ok {
			return fmt.Errorf("missing or invalid distance_km in meta")
		}
		trip.CompletedAt = &now
		trip.DistanceKm = distKm
		trip.DurationSeconds = int(now.Sub(*trip.StartedAt).Seconds())
		trip.FinalPriceCents = calculateFinalPrice(trip)
	}

	trip.Status = newStatus
	if err := s.repo.UpdateStatus(ctx, trip, prev); err != nil {
		return fmt.Errorf("update trip: %w", err) // ErrStaleTrip if we lost the race
	}

	// Publish only after the write commits, and let the billing consumer charge
	// the rider off trip.completed. Charging from a `go` statement here would
	// hand the money path a context that dies with the request and an error
	// return that nobody reads.
	//
	// Publish can still fail after the commit, which loses the event. In
	// production the event is written to an outbox table inside the same
	// transaction as the trip row and a relay tails it into Kafka, so the state
	// change and its announcement cannot disagree.
	if err := s.eventBus.Publish(ctx, "trips", TripEvent{
		TripID:     tripID,
		Status:     newStatus,
		OccurredAt: now,
		Meta:       meta,
	}); err != nil {
		return fmt.Errorf("publish trip event: %w", err)
	}

	return nil
}

func isValidTransition(from, to TripStatus) bool {
	allowed := validTransitions[from]
	for _, s := range allowed {
		if s == to {
			return true
		}
	}
	return false
}

// calculateFinalPrice re-prices the trip on the distance actually driven, which
// is why it can differ from the estimate. It reads the same fareRates table the
// estimate used. Hardcoding one tier's rates here instead would bill an
// UberBlack rider at UberX rates and nothing would ever flag it.
func calculateFinalPrice(trip *Trip) int64 {
	rates, ok := fareRates[trip.RideType]
	if !ok {
		rates = fareRates["UberX"]
	}
	return int64(math.Round((float64(rates[0]) + float64(rates[1])*trip.DistanceKm) * trip.SurgeMultiplier))
}
```

### 5. Surge Pricing Engine

Surge pricing dynamically adjusts fares based on real-time supply and demand in each geographic area. The engine uses Redis counters to track how many ride requests (demand) and how many available drivers (supply) exist in each H3 hexagonal cell. When demand exceeds supply, the surge multiplier increases, which both raises prices for riders and attracts more drivers to the high-demand area. The 5-minute rolling window prevents sudden spikes from causing extreme price jumps.

Surge is the one component in this chapter where swallowing a Redis error is indefensible. The obvious implementation reads demand and supply, ignores the errors, and gets `0` for both. Zero supply reads as "no drivers anywhere", which is the exact input that produces maximum surge. A Redis timeout would therefore triple the price of every fare on the platform, and the code would look like it was working. The rule that falls out: an unreadable signal is not a signal, and the default when you cannot measure demand is 1.0x, not the cap. Note also that the two errors are not symmetric. Failing to 1.0x costs the platform some revenue during an outage, while failing to 3.0x overcharges every rider in the market, which is a refund campaign and a regulatory problem. When a fallback is not obviously safe, pick the direction whose worst case you can afford.

```go
package pricing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// SurgePricingEngine computes surge multipliers based on supply/demand.
// Uses H3 hexagonal grid cells at resolution 9, which average ~0.105 km² in
// area (edge length ~200m), about a city block or two.
type SurgePricingEngine struct {
	rdb *redis.Client
}

// NoSurge is the multiplier applied whenever the engine cannot establish that
// surge is warranted. Surge is opt-in on evidence, never a fallback.
const NoSurge = 1.0

// MaxSurge caps the multiplier so a thin or misreported cell cannot produce an
// unbounded fare.
const MaxSurge = 3.0

// RecordDemand increments demand counter for a cell within the current time window
func (e *SurgePricingEngine) RecordDemand(ctx context.Context, cell H3Cell) error {
	key := fmt.Sprintf("demand:%s:%d", cell, currentWindowMinute())
	pipe := e.rdb.Pipeline()
	pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, 10*time.Minute)
	_, err := pipe.Exec(ctx)
	return err
}

// UpdateSupply sets the active driver count in a cell (refreshed every 30 seconds)
func (e *SurgePricingEngine) UpdateSupply(ctx context.Context, cell H3Cell, driverCount int) error {
	key := fmt.Sprintf("supply:%s", cell)
	return e.rdb.Set(ctx, key, driverCount, 2*time.Minute).Err()
}

// GetSurge returns the current surge multiplier for a location.
//
// The ratio is "ride requests in the last 5 minutes per currently available
// driver", so the bands below are calibrated to that window. Changing the window
// without recalibrating the bands silently reprices the market.
func (e *SurgePricingEngine) GetSurge(ctx context.Context, cell H3Cell) (float64, error) {
	demand, err := e.getDemand(ctx, cell)
	if err != nil {
		return NoSurge, fmt.Errorf("read demand for %s: %w", cell, err)
	}
	supply, err := e.getSupply(ctx, cell)
	if err != nil {
		return NoSurge, fmt.Errorf("read supply for %s: %w", cell, err)
	}

	// No demand means an idle cell, not a busy one. Checking supply first would
	// charge the cap in every empty cell at 4am, where supply is legitimately 0.
	if demand == 0 {
		return NoSurge, nil
	}
	if supply == 0 {
		return MaxSurge, nil // real demand, no drivers to serve it
	}

	ratio := float64(demand) / float64(supply)

	// Step function maps demand/supply ratio to surge multiplier.
	// Smooth this with an exponential in production for better UX: riders notice
	// a fare jumping 1.2x to 1.5x on one extra request crossing a boundary.
	switch {
	case ratio < 0.5:
		return NoSurge, nil
	case ratio < 1.0:
		return 1.2, nil
	case ratio < 1.5:
		return 1.5, nil
	case ratio < 2.0:
		return 2.0, nil
	case ratio < 3.0:
		return 2.5, nil
	default:
		return MaxSurge, nil
	}
}

// getDemand sums demand counts across the last 5 minutes.
// A missing key is a genuine zero (no requests in that minute), but any other
// error must propagate: treating an unreachable Redis as "zero demand" is how a
// pricing engine starts inventing numbers.
func (e *SurgePricingEngine) getDemand(ctx context.Context, cell H3Cell) (int, error) {
	total := 0
	now := currentWindowMinute()
	for i := 0; i < 5; i++ {
		key := fmt.Sprintf("demand:%s:%d", cell, now-int64(i))
		n, err := e.rdb.Get(ctx, key).Int()
		if errors.Is(err, redis.Nil) {
			continue // no requests in this minute bucket
		}
		if err != nil {
			return 0, err
		}
		total += n
	}
	return total, nil
}

func (e *SurgePricingEngine) getSupply(ctx context.Context, cell H3Cell) (int, error) {
	key := fmt.Sprintf("supply:%s", cell)
	n, err := e.rdb.Get(ctx, key).Int()
	if errors.Is(err, redis.Nil) {
		return 0, nil // no supply report for this cell
	}
	if err != nil {
		return 0, err
	}
	return n, nil
}

func currentWindowMinute() int64 {
	return time.Now().Unix() / 60
}
```

### 6. Payment Integration

Payment processing in a ride-sharing platform must be reliable above all else, you cannot double-charge a rider or lose a driver's earnings. This service uses Stripe as the payment provider and implements idempotency by keying the charge on the trip ID. If a network failure causes a retry, Stripe recognizes the duplicate request and returns the original result instead of charging again.

Three details in this code are the difference between a payment system and a plausible-looking one.

First, money is `int64` cents, never `float64`. The tempting `int64(amount * 100)` conversion is not a rounding bug you can shrug at: `19.99` has no exact binary representation, the product lands just under `1999`, and truncation bills the rider 19.98. One cent per trip across ten million trips a day is a hundred thousand dollars a day walking out of the ledger, and no test that uses 20.00 will ever catch it.

Second, creating a PaymentIntent does not move money. A freshly created intent sits in `requires_payment_method` or `requires_confirmation`. Code that calls `paymentintent.New`, sees no error, and writes `status = succeeded` has recorded a payment that never happened. It fails in the worst possible direction, quietly, and only reconciliation weeks later notices the ledger disagrees with the bank. The intent must be confirmed, and the resulting `pi.Status` is the authority on what occurred, not the absence of an error.

Third, the idempotency key must be paired with identical parameters. Stripe returns a 400 when the same key arrives with a different amount, so a retry that re-prices the trip in between does not double-charge, it fails outright. The fix is to make the amount a property of the trip that the retry reads back rather than recomputes.

```go
package payment

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/paymentintent"
)

// PaymentService handles rider charging with idempotency
type PaymentService struct {
	paymentRepo PaymentRepository
	riders      RiderBillingLookup // resolves rider ID to Stripe customer + payment method
}

// ErrChargeIncomplete means Stripe accepted the intent but the money has not
// settled: the card needs 3DS, the bank is still deciding, or it was declined.
// The trip is not paid, and the caller must not pretend otherwise.
var ErrChargeIncomplete = errors.New("charge did not reach succeeded")

// ErrPaymentNotFound is returned by PaymentRepository.GetByTripID when no
// payment row exists for a trip. It has to be distinguishable from a database
// error: "not found" means charge the rider, while "connection refused" means
// we have no idea whether they have already been charged.
var ErrPaymentNotFound = errors.New("no payment for trip")

type PaymentStatus string

const (
	PaymentStatusPending   PaymentStatus = "pending"
	PaymentStatusSucceeded PaymentStatus = "succeeded"
	PaymentStatusFailed    PaymentStatus = "failed"
	PaymentStatusRefunded  PaymentStatus = "refunded"
)

type Payment struct {
	ID              string
	TripID          string
	RiderID         string
	DriverID        string
	AmountCents     int64 // minor units, the only representation money gets
	Currency        string
	Status          PaymentStatus
	StripePaymentID string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Charge processes payment for a completed trip.
//
// The idempotency key is the trip ID, so a retry after a network failure reuses
// Stripe's original result instead of charging twice. That guarantee holds only
// while the parameters match: the same key with a different amount is a 400 from
// Stripe, not a silent success. amountCents therefore has to come from the
// trip's stored final price, so a retry sends the identical figure.
func (s *PaymentService) Charge(ctx context.Context, riderID string, amountCents int64, tripID string) (*Payment, error) {
	// Idempotency starts locally: reuse the existing row rather than inserting a
	// second one for the same trip. Only a succeeded payment is terminal, a
	// pending row means an earlier attempt did not finish and we resume it with
	// the same payment ID and the same amount.
	payment, err := s.paymentRepo.GetByTripID(ctx, tripID)
	switch {
	case err == nil && payment.Status == PaymentStatusSucceeded:
		return payment, nil
	case err == nil:
		// Resume the in-flight attempt. Re-pricing it here would change the
		// parameters behind the idempotency key and earn a 400.
		amountCents = payment.AmountCents
	case errors.Is(err, ErrPaymentNotFound):
		payment = &Payment{
			ID:          generatePaymentID(),
			TripID:      tripID,
			RiderID:     riderID,
			AmountCents: amountCents,
			Currency:    "usd",
			Status:      PaymentStatusPending,
		}
		if err := s.paymentRepo.Create(ctx, payment); err != nil {
			return nil, fmt.Errorf("create payment record: %w", err)
		}
	default:
		return nil, fmt.Errorf("lookup payment for trip %s: %w", tripID, err)
	}

	billing, err := s.riders.Get(ctx, riderID)
	if err != nil {
		return nil, fmt.Errorf("rider billing profile: %w", err)
	}

	// Confirm:true makes this an actual charge. Without it the intent is created
	// and left waiting, and the money never moves.
	// OffSession:true tells Stripe the rider is not present to complete 3DS,
	// which is true: the trip ended and the app may be closed.
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String("usd"),
		Customer:      stripe.String(billing.StripeCustomerID),
		PaymentMethod: stripe.String(billing.StripePaymentMethodID),
		Confirm:       stripe.Bool(true),
		OffSession:    stripe.Bool(true),
		Params: stripe.Params{
			IdempotencyKey: stripe.String("trip-" + tripID),
		},
	}

	pi, err := paymentintent.New(params)
	if err != nil {
		payment.Status = PaymentStatusFailed
		if uErr := s.paymentRepo.Update(ctx, payment); uErr != nil {
			return nil, fmt.Errorf("stripe charge %w (and marking failed: %v)", err, uErr)
		}
		return nil, fmt.Errorf("stripe charge: %w", err)
	}

	payment.StripePaymentID = pi.ID

	// pi.Status is the authority. A created intent is not a paid trip: it can sit
	// in requires_action for 3DS or processing while the bank decides.
	if pi.Status != stripe.PaymentIntentStatusSucceeded {
		payment.Status = PaymentStatusPending
		if err := s.paymentRepo.Update(ctx, payment); err != nil {
			return nil, fmt.Errorf("update payment: %w", err)
		}
		// The Stripe webhook resolves this trip to succeeded or failed later.
		return payment, fmt.Errorf("%w: trip %s is %s", ErrChargeIncomplete, tripID, pi.Status)
	}

	payment.Status = PaymentStatusSucceeded
	if err := s.paymentRepo.Update(ctx, payment); err != nil {
		return nil, fmt.Errorf("update payment: %w", err)
	}

	return payment, nil
}

// ProcessDriverEarnings records and accumulates driver earnings, settled weekly.
//
// The take rate is a per-market business input, not a constant of nature. The
// value below is illustrative: real rates vary by city, product, and regulation.
//
// Note which side gets rounded. The platform's cut is computed and the driver
// receives the remainder, so the two always sum back to the fare exactly. Round
// both independently and a stray cent is either invented or destroyed on every
// trip, and the ledger stops balancing.
func (s *PaymentService) ProcessDriverEarnings(ctx context.Context, tripID, driverID string, fareCents int64) error {
	const platformBps = 2300 // 23% expressed in basis points, an exact integer

	platformCents := (fareCents*platformBps + 5000) / 10000 // round half up
	driverCents := fareCents - platformCents

	return s.paymentRepo.AddDriverEarnings(ctx, driverID, driverCents, tripID)
}
```

### 7. ETA Prediction Service

Accurate ETA (Estimated Time of Arrival) predictions are critical for rider experience, showing "3 minutes" when the actual wait is 10 minutes destroys trust. This service combines cached traffic data with live routing API calls to predict how long it will take a driver to reach the pickup point. For short distances under 2km, it uses a fast heuristic calculation to avoid expensive API calls. For longer distances, it calls an external routing API like Google Maps or OSRM to get accurate results that account for road networks and traffic conditions.

```go
package eta

import (
	"context"
	"fmt"
	"math"
	"time"
)

// ETAService predicts pickup and dropoff times using traffic patterns
type ETAService struct {
	trafficCache TrafficCache // pre-computed traffic matrices
	mapsClient   MapsClient   // Google Maps / OSRM
}

type ETARequest struct {
	OriginLat float64
	OriginLng float64
	DestLat   float64
	DestLng   float64
	RequestAt time.Time
}

type ETAResult struct {
	DurationSeconds int
	DistanceKm      float64
	Route           []Waypoint
	TrafficFactor   float64 // 1.0 = free flow, 2.0 = heavy traffic
}

type Waypoint struct {
	Lat float64
	Lng float64
}

// PredictETA estimates travel time with traffic awareness.
//
// The traffic multiplier applies to the heuristic path and only to the heuristic
// path. The routing API already prices live traffic into the duration it
// returns, so multiplying its answer by trafficFactor again counts the same
// congestion twice and quotes a 6 minute pickup as 12. Whenever two sources of a
// correction meet, exactly one of them is allowed to apply it.
func (s *ETAService) PredictETA(ctx context.Context, req ETARequest) (*ETAResult, error) {
	// Straight-line distance as lower bound
	distKm := haversineKm(req.OriginLat, req.OriginLng, req.DestLat, req.DestLng)

	// For longer routes: the routing API knows the road network and current
	// traffic. Return its answer untouched.
	if distKm >= 2.0 {
		return s.mapsClient.GetETA(ctx, req)
	}

	// For nearby pickups (<2km), a heuristic beats a 50ms API call. This
	// estimate knows nothing about traffic, so here the cached multiplier is
	// the only traffic signal and it earns its place.
	cell := latLngToZone(req.OriginLat, req.OriginLng)
	trafficFactor := s.trafficCache.GetTrafficMultiplier(cell, req.RequestAt.Hour())

	baseSeconds := distKm / 30 * 3600 // 30km/h urban
	return &ETAResult{
		DurationSeconds: int(baseSeconds * trafficFactor),
		DistanceKm:      distKm,
		TrafficFactor:   trafficFactor,
	}, nil
}

// BatchETA predicts ETAs for multiple drivers in parallel
func (s *ETAService) BatchETA(ctx context.Context, drivers []NearbyDriver, destLat, destLng float64) []float64 {
	results := make([]float64, len(drivers))

	ch := make(chan struct{ idx int; eta float64 }, len(drivers))
	for i, d := range drivers {
		go func(i int, d NearbyDriver) {
			result, err := s.PredictETA(ctx, ETARequest{
				OriginLat: d.Lat,
				OriginLng: d.Lng,
				DestLat:   destLat,
				DestLng:   destLng,
			})
			if err != nil {
				ch <- struct{ idx int; eta float64 }{i, d.EtaMinutes} // fallback
				return
			}
			ch <- struct{ idx int; eta float64 }{i, float64(result.DurationSeconds) / 60}
		}(i, d)
	}

	for range drivers {
		r := <-ch
		results[r.idx] = r.eta
	}
	return results
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

func latLngToZone(lat, lng float64) string {
	// Simplified zone key for traffic cache lookup
	return fmt.Sprintf("%.2f:%.2f", math.Round(lat*100)/100, math.Round(lng*100)/100)
}
```

---
