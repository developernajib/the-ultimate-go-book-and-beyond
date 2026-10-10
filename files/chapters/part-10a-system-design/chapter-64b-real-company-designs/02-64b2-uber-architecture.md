## 64B.2 Uber Architecture

Uber's architecture processes millions of real-time ride requests daily, with a hard latency ceiling of a few hundred milliseconds from request to driver notification. The system must continuously track driver locations, match riders to the nearest available driver, calculate dynamic pricing, and route notifications, all while handling geographic hotspots during rush hours and large events. Uber's dispatch system (internally known as DISCO, the Dispatch Optimization service) and its distributed geospatial primitives are documented in Uber Engineering publications (*Engineering the Architecture Behind Uber's Dispatch Service*, Uber Engineering Blog, 2015; and *H3: Uber's Hexagonal Hierarchical Spatial Index*, Uber Engineering Blog, 2018). Uber originally leveraged Google's S2 spherical geometry cell hierarchy before transitioning to hexagonal H3 cells.

### Geospatial Matching System

Uber's dispatch relies on a spatial index that partitions the Earth's surface into discrete cells using Google's S2 geometry library. Each cell holds references to the drivers currently inside it. When a ride request arrives, the system identifies the cells covering the pickup radius and searches only those cells, avoiding a full scan of all active drivers. The implementation below demonstrates this cell-based indexing pattern with a simplified grid. In production, S2 cells at level 12 (roughly 3-6 km²) provide the right granularity for urban areas.

```go
// uber/geofence.go
package uber

import (
    "fmt"
    "math"
    "sort"
    "sync"
    "time"
)

// Location represents a geographic location
type Location struct {
    Lat float64
    Lng float64
}

// Driver represents an available driver
type Driver struct {
    ID        string
    Location  Location
    Status    DriverStatus
    VehicleType string
    Rating    float64
    UpdatedAt time.Time
}

type DriverStatus int

const (
    StatusOffline DriverStatus = iota
    StatusAvailable
    StatusOnTrip
)

// GeoIndex provides efficient geospatial queries using S2 cells
type GeoIndex struct {
    mu       sync.RWMutex
    cells    map[string]map[string]*Driver // S2 cell ID -> driver ID -> driver
    drivers  map[string]*Driver            // driver ID -> driver
    cellLevel int
}

// NewGeoIndex creates a new geospatial index
func NewGeoIndex(cellLevel int) *GeoIndex {
    return &GeoIndex{
        cells:     make(map[string]map[string]*Driver),
        drivers:   make(map[string]*Driver),
        cellLevel: cellLevel,
    }
}

// Update updates a driver's location
func (g *GeoIndex) Update(driver *Driver) {
    g.mu.Lock()
    defer g.mu.Unlock()

    // Remove from old cell if exists
    if existing, ok := g.drivers[driver.ID]; ok {
        oldCellID := g.getCellID(existing.Location)
        if cell, ok := g.cells[oldCellID]; ok {
            delete(cell, driver.ID)
        }
    }

    // Add to new cell
    cellID := g.getCellID(driver.Location)
    if g.cells[cellID] == nil {
        g.cells[cellID] = make(map[string]*Driver)
    }
    g.cells[cellID][driver.ID] = driver
    g.drivers[driver.ID] = driver
}

// FindNearby finds drivers near a location
func (g *GeoIndex) FindNearby(loc Location, radiusKm float64, limit int) []*Driver {
    g.mu.RLock()
    defer g.mu.RUnlock()

    // Get covering cells
    coveringCells := g.getCoveringCells(loc, radiusKm)

    candidates := make([]*Driver, 0)
    for _, cellID := range coveringCells {
        if cell, ok := g.cells[cellID]; ok {
            for _, driver := range cell {
                if driver.Status == StatusAvailable {
                    dist := haversineDistance(loc, driver.Location)
                    if dist <= radiusKm {
                        candidates = append(candidates, driver)
                    }
                }
            }
        }
    }

    // Sort by distance and return top N
    sortByDistance(candidates, loc)
    if len(candidates) > limit {
        candidates = candidates[:limit]
    }

    return candidates
}

func sortByDistance(drivers []*Driver, target Location) {
    sort.Slice(drivers, func(i, j int) bool {
        return haversineDistance(target, drivers[i].Location) < haversineDistance(target, drivers[j].Location)
    })
}

// getCellID returns the S2 cell ID for a location
func (g *GeoIndex) getCellID(loc Location) string {
    // Simplified: In production, use the S2 library
    lat := int(loc.Lat * 1000)
    lng := int(loc.Lng * 1000)
    return fmt.Sprintf("%d_%d", lat, lng)
}

// getCoveringCells returns cells that cover a circular region
func (g *GeoIndex) getCoveringCells(center Location, radiusKm float64) []string {
    // Simplified: In production, use S2 covering
    cells := make([]string, 0)

    // Get 9 surrounding cells
    for dlat := -1; dlat <= 1; dlat++ {
        for dlng := -1; dlng <= 1; dlng++ {
            lat := int(center.Lat*1000) + dlat
            lng := int(center.Lng*1000) + dlng
            cells = append(cells, fmt.Sprintf("%d_%d", lat, lng))
        }
    }

    return cells
}

// haversineDistance calculates distance between two points in km
func haversineDistance(p1, p2 Location) float64 {
    const R = 6371 // Earth's radius in km

    lat1 := p1.Lat * math.Pi / 180
    lat2 := p2.Lat * math.Pi / 180
    dLat := (p2.Lat - p1.Lat) * math.Pi / 180
    dLon := (p2.Lng - p1.Lng) * math.Pi / 180

    a := math.Sin(dLat/2)*math.Sin(dLat/2) +
        math.Cos(lat1)*math.Cos(lat2)*
            math.Sin(dLon/2)*math.Sin(dLon/2)
    c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))

    return R * c
}
```

### Dispatch System

The dispatcher sits at the intersection of geospatial data and business logic: it takes the candidate set from the geo-index and must select the single best driver to notify within a few hundred milliseconds. A weighted scoring model, combining proximity, driver rating, and historical acceptance rate, lets the system balance rider wait time against driver quality. The notification is sent in a goroutine so the API response returns immediately. The driver either accepts or the system re-dispatches to the next candidate if no response arrives within the offer timeout.

```go
// uber/dispatch.go
package uber

import (
    "context"
    "errors"
    "sort"
    "time"
)

// ErrNoDriversAvailable indicates no drivers were found within pickup radius
var ErrNoDriversAvailable = errors.New("no drivers available")

// NotificationService sends ride match notifications to drivers
type NotificationService interface {
    NotifyDriver(ctx context.Context, driverID string, match *Match)
}

// RideRequest represents a ride request
type RideRequest struct {
    ID          string
    Rider       string
    Pickup      Location
    Dropoff     Location
    VehicleType string
    CreatedAt   time.Time
}

// Match represents a driver-rider match
type Match struct {
    RequestID   string
    DriverID    string
    ETA         time.Duration
    PriceCents  int64
    Distance    float64
}

// Dispatcher handles ride matching
type Dispatcher struct {
    geoIndex     *GeoIndex
    matcher      *Matcher
    priceEngine  *PriceEngine
    notifications NotificationService
}

// NewDispatcher creates a new dispatcher
func NewDispatcher(geoIndex *GeoIndex, notifications NotificationService) *Dispatcher {
    return &Dispatcher{
        geoIndex:      geoIndex,
        matcher:       NewMatcher(),
        priceEngine:   NewPriceEngine(),
        notifications: notifications,
    }
}

// Dispatch finds the best driver for a ride request
func (d *Dispatcher) Dispatch(ctx context.Context, request *RideRequest) (*Match, error) {
    // Find nearby drivers
    drivers := d.geoIndex.FindNearby(request.Pickup, 5.0, 10) // 5km radius, top 10

    if len(drivers) == 0 {
        return nil, ErrNoDriversAvailable
    }

    // Score each driver
    candidates := make([]ScoredDriver, len(drivers))
    for i, driver := range drivers {
        score := d.matcher.Score(request, driver)
        candidates[i] = ScoredDriver{Driver: driver, Score: score}
    }

    // Sort by score (descending)
    sort.Slice(candidates, func(i, j int) bool {
        return candidates[i].Score > candidates[j].Score
    })

    // Calculate price
    price := d.priceEngine.Calculate(request)

    // Create match with best driver
    bestDriver := candidates[0].Driver
    eta := d.calculateETA(bestDriver.Location, request.Pickup)

    match := &Match{
        RequestID:  request.ID,
        DriverID:   bestDriver.ID,
        ETA:        eta,
        PriceCents: price,
        Distance:   haversineDistance(request.Pickup, request.Dropoff),
    }

    // Send notification to driver
    go d.notifications.NotifyDriver(ctx, bestDriver.ID, match)

    return match, nil
}

type ScoredDriver struct {
    Driver *Driver
    Score  float64
}

// Matcher scores driver-request matches
type Matcher struct {
    distanceWeight float64
    ratingWeight   float64
    acceptanceWeight float64
}

func NewMatcher() *Matcher {
    return &Matcher{
        distanceWeight:   0.4,
        ratingWeight:     0.3,
        acceptanceWeight: 0.3,
    }
}

// Score calculates match score (0-1)
func (m *Matcher) Score(request *RideRequest, driver *Driver) float64 {
    // Distance score (closer is better)
    dist := haversineDistance(request.Pickup, driver.Location)
    distScore := math.Max(0, 1-dist/5.0) // 5km max

    // Rating score
    ratingScore := driver.Rating / 5.0

    // Acceptance rate score (would be from driver history)
    acceptanceScore := 0.8 // Placeholder

    return m.distanceWeight*distScore +
           m.ratingWeight*ratingScore +
           m.acceptanceWeight*acceptanceScore
}

func (d *Dispatcher) calculateETA(from, to Location) time.Duration {
    dist := haversineDistance(from, to)
    // Assume average speed of 30 km/h in city
    hours := dist / 30.0
    return time.Duration(hours * float64(time.Hour))
}

// PriceEngine calculates ride prices
type PriceEngine struct {
    baseFareCents   int64
    perKmCents      int64
    perMinuteCents  int64
    surgeMultiplier float64
}

func NewPriceEngine() *PriceEngine {
    return &PriceEngine{
        baseFareCents:  250,
        perKmCents:     150,
        perMinuteCents: 30,
        surgeMultiplier: 1.0,
    }
}

// Calculate calculates the ride price in cents. Distance and time stay
// float64 (they are measurements), and the money math rounds once at the
// end rather than accumulating float error in the price itself.
func (p *PriceEngine) Calculate(request *RideRequest) int64 {
    distance := haversineDistance(request.Pickup, request.Dropoff)
    estimatedMinutes := distance / 30.0 * 60 // 30 km/h average

    raw := float64(p.baseFareCents) +
        (distance * float64(p.perKmCents)) +
        (estimatedMinutes * float64(p.perMinuteCents))

    return int64(math.Round(raw * p.surgeMultiplier))
}

// SetSurge sets the surge multiplier
func (p *PriceEngine) SetSurge(multiplier float64) {
    p.surgeMultiplier = multiplier
}
```

---

### Junior -> FAANG: Geospatial Indexing as a Partitioning Problem

The S2 cell index is a spatial partitioning scheme. Understanding it requires stepping back to the general principle: the Earth's surface is partitioned into discrete cells, and each cell is an independent lookup unit. When a rider requests a pickup, you only query the cells covering the pickup radius, not the entire driver population. This is the spatial equivalent of using a database index: instead of scanning all 100,000 active drivers, you scan the 50 drivers in the relevant cells.

The `getCellID` function in the simplified implementation converts a latitude-longitude pair to a string key. In production, S2's `CellID` at level 12 corresponds to cells of approximately 3-6 km², which is the right granularity for urban ride-hailing: small enough that most cells contain fewer than 100 drivers (making the scan fast), large enough that a pickup location rarely falls exactly on a cell boundary (minimizing the "missed driver in adjacent cell" problem).

The dispatcher's two-step process (geo-index to get candidates, scorer to rank them) is a pattern that appears in many large-scale recommendation and matching systems. The geo-index is a filter: it narrows the candidate set from 100,000 to 50. The scorer is a ranker: it selects the best match from the 50 candidates. Keep filters computationally cheap (lookup by cell, filter by status) and put the expensive logic in the ranker.

### Senior @ FAANG: The Production Concerns Hidden in the Simplified Implementation

The `GeoIndex.Update` method holds a write lock for the duration of the driver location update. At Uber's scale, driver location updates arrive at approximately one update per active driver per 5 seconds. With 1 million active drivers, that is 200,000 updates per second, all serialized through a single mutex. The production solution is to shard the geo-index by cell: each shard handles a geographic region and has its own lock, so updates to drivers in different regions proceed in parallel.

The `FindNearby` function queries 9 fixed cells (the target cell plus 8 surrounding cells). This works for a uniform grid but fails for S2's hierarchical cell structure, where cells at different levels have different sizes. A proper S2-based implementation uses `CellID.AllNeighbors(level)` to get the topologically correct set of neighboring cells, then filters by haversine distance to exclude drivers at the edge of neighboring cells who are actually outside the search radius. The simplified grid-based approach over-includes (returns drivers in a square bounding box rather than a circle) and under-includes (misses drivers near cell boundaries at the edge of the radius).

The dispatch system sends a driver notification in a goroutine and returns the match immediately. This means the rider receives a "match confirmed" response before the driver has accepted. If the driver declines or does not respond within the offer timeout, the system must re-dispatch to the next-best candidate. The production dispatch loop tracks the offer state per request and retries until acceptance, timeout, or no more candidates. The simplified implementation has no offer tracking, which means a declined offer results in an unmatched ride request with no retry path.

The `PriceEngine` uses a static `surgeMultiplier` that must be set externally. The production surge calculation is a continuous feedback loop: supply (available drivers in a zone) and demand (unfulfilled ride requests in a zone) are measured every 30 seconds, and the multiplier is adjusted proportionally. This requires a separate demand-forecasting service that aggregates historical patterns (rush hour, weather, events) with real-time supply-demand signals to produce a zone-level multiplier that is updated continuously and capped at a configurable maximum.