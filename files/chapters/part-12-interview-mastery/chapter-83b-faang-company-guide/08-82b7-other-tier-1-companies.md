## 83B.7 Other Tier-1 Companies

### Stripe - Payment Systems Expertise, Go-First Company

Stripe is one of the strongest Go shops in tech. Their interview focuses on:
- **API design** - RESTful API design with idempotency, versioning, error handling
- **Distributed systems** - Payment processing requires exactly-once semantics
- **Code review** - Stripe includes a "debug an existing codebase" round
- **Integration problems** - Build a small feature against a mock API

```go
// Stripe-style: Implement idempotent payment processing
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

type PaymentStatus string

const (
	PaymentPending   PaymentStatus = "pending"
	PaymentCompleted PaymentStatus = "completed"
	PaymentFailed    PaymentStatus = "failed"
)

type Payment struct {
	ID             string
	IdempotencyKey string
	Amount         int64 // cents
	Currency       string
	Status         PaymentStatus
	CreatedAt      time.Time
}

type PaymentProcessor struct {
	mu             sync.Mutex
	payments       map[string]*Payment
	idempotencyMap map[string]string // idempotency_key -> payment_id
}

func NewPaymentProcessor() *PaymentProcessor {
	return &PaymentProcessor{
		payments:       make(map[string]*Payment),
		idempotencyMap: make(map[string]string),
	}
}

func (pp *PaymentProcessor) ProcessPayment(idempotencyKey string, amount int64, currency string) (*Payment, error) {
	pp.mu.Lock()
	defer pp.mu.Unlock()

	// Check idempotency
	if existingID, ok := pp.idempotencyMap[idempotencyKey]; ok {
		return pp.payments[existingID], nil
	}

	if amount <= 0 {
		return nil, fmt.Errorf("invalid amount: %d", amount)
	}

	id := generateID()
	payment := &Payment{
		ID:             id,
		IdempotencyKey: idempotencyKey,
		Amount:         amount,
		Currency:       currency,
		Status:         PaymentCompleted,
		CreatedAt:      time.Now(),
	}

	pp.payments[id] = payment
	pp.idempotencyMap[idempotencyKey] = id
	return payment, nil
}

func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return "pay_" + hex.EncodeToString(b)
}

func main() {
	pp := NewPaymentProcessor()

	// First request
	p1, _ := pp.ProcessPayment("key-123", 5000, "usd")
	fmt.Printf("Payment 1: %s, $%.2f\n", p1.ID, float64(p1.Amount)/100)

	// Retry with same idempotency key - returns same result
	p2, _ := pp.ProcessPayment("key-123", 5000, "usd")
	fmt.Printf("Payment 2: %s (same: %v)\n", p2.ID, p1.ID == p2.ID)
}
```

### Uber - Real-Time Systems, Go Microservices

Uber's entire backend is Go-based. Interview focuses on:
- **Real-time matching algorithms** - Driver-rider matching, surge pricing
- **Geospatial indexing** - H3, quadtrees, geohashing
- **High-throughput systems** - Millions of events per second
- **Uber-specific Go patterns** - They maintain many open-source Go libraries

```go
// Uber-style: Geospatial driver matching with quadtree
package main

import (
	"fmt"
	"math"
)

type Point struct {
	Lat, Lng float64
	ID       string
}

type Bounds struct {
	MinLat, MaxLat float64
	MinLng, MaxLng float64
}

func (b Bounds) Contains(p Point) bool {
	return p.Lat >= b.MinLat && p.Lat <= b.MaxLat &&
		p.Lng >= b.MinLng && p.Lng <= b.MaxLng
}

func (b Bounds) Intersects(other Bounds) bool {
	return !(other.MinLat > b.MaxLat || other.MaxLat < b.MinLat ||
		other.MinLng > b.MaxLng || other.MaxLng < b.MinLng)
}

type QuadTree struct {
	bounds   Bounds
	points   []Point
	capacity int
	children [4]*QuadTree
	divided  bool
}

func NewQuadTree(bounds Bounds, capacity int) *QuadTree {
	return &QuadTree{bounds: bounds, capacity: capacity}
}

func (qt *QuadTree) Insert(p Point) bool {
	if !qt.bounds.Contains(p) {
		return false
	}

	if len(qt.points) < qt.capacity && !qt.divided {
		qt.points = append(qt.points, p)
		return true
	}

	if !qt.divided {
		qt.subdivide()
	}

	for _, child := range qt.children {
		if child.Insert(p) {
			return true
		}
	}
	return false
}

func (qt *QuadTree) subdivide() {
	midLat := (qt.bounds.MinLat + qt.bounds.MaxLat) / 2
	midLng := (qt.bounds.MinLng + qt.bounds.MaxLng) / 2

	qt.children[0] = NewQuadTree(Bounds{qt.bounds.MinLat, midLat, qt.bounds.MinLng, midLng}, qt.capacity)
	qt.children[1] = NewQuadTree(Bounds{midLat, qt.bounds.MaxLat, qt.bounds.MinLng, midLng}, qt.capacity)
	qt.children[2] = NewQuadTree(Bounds{qt.bounds.MinLat, midLat, midLng, qt.bounds.MaxLng}, qt.capacity)
	qt.children[3] = NewQuadTree(Bounds{midLat, qt.bounds.MaxLat, midLng, qt.bounds.MaxLng}, qt.capacity)

	// Re-insert existing points
	for _, p := range qt.points {
		for _, child := range qt.children {
			if child.Insert(p) {
				break
			}
		}
	}
	qt.points = nil
	qt.divided = true
}

func (qt *QuadTree) QueryRange(searchBounds Bounds) []Point {
	var found []Point
	if !qt.bounds.Intersects(searchBounds) {
		return found
	}

	for _, p := range qt.points {
		if searchBounds.Contains(p) {
			found = append(found, p)
		}
	}

	if qt.divided {
		for _, child := range qt.children {
			found = append(found, child.QueryRange(searchBounds)...)
		}
	}
	return found
}

func FindNearestDrivers(qt *QuadTree, riderLat, riderLng, radiusKm float64, limit int) []Point {
	// Approximate degree offset for radius
	latOffset := radiusKm / 111.0
	lngOffset := radiusKm / (111.0 * math.Cos(riderLat*math.Pi/180))

	searchBounds := Bounds{
		MinLat: riderLat - latOffset,
		MaxLat: riderLat + latOffset,
		MinLng: riderLng - lngOffset,
		MaxLng: riderLng + lngOffset,
	}

	candidates := qt.QueryRange(searchBounds)

	// Sort by distance (haversine)
	type distPoint struct {
		point Point
		dist  float64
	}
	var dps []distPoint
	for _, p := range candidates {
		d := haversine(riderLat, riderLng, p.Lat, p.Lng)
		if d <= radiusKm {
			dps = append(dps, distPoint{p, d})
		}
	}

	// Simple selection of closest
	for i := 0; i < len(dps) && i < limit; i++ {
		for j := i + 1; j < len(dps); j++ {
			if dps[j].dist < dps[i].dist {
				dps[i], dps[j] = dps[j], dps[i]
			}
		}
	}

	result := make([]Point, 0, limit)
	for i := 0; i < len(dps) && i < limit; i++ {
		result = append(result, dps[i].point)
	}
	return result
}

func haversine(lat1, lng1, lat2, lng2 float64) float64 {
	const R = 6371.0 // Earth radius in km
	dLat := (lat2 - lat1) * math.Pi / 180
	dLng := (lng2 - lng1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLng/2)*math.Sin(dLng/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

func main() {
	// San Francisco area
	bounds := Bounds{37.7, 37.85, -122.55, -122.35}
	qt := NewQuadTree(bounds, 4)

	// Add drivers
	drivers := []Point{
		{37.7749, -122.4194, "driver-1"},
		{37.7849, -122.4094, "driver-2"},
		{37.7649, -122.4294, "driver-3"},
		{37.7949, -122.4394, "driver-4"},
		{37.7549, -122.4494, "driver-5"},
	}

	for _, d := range drivers {
		qt.Insert(d)
	}

	nearest := FindNearestDrivers(qt, 37.78, -122.42, 2.0, 3)
	for _, d := range nearest {
		dist := haversine(37.78, -122.42, d.Lat, d.Lng)
		fmt.Printf("Driver %s: %.2f km away\n", d.ID, dist)
	}
}
```

### Airbnb - Full-Stack Thinking, Service-Oriented

- Focus on full-stack system design (frontend + backend + data)
- Cross-functional collaboration emphasis
- Practical coding problems related to search, booking, pricing

### Coinbase - Blockchain + Go, Security Focus

- Deep Go expertise required - Coinbase is a Go-first company
- Security-focused interviews: encryption, key management, audit logging
- Blockchain fundamentals: consensus, merkle trees, transaction verification

### Datadog - Observability, Performance-Critical Go Services

- Performance-critical Go code: zero-allocation patterns, custom allocators
- Time-series data processing at massive scale
- Agent-based architecture: understanding Go's memory model deeply

### Cloudflare - Edge Computing, Networking, Go Workers

- Network protocol knowledge: TCP, HTTP/2, HTTP/3, DNS, TLS
- Edge computing patterns: low-latency request processing
- Go at scale: millions of requests per second per server


### Junior → FAANG: Preparing for Tier-1 Non-FAANG Companies

Companies like Stripe, Airbnb, Uber, Lyft, Snap, and Pinterest are considered tier-1 in terms of compensation and engineering quality. Their interview processes borrow from FAANG but have distinct flavors. Stripe is known for rigorous systems thinking interviews. Uber prioritizes operational robustness and large-scale distributed systems experience. For each target company, research the specific interview format (some use take-home projects, others use pair programming, others use traditional whiteboard), the team's engineering blog for insight into technical priorities, and interview experience reports from recent candidates.

### Senior @ FAANG: Tier-1 Non-FAANG at the Senior Level: Opportunity vs. Prestige

Senior candidates should evaluate tier-1 non-FAANG companies on substance, not prestige. The concrete evaluation criteria: What is the scope of the staff or senior role (is it equivalent to L6 at Google, or closer to L5)? What is the team's engineering maturity (do they have on-call rotations, incident reviews, design doc culture)? What is the leadership path (does the company have a well-defined IC leadership track above senior, or does growth require moving into management)? What is the equity structure (private companies offer options with illiquidity risk, the trade-off against FAANG RSUs is real and should be modeled financially)? These companies often offer faster promotion clocks and more scope per engineer than FAANG, which can be more valuable for career development than the brand name alone.

---
