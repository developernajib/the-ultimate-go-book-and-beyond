## 83B.12 Uber Deep Dive

### Overview for Go Engineers

Uber is one of the largest Go shops in the world. Go powers Uber's microservices platform (GUPS), dispatch systems, real-time location tracking, surge pricing engine, and much of their data pipeline infrastructure. With over 4,000 microservices, Uber's engineering challenges are quintabout real-time systems at scale: matching riders and drivers in milliseconds, processing GPS pings from millions of moving vehicles, computing surge pricing dynamically, and routing through complex city graphs. Go engineers at Uber work on geospatial systems (H3 hexagonal grid), distributed streaming (Apache Kafka + Flink), and high-throughput APIs. The interview process emphasizes system design and real-time distributed systems more than pure algorithms. Uber values engineers who can reason about latency, throughput, and the operational complexity of globally distributed systems. Their engineering blog is required reading - it reveals the actual problems they solve.

### Interview Process

Uber's loop emphasizes systems thinking and real-world scale problems over puzzle algorithms:

```
┌──────────────────────────────────────────────────────────────────┐
│                    UBER INTERVIEW PIPELINE                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │  - Experience, motivation, role fit                      │
│       ▼                                                          │
│  Hiring Manager Screen (45 min)                                  │
│       │  - Technical discussion + career goals                   │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - 1-2 coding problems (medium difficulty)               │
│       ▼                                                          │
│  Virtual Onsite (4-5 rounds, 60 min each)                        │
│       │  - 2 Coding rounds                                       │
│       │  - 1 System Design round                                 │
│       │  - 1 Architecture/Distributed Systems round              │
│       │  - 1 Leadership/Behavioral round                         │
│       ▼                                                          │
│  Debrief & Decision                                              │
│  Timeline: 3-5 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Uber's onsite includes a dedicated Architecture round separate from System Design. System Design focuses on a specific feature (design surge pricing), while Architecture focuses on distributed systems patterns (how would you build Uber's service mesh? how does the dispatch system handle partial failures?). This split means you need both product-level and infrastructure-level system design preparation.

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| IC3 | Software Engineer II | 0-3 | $150K-$185K | $220K-$320K | Coding + basic system design |
| IC4 | Senior Engineer I | 3-6 | $190K-$230K | $320K-$480K | Full system design + distributed systems |
| IC5 | Senior Engineer II | 6-10 | $230K-$280K | $480K-$650K | Architecture + cross-team leadership |
| IC6 | Staff Engineer | 10-14 | $270K-$340K | $650K-$900K | Org-level technical strategy |
| IC7 | Senior Staff | 14+ | $320K-$400K | $850K-$1.2M+ | CTO-adjacent technical vision |

### Representative Interview Problems

#### Problem 1: Driver-Rider Matching by Proximity (Easy)

*Find the nearest available drivers to a rider using a simple geospatial index.*

```go
package main

import (
	"fmt"
	"math"
	"slices"
)

type Location struct {
	Lat, Lng float64
}

type Driver struct {
	ID       string
	Location Location
	Available bool
}

// haversineKm returns approximate distance in km between two lat/lng points.
func haversineKm(a, b Location) float64 {
	const R = 6371.0
	dLat := (b.Lat - a.Lat) * math.Pi / 180
	dLng := (b.Lng - a.Lng) * math.Pi / 180
	sinLat := math.Sin(dLat / 2)
	sinLng := math.Sin(dLng / 2)
	h := sinLat*sinLat + math.Cos(a.Lat*math.Pi/180)*math.Cos(b.Lat*math.Pi/180)*sinLng*sinLng
	return R * 2 * math.Atan2(math.Sqrt(h), math.Sqrt(1-h))
}

type DriverWithDist struct {
	Driver   Driver
	DistKm   float64
}

// NearestDrivers returns up to k nearest available drivers sorted by distance.
func NearestDrivers(rider Location, drivers []Driver, k int) []DriverWithDist {
	var candidates []DriverWithDist
	for _, d := range drivers {
		if !d.Available {
			continue
		}
		candidates = append(candidates, DriverWithDist{d, haversineKm(rider, d.Location)})
	}
	slices.SortFunc(candidates, func(a, b DriverWithDist) int {
		if a.DistKm < b.DistKm {
			return -1
		} else if a.DistKm > b.DistKm {
			return 1
		}
		return 0
	})
	return candidates[:min(k, len(candidates))]
}

func main() {
	rider := Location{Lat: 37.7749, Lng: -122.4194} // SF

	drivers := []Driver{
		{ID: "d1", Location: Location{37.7751, -122.4180}, Available: true},
		{ID: "d2", Location: Location{37.7800, -122.4100}, Available: true},
		{ID: "d3", Location: Location{37.7600, -122.4300}, Available: false},
		{ID: "d4", Location: Location{37.7900, -122.3900}, Available: true},
	}

	nearest := NearestDrivers(rider, drivers, 2)
	for i, d := range nearest {
		fmt.Printf("#%d: driver %s - %.3f km away\n", i+1, d.Driver.ID, d.DistKm)
	}
}
```

#### Problem 2: Surge Pricing Calculator (Easy)

*Compute surge multiplier based on supply/demand ratio using Uber's tiered pricing model.*

```go
package main

import "fmt"

type SurgeInput struct {
	ActiveRiders  int
	ActiveDrivers int
	Region        string
}

// SurgeMultiplier returns the surge price multiplier (1.0 = no surge).
// Uber uses demand/supply ratio with defined tiers.
func SurgeMultiplier(in SurgeInput) float64 {
	if in.ActiveDrivers == 0 {
		return 3.0 // maximum surge
	}
	ratio := float64(in.ActiveRiders) / float64(in.ActiveDrivers)

	switch {
	case ratio <= 0.7:
		return 1.0 // no surge
	case ratio <= 1.0:
		return 1.2
	case ratio <= 1.3:
		return 1.5
	case ratio <= 1.6:
		return 1.8
	case ratio <= 2.0:
		return 2.2
	default:
		return 3.0
	}
}

type RidePricing struct {
	BasePrice float64
	SurgeMultiplier float64
	TotalPrice float64
}

func PriceRide(baseCents int64, surge float64) RidePricing {
	total := float64(baseCents) * surge
	return RidePricing{
		BasePrice:       float64(baseCents) / 100,
		SurgeMultiplier: surge,
		TotalPrice:      total / 100,
	}
}

func main() {
	scenarios := []SurgeInput{
		{ActiveRiders: 50, ActiveDrivers: 100, Region: "SF-Downtown"},
		{ActiveRiders: 100, ActiveDrivers: 100, Region: "SF-Downtown"},
		{ActiveRiders: 200, ActiveDrivers: 100, Region: "SF-Downtown"},
		{ActiveRiders: 350, ActiveDrivers: 100, Region: "SF-Downtown"},
	}

	baseCents := int64(1200) // $12.00 base fare

	for _, s := range scenarios {
		mult := SurgeMultiplier(s)
		pricing := PriceRide(baseCents, mult)
		fmt.Printf("riders=%d drivers=%d → surge=%.1fx → $%.2f\n",
			s.ActiveRiders, s.ActiveDrivers, pricing.SurgeMultiplier, pricing.TotalPrice)
	}
}
```

#### Problem 3: GPS Ping Processor with Dead Reckoning (Easy)

*Process a stream of GPS pings from drivers, handling dropped pings with dead reckoning interpolation.*

```go
package main

import (
	"fmt"
	"math"
	"time"
)

type GPSPing struct {
	DriverID  string
	Lat, Lng  float64
	Timestamp time.Time
	SpeedKmh  float64
	Heading   float64 // degrees 0-360
}

type DriverTracker struct {
	lastPing map[string]GPSPing
}

func NewDriverTracker() *DriverTracker {
	return &DriverTracker{lastPing: make(map[string]GPSPing)}
}

// EstimatedLocation returns interpolated position if ping is late.
func EstimatedLocation(last GPSPing, at time.Time) (lat, lng float64) {
	elapsed := at.Sub(last.Timestamp).Seconds()
	distKm := last.SpeedKmh * elapsed / 3600

	// Convert heading to radians
	headRad := last.Heading * math.Pi / 180
	dLat := distKm * math.Cos(headRad) / 111.0    // ~111 km per degree lat
	dLng := distKm * math.Sin(headRad) / (111.0 * math.Cos(last.Lat*math.Pi/180))
	return last.Lat + dLat, last.Lng + dLng
}

func (t *DriverTracker) Update(ping GPSPing) {
	t.lastPing[ping.DriverID] = ping
}

func (t *DriverTracker) CurrentLocation(driverID string, at time.Time) (float64, float64, bool) {
	last, ok := t.lastPing[driverID]
	if !ok {
		return 0, 0, false
	}
	gap := at.Sub(last.Timestamp)
	if gap < 5*time.Second {
		return last.Lat, last.Lng, true // fresh ping
	}
	lat, lng := EstimatedLocation(last, at)
	return lat, lng, true // dead-reckoned
}

func main() {
	tracker := NewDriverTracker()

	now := time.Now()
	tracker.Update(GPSPing{
		DriverID:  "d1",
		Lat:       37.7749, Lng: -122.4194,
		Timestamp: now.Add(-10 * time.Second),
		SpeedKmh:  40,
		Heading:   90, // heading east
	})

	lat, lng, ok := tracker.CurrentLocation("d1", now)
	fmt.Printf("Driver d1 estimated location: (%.6f, %.6f) found=%v\n", lat, lng, ok)
	fmt.Printf("(moved ~%.0f meters east in 10s at 40 km/h)\n", 40.0/3600*10*1000)
}
```

#### Problem 4: H3 Hexagonal Grid - Region Aggregation (Medium)

*Simulate Uber's H3-based geospatial indexing to count active drivers per region.*

```go
package main

import (
	"fmt"
	"math"
)

// H3Cell is a simplified hexagonal cell ID (in production, use uber/h3-go).
type H3Cell string

// LatLngToH3 converts lat/lng to a simplified hex cell at a given resolution.
// Real H3 is far more complex - this simulates the concept.
func LatLngToH3(lat, lng float64, resolution int) H3Cell {
	// At resolution 7 (~1.2 km² cells), round to 2 decimal places
	precision := math.Pow(10, float64(resolution-5))
	snapLat := math.Round(lat*precision) / precision
	snapLng := math.Round(lng*precision) / precision
	return H3Cell(fmt.Sprintf("h3_%d_%.3f_%.3f", resolution, snapLat, snapLng))
}

type GeospatialIndex struct {
	resolution int
	cells      map[H3Cell][]string // cell → list of driver IDs
}

func NewGeospatialIndex(resolution int) *GeospatialIndex {
	return &GeospatialIndex{resolution: resolution, cells: make(map[H3Cell][]string)}
}

func (g *GeospatialIndex) AddDriver(driverID string, lat, lng float64) {
	cell := LatLngToH3(lat, lng, g.resolution)
	g.cells[cell] = append(g.cells[cell], driverID)
}

func (g *GeospatialIndex) DriversInCell(lat, lng float64) []string {
	cell := LatLngToH3(lat, lng, g.resolution)
	return g.cells[cell]
}

func (g *GeospatialIndex) SurgeCandidateCells(minDrivers int) []H3Cell {
	var cells []H3Cell
	for cell, drivers := range g.cells {
		if len(drivers) < minDrivers {
			cells = append(cells, cell)
		}
	}
	return cells
}

func main() {
	idx := NewGeospatialIndex(7)

	// Add drivers around SF downtown
	drivers := [][3]float64{
		{37.7749, -122.4194},
		{37.7751, -122.4192},
		{37.7800, -122.4100},
		{37.7810, -122.4105},
		{37.7810, -122.4110},
	}

	for i, d := range drivers {
		idx.AddDriver(fmt.Sprintf("driver_%d", i+1), d[0], d[1])
	}

	// Query drivers near rider
	nearby := idx.DriversInCell(37.7750, -122.4193)
	fmt.Printf("Drivers near rider: %v\n", nearby)

	// Find low-supply cells (surge candidates)
	surgeCells := idx.SurgeCandidateCells(3)
	fmt.Printf("Low-supply cells (< 3 drivers): %d cells\n", len(surgeCells))
}
```

#### Problem 5: Real-Time Ride Matching with Priority Queue (Medium)

*Match riders to drivers using a priority queue that minimizes wait time while respecting driver preferences.*

```go
package main

import (
	"container/heap"
	"fmt"
	"time"
)

type RideRequest struct {
	RiderID   string
	Location  [2]float64
	RequestAt time.Time
	Priority  int // 0=standard, 1=premium, 2=pool
}

type PriorityQueue []*RideRequest

func (pq PriorityQueue) Len() int { return len(pq) }
func (pq PriorityQueue) Less(i, j int) bool {
	// Higher priority first - then earliest request
	if pq[i].Priority != pq[j].Priority {
		return pq[i].Priority > pq[j].Priority
	}
	return pq[i].RequestAt.Before(pq[j].RequestAt)
}
func (pq PriorityQueue) Swap(i, j int) { pq[i], pq[j] = pq[j], pq[i] }
func (pq *PriorityQueue) Push(x any)   { *pq = append(*pq, x.(*RideRequest)) }
func (pq *PriorityQueue) Pop() any {
	old := *pq
	n := len(old)
	x := old[n-1]
	*pq = old[:n-1]
	return x
}

type DispatchQueue struct {
	pq *PriorityQueue
}

func NewDispatchQueue() *DispatchQueue {
	pq := &PriorityQueue{}
	heap.Init(pq)
	return &DispatchQueue{pq: pq}
}

func (d *DispatchQueue) Enqueue(req *RideRequest) {
	heap.Push(d.pq, req)
}

func (d *DispatchQueue) Dequeue() *RideRequest {
	if d.pq.Len() == 0 {
		return nil
	}
	return heap.Pop(d.pq).(*RideRequest)
}

func (d *DispatchQueue) Len() int { return d.pq.Len() }

func main() {
	q := NewDispatchQueue()
	now := time.Now()

	q.Enqueue(&RideRequest{RiderID: "r1", RequestAt: now, Priority: 0})
	q.Enqueue(&RideRequest{RiderID: "r2", RequestAt: now.Add(-5 * time.Second), Priority: 1}) // premium, earlier
	q.Enqueue(&RideRequest{RiderID: "r3", RequestAt: now.Add(-2 * time.Second), Priority: 0})
	q.Enqueue(&RideRequest{RiderID: "r4", RequestAt: now.Add(-1 * time.Second), Priority: 2}) // pool

	priorityNames := map[int]string{0: "standard", 1: "premium", 2: "pool"}
	fmt.Println("Dispatch order:")
	for q.Len() > 0 {
		req := q.Dequeue()
		fmt.Printf("  %s [%s] requested %v ago\n",
			req.RiderID, priorityNames[req.Priority],
			time.Since(req.RequestAt).Round(time.Second))
	}
}
```

#### Problem 6: Trip Fare Calculator with Dynamic Pricing (Medium)

*Calculate trip fare incorporating base rate, per-mile rate, per-minute rate, surge, and promotions.*

```go
package main

import "fmt"

type FareConfig struct {
	BaseFareCents    int64
	PerMileCents     int64
	PerMinuteCents   int64
	MinimumFareCents int64
	BookingFeeCents  int64
}

type TripDetails struct {
	DistanceMiles float64
	DurationMin   float64
	SurgeMultiplier float64
	PromoDiscountPct float64 // 0.0-1.0
}

type FareBreakdown struct {
	Base       int64
	Distance   int64
	Time       int64
	Subtotal   int64
	Surge      int64
	Promo      int64
	BookingFee int64
	Total      int64
}

func CalculateFare(cfg FareConfig, trip TripDetails) FareBreakdown {
	base := cfg.BaseFareCents
	dist := int64(trip.DistanceMiles * float64(cfg.PerMileCents))
	timeCharge := int64(trip.DurationMin * float64(cfg.PerMinuteCents))
	subtotal := base + dist + timeCharge

	// Apply surge to subtotal (not booking fee)
	surgeAdder := int64(float64(subtotal)*(trip.SurgeMultiplier-1))
	withSurge := subtotal + surgeAdder

	// Apply promo discount
	promo := int64(float64(withSurge) * trip.PromoDiscountPct)
	afterPromo := withSurge - promo

	total := afterPromo + cfg.BookingFeeCents
	if total < cfg.MinimumFareCents {
		total = cfg.MinimumFareCents
	}

	return FareBreakdown{
		Base:       base,
		Distance:   dist,
		Time:       timeCharge,
		Subtotal:   subtotal,
		Surge:      surgeAdder,
		Promo:      -promo,
		BookingFee: cfg.BookingFeeCents,
		Total:      total,
	}
}

func main() {
	cfg := FareConfig{
		BaseFareCents:    120,
		PerMileCents:     115,
		PerMinuteCents:   22,
		MinimumFareCents: 500,
		BookingFeeCents:  199,
	}

	trip := TripDetails{
		DistanceMiles:    3.2,
		DurationMin:      14.0,
		SurgeMultiplier:  1.5,
		PromoDiscountPct: 0.10,
	}

	fare := CalculateFare(cfg, trip)
	fmt.Printf("Base:        $%.2f\n", float64(fare.Base)/100)
	fmt.Printf("Distance:    $%.2f (%.1f mi)\n", float64(fare.Distance)/100, trip.DistanceMiles)
	fmt.Printf("Time:        $%.2f (%.0f min)\n", float64(fare.Time)/100, trip.DurationMin)
	fmt.Printf("Subtotal:    $%.2f\n", float64(fare.Subtotal)/100)
	fmt.Printf("Surge 1.5x:  +$%.2f\n", float64(fare.Surge)/100)
	fmt.Printf("Promo 10%%:   -$%.2f\n", float64(-fare.Promo)/100)
	fmt.Printf("Booking fee: $%.2f\n", float64(fare.BookingFee)/100)
	fmt.Printf("─────────────────\n")
	fmt.Printf("Total:       $%.2f\n", float64(fare.Total)/100)
}
```

#### Problem 7: City Graph - Shortest Estimated Arrival Time (Medium)

*Find the fastest route between two points in a city graph with traffic-weighted edges.*

```go
package main

import (
	"container/heap"
	"fmt"
	"math"
)

type Edge struct {
	To       int
	Seconds  float64 // travel time in seconds (traffic-weighted)
}

type Graph struct {
	nodes int
	edges [][]Edge
}

func NewGraph(nodes int) *Graph {
	return &Graph{nodes: nodes, edges: make([][]Edge, nodes)}
}

func (g *Graph) AddEdge(from, to int, seconds float64) {
	g.edges[from] = append(g.edges[from], Edge{to, seconds})
}

type PQItem struct {
	node int
	dist float64
	idx  int
}
type MinPQ []*PQItem
func (h MinPQ) Len() int            { return len(h) }
func (h MinPQ) Less(i, j int) bool  { return h[i].dist < h[j].dist }
func (h MinPQ) Swap(i, j int)       { h[i], h[j] = h[j], h[i]; h[i].idx = i; h[j].idx = j }
func (h *MinPQ) Push(x any)         { it := x.(*PQItem); it.idx = len(*h); *h = append(*h, it) }
func (h *MinPQ) Pop() any           { old := *h; n := len(old); x := old[n-1]; *h = old[:n-1]; return x }

// Dijkstra returns shortest time in seconds from src to dst (-1 if unreachable).
func Dijkstra(g *Graph, src, dst int) (float64, []int) {
	dist := make([]float64, g.nodes)
	prev := make([]int, g.nodes)
	for i := range dist {
		dist[i] = math.MaxFloat64
		prev[i] = -1
	}
	dist[src] = 0

	pq := &MinPQ{&PQItem{src, 0, 0}}
	heap.Init(pq)

	for pq.Len() > 0 {
		curr := heap.Pop(pq).(*PQItem)
		if curr.node == dst {
			break
		}
		if curr.dist > dist[curr.node] {
			continue
		}
		for _, e := range g.edges[curr.node] {
			newDist := dist[curr.node] + e.Seconds
			if newDist < dist[e.To] {
				dist[e.To] = newDist
				prev[e.To] = curr.node
				heap.Push(pq, &PQItem{e.To, newDist, 0})
			}
		}
	}

	if dist[dst] == math.MaxFloat64 {
		return -1, nil
	}

	// Reconstruct path
	var path []int
	for n := dst; n != -1; n = prev[n] {
		path = append([]int{n}, path...)
	}
	return dist[dst], path
}

func main() {
	g := NewGraph(6)
	// Add city intersections with traffic-weighted travel times (seconds)
	g.AddEdge(0, 1, 60)  // 1 min
	g.AddEdge(0, 2, 120) // 2 min
	g.AddEdge(1, 3, 90)  // 1.5 min
	g.AddEdge(2, 3, 45)  // 0.75 min (faster road)
	g.AddEdge(3, 4, 30)
	g.AddEdge(4, 5, 60)
	g.AddEdge(1, 5, 300) // direct but slow (congested)

	seconds, path := Dijkstra(g, 0, 5)
	fmt.Printf("Fastest route: %v\n", path)
	fmt.Printf("ETA: %.0f seconds (%.1f minutes)\n", seconds, seconds/60)
}
```

#### Problem 8: Distributed Rate Limiter for Driver Location Updates (Hard)

*Build a distributed rate limiter that handles high-frequency GPS ping ingestion across multiple service instances.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

// TokenBucket implements the token bucket algorithm for rate limiting.
type TokenBucket struct {
	mu           sync.Mutex
	tokens       float64
	maxTokens    float64
	refillRate   float64 // tokens per second
	lastRefillAt time.Time
}

func NewTokenBucket(maxTokens, refillRate float64) *TokenBucket {
	return &TokenBucket{
		tokens:       maxTokens,
		maxTokens:    maxTokens,
		refillRate:   refillRate,
		lastRefillAt: time.Now(),
	}
}

func (tb *TokenBucket) Allow(cost float64) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(tb.lastRefillAt).Seconds()
	tb.tokens = min(tb.maxTokens, tb.tokens+elapsed*tb.refillRate)
	tb.lastRefillAt = now

	if tb.tokens < cost {
		return false
	}
	tb.tokens -= cost
	return true
}

// DistributedPingIngester manages per-driver rate limits.
type DistributedPingIngester struct {
	mu      sync.Mutex
	buckets map[string]*TokenBucket
	// In production: share state via Redis INCRBY + EXPIRE
	maxPingsPerSec float64
}

func NewPingIngester(maxPingsPerSec float64) *DistributedPingIngester {
	return &DistributedPingIngester{
		buckets:        make(map[string]*TokenBucket),
		maxPingsPerSec: maxPingsPerSec,
	}
}

func (p *DistributedPingIngester) Accept(driverID string) bool {
	p.mu.Lock()
	if _, ok := p.buckets[driverID]; !ok {
		p.buckets[driverID] = NewTokenBucket(p.maxPingsPerSec*2, p.maxPingsPerSec)
	}
	bucket := p.buckets[driverID]
	p.mu.Unlock()
	return bucket.Allow(1.0)
}

func main() {
	ingester := NewPingIngester(4) // 4 pings/sec per driver

	accepted, rejected := 0, 0
	var wg sync.WaitGroup

	// Simulate 20 rapid pings from driver d1 in 500ms
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ingester.Accept("d1") {
				accepted++
			} else {
				rejected++
			}
		}()
		time.Sleep(25 * time.Millisecond) // 40 pings/sec rate
	}
	wg.Wait()

	fmt.Printf("Accepted: %d, Rejected: %d (rate limit: 4/sec, 20 pings in 500ms)\n", accepted, rejected)
}
```

#### Problem 9: Trip History Timeline Reconstruction (Hard)

*Given a stream of out-of-order GPS events, reconstruct a driver's trip timeline with gap detection and trip segmentation.*

```go
package main

import (
	"fmt"
	"slices"
	"time"
)

type Event struct {
	DriverID  string
	Lat, Lng  float64
	Timestamp time.Time
	EventType string // "ping", "trip_start", "trip_end", "offline"
}

type TripSegment struct {
	StartTime time.Time
	EndTime   time.Time
	Points    []Event
	GapAfter  bool // gap detected after this segment
}

// ReconstructTimeline sorts events and segments them into trips.
// A gap > 5 minutes between pings signals a new segment.
func ReconstructTimeline(events []Event) []TripSegment {
	if len(events) == 0 {
		return nil
	}

	slices.SortFunc(events, func(a, b Event) int {
		return a.Timestamp.Compare(b.Timestamp)
	})

	const gapThreshold = 5 * time.Minute
	var segments []TripSegment
	current := TripSegment{StartTime: events[0].Timestamp, Points: []Event{events[0]}}

	for i := 1; i < len(events); i++ {
		gap := events[i].Timestamp.Sub(events[i-1].Timestamp)
		if gap > gapThreshold {
			current.EndTime = events[i-1].Timestamp
			current.GapAfter = true
			segments = append(segments, current)
			current = TripSegment{StartTime: events[i].Timestamp, Points: []Event{events[i]}}
		} else {
			current.Points = append(current.Points, events[i])
		}
	}
	current.EndTime = events[len(events)-1].Timestamp
	segments = append(segments, current)
	return segments
}

func main() {
	now := time.Now().Truncate(time.Minute)
	// Simulate out-of-order events (trips at T+0 and T+20 with gap at T+10)
	events := []Event{
		{Timestamp: now.Add(3 * time.Minute), EventType: "ping"},
		{Timestamp: now.Add(1 * time.Minute), EventType: "trip_start"},
		{Timestamp: now.Add(0), EventType: "ping"},
		{Timestamp: now.Add(2 * time.Minute), EventType: "ping"},
		// Gap: T+3 to T+20
		{Timestamp: now.Add(20 * time.Minute), EventType: "trip_start"},
		{Timestamp: now.Add(22 * time.Minute), EventType: "ping"},
		{Timestamp: now.Add(24 * time.Minute), EventType: "trip_end"},
	}

	segments := ReconstructTimeline(events)
	for i, seg := range segments {
		fmt.Printf("Segment %d: %d events, duration=%v gapAfter=%v\n",
			i+1, len(seg.Points),
			seg.EndTime.Sub(seg.StartTime).Round(time.Minute),
			seg.GapAfter)
	}
}
```

#### Problem 10: ETA Prediction with Kalman Filter Smoothing (Hard)

*Implement a simplified Kalman filter to smooth noisy GPS speed measurements for ETA prediction.*

```go
package main

import "fmt"

// KalmanFilter1D is a 1D Kalman filter for smoothing scalar measurements (e.g., speed).
type KalmanFilter1D struct {
	estimate float64 // current best estimate
	errorCov float64 // estimate error covariance
	processNoise float64 // Q: expected process noise
	measureNoise float64 // R: sensor measurement noise
}

func NewKalmanFilter(initialEstimate, initialError, processNoise, measureNoise float64) *KalmanFilter1D {
	return &KalmanFilter1D{
		estimate:     initialEstimate,
		errorCov:     initialError,
		processNoise: processNoise,
		measureNoise: measureNoise,
	}
}

// Update incorporates a new measurement and returns the updated estimate.
func (kf *KalmanFilter1D) Update(measurement float64) float64 {
	// Predict step: error covariance grows by process noise
	kf.errorCov += kf.processNoise

	// Update step: Kalman gain
	gain := kf.errorCov / (kf.errorCov + kf.measureNoise)
	kf.estimate += gain * (measurement - kf.estimate)
	kf.errorCov = (1 - gain) * kf.errorCov

	return kf.estimate
}

// ETASeconds computes ETA given smoothed speed (km/h) and remaining distance (km).
func ETASeconds(speedKmh, distanceKm float64) float64 {
	if speedKmh <= 0 {
		return -1
	}
	return distanceKm / speedKmh * 3600
}

func main() {
	// Noisy GPS speed readings (km/h) - true speed is ~35 km/h
	noisyReadings := []float64{38, 22, 45, 31, 29, 41, 34, 27, 36, 33}

	kf := NewKalmanFilter(35, 10, 1, 15) // initial=35, noise params
	distanceRemaining := 2.5 // km

	fmt.Printf("%-10s %-12s %-12s %-12s\n", "Reading", "Raw km/h", "Smoothed", "ETA (min)")
	for i, raw := range noisyReadings {
		smoothed := kf.Update(raw)
		eta := ETASeconds(smoothed, distanceRemaining)
		fmt.Printf("%-10d %-12.1f %-12.1f %-12.1f\n", i+1, raw, smoothed, eta/60)
	}
}
```

---

### System Design Topics

**Top 5 Uber System Design Questions:**

1. **Design Uber's Dispatch System** - Match millions of riders to drivers in real time globally. Topics: geospatial indexing (H3), pub/sub for driver location updates, consistent hashing for region-based sharding, supply/demand signals, fallback matching strategies.

2. **Design Surge Pricing Engine** - Compute dynamic pricing for thousands of regions every 30 seconds. Topics: streaming aggregation (Kafka/Flink), windowed counts, H3 region hierarchy, pricing tier state machines, anomaly detection for price spikes.

3. **Design Uber's Real-Time Location Platform** - Ingest billions of GPS pings daily. Topics: write-heavy architecture, time-series storage, CDC (Change Data Capture), dead reckoning, geohash indexing, data retention policies.

4. **Design Uber Eats Order Management** - Track orders from placement through delivery. Topics: saga/choreography patterns, state machine transitions, ETA prediction, multi-party notifications, driver/restaurant/customer fan-out.

5. **Design Uber's Trip History Service** - Store and query 10+ years of trip data. Topics: cold/hot storage tiering, columnar formats (Parquet), Apache Hudi for incremental processing, GDPR deletion support, analytics vs. transactional access patterns.

---

### Behavioral Focus

Uber's culture emphasizes **"Building Globally, Living Locally"** and a bias for action. Key behavioral themes:

- **Ownership:** "Tell me about a time you took full ownership of a system - including the parts that weren't technically your responsibility."
- **Data-driven decisions:** "Describe how you used data to make a counterintuitive engineering decision."
- **Speed vs. quality trade-offs:** "Tell me about a time you had to ship fast and what corners you cut - and whether those were the right trade-offs."
- **Operating at scale:** "Describe a system you built that had to scale 10x unexpectedly. What broke? What held?"
- **Customer obsession:** "Give an example of going beyond your assigned scope to improve rider or driver experience."

---

### Insider Tips

**Common Mistakes:**
- Designing city graphs with BFS instead of Dijkstra - real city routing needs weighted edges (traffic).
- Not accounting for GPS noise and dropped pings in location systems.
- Forgetting consistency trade-offs in distributed rate limiting - a Redis-based limiter can over-count under network partition.
- In system design: designing for average load, not peak (surge events during NYE, concerts, bad weather).

**Strong Hire Signals:**
- Mentioning H3 or geohash for spatial indexing without prompting.
- Discussing the CAP theorem trade-offs in dispatch (availability > consistency for matching).
- Proposing Kafka for the GPS ping pipeline with explicit partition strategy.
- Surge pricing: mentioning feedback loops and anti-gouging regulations.

**Red Flags:**
- Over-indexing on exact-match algorithms (binary search, tries) for geospatial problems.
- Not discussing data retention and storage costs in location ingestion systems.
- Ignoring mobile network unreliability in GPS ping processing design.

---

### 8-Week Preparation Timeline

```
Week 1: Geospatial Foundations
  Mon-Tue: H3 hexagonal grid, geohash, quadtree indexing concepts
  Wed-Thu: Implement proximity search, nearest-neighbor algorithms
  Fri:     Study haversine formula, GPS coordinate systems
  Weekend: Build a simple driver-location index from scratch

Week 2: Real-Time Systems
  Mon-Tue: Kafka architecture, partitioning strategies, consumer groups
  Wed-Thu: Sliding window aggregations, stream processing concepts
  Fri:     Redis data structures for real-time state
  Weekend: Design surge pricing pipeline (whiteboard)

Week 3: Algorithms - Graphs & Priority Queues
  Mon-Fri: 2 problems/day - Dijkstra, A*, graph BFS/DFS variants
  Weekend: 4 timed coding rounds (45 min each)

Week 4: System Design - Dispatch & Location
  Mon-Tue: Design Uber dispatch system (whiteboard)
  Wed-Thu: Design real-time location platform
  Fri:     Design surge pricing engine
  Weekend: Mock system design interview

Week 5: Distributed Systems Deep Dive
  Mon-Tue: Consistent hashing, shard routing, rebalancing
  Wed-Thu: Rate limiting algorithms (token bucket, leaky bucket, sliding window)
  Fri:     Saga pattern, distributed transactions
  Weekend: Design Uber Eats order management

Week 6: Go-Specific Prep
  Mon-Tue: goroutines + channels for concurrent location processing
  Wed-Thu: sync.Map, atomic ops, Go memory model
  Fri:     Profiling Go services, pprof, trace analysis
  Weekend: Build concurrent GPS ping processor in Go

Week 7: Behavioral & Leadership
  Mon-Tue: Write 5 STAR stories (ownership, scale, data-driven, trade-offs, customer)
  Wed:     Mock behavioral interview
  Thu:     Architecture round prep: service mesh, failure modes, observability
  Fri:     Review Uber engineering blog posts (3-5 posts)
  Weekend: Mock full onsite

Week 8: Final Prep
  Mon-Tue: Weak areas review
  Wed:     Full mock onsite (all rounds)
  Thu:     Rest and logistics
  Fri:     Light review of key concepts only
```

---


### Junior → FAANG: Uber Interview Preparation Basics

Uber's engineering culture is shaped by its core product: a real-time marketplace that matches riders and drivers at global scale with strict latency requirements. Interview preparation for Uber should include familiarity with geospatial systems (geohashing, quadtrees, H3), real-time event processing, and marketplace dynamics (surge pricing, supply-demand balancing). Coding interviews at Uber are similar to other FAANG companies. System design interviews often involve location-based services or ride-matching scenarios.

### Senior @ FAANG: Uber Senior and Staff: Operational Excellence and Marketplace Engineering

At the senior and staff level at Uber, the engineering culture prizes operational robustness above elegance. The core engineering challenge is that a system outage has immediate, visible impact on riders and drivers in the physical world, which creates a strong bias toward operational simplicity, aggressive monitoring, and well-practiced runbooks over clever architecture. Senior candidates should have strong stories about on-call ownership, incident response, and post-incident process improvement. Uber's marketplace engineering also involves unique challenges at the staff level: the surge pricing algorithm must be fair (perceived fairness affects trust), the driver-rider matching algorithm involves multi-objective optimization under time constraints, and the platform must handle demand spikes (sporting events, concerts) that are an order of magnitude above baseline. Staff candidates should demonstrate awareness of these second-order product-engineering interactions.

---
