## 2. Uber: Microservices at Massive Scale

### 2.1 Why Uber Chose Go

Uber transitioned from Python/Node.js to Go around 2015 for:
- Better performance for high-throughput services
- Strong concurrency model for real-time dispatch
- Type safety to reduce production errors
- Easier deployment (single binary)

### 2.2 What Uber Built with Go

#### Zap - Ultra-Fast Logging

Uber open-sourced Zap, a structured logger built for zero-allocation hot paths. It avoids the reflection and fmt-based formatting that slows down the standard library logger.
```go
package main

// Zap's structured logging approach
import "go.uber.org/zap"

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    // Structured logging with zero allocations
    logger.Info("user request",
        zap.String("user_id", "12345"),
        zap.Int("ride_count", 42),
        zap.Duration("latency", 150*time.Millisecond),
    )

    // Contextual logger
    userLogger := logger.With(
        zap.String("user_id", "12345"),
        zap.String("city", "SF"),
    )

    userLogger.Info("ride requested",
        zap.String("pickup", "Market St"),
        zap.String("dropoff", "Mission St"),
    )
}

// Why Zap is fast:
// 1. Zero allocations for structured logs
// 2. Strongly typed fields
// 3. Pre-allocated buffers
// 4. Efficient JSON encoding
```

**Performance Characteristics:**
- 10x faster than standard library log
- 5x faster than logrus
- Zero allocation structured logging

#### Fx - Dependency Injection Framework

Fx manages application lifecycle and dependency wiring. It uses constructor injection: you provide constructor functions, and Fx resolves the dependency graph at startup.
```go
package main

// Fx for managing application lifecycle
import "go.uber.org/fx"

func NewHTTPServer(lc fx.Lifecycle, logger *zap.Logger) *http.Server {
    srv := &http.Server{Addr: ":8080"}

    lc.Append(fx.Hook{
        OnStart: func(ctx context.Context) error {
            go srv.ListenAndServe()
            logger.Info("HTTP server started", zap.String("addr", srv.Addr))
            return nil
        },
        OnStop: func(ctx context.Context) error {
            logger.Info("HTTP server stopping")
            return srv.Shutdown(ctx)
        },
    })

    return srv
}

func main() {
    app := fx.New(
        fx.Provide(
            zap.NewProduction,
            NewHTTPServer,
            NewDatabase,
            NewRideService,
        ),
        fx.Invoke(RegisterRoutes),
    )

    app.Run()
}
```

#### TChannel - RPC Framework

TChannel is Uber's RPC framework for service-to-service communication. It supports multiplexing, timeouts, and distributed tracing out of the box.
```go
package service

// TChannel for service-to-service communication
type RideService struct {
    channel *tchannel.Channel
}

func (s *RideService) RequestRide(ctx context.Context, req *RideRequest) (*RideResponse, error) {
    // Create sub-channel for specific service
    sc := s.channel.GetSubChannel("ride-dispatch")

    // Make RPC call with timeout
    ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    defer cancel()

    var resp RideResponse
    err := sc.Call(ctx, "requestRide", req, &resp)
    return &resp, err
}
```

#### M3 - Metrics and Monitoring Platform

M3 is Uber's metrics platform, built on top of the Tally library. It handles counters, timers, and gauges for observability across thousands of microservices.
```go
package metrics

// M3 metrics for observability
import "github.com/uber-go/tally"

type Service struct {
    scope tally.Scope
}

func (s *Service) ProcessRide(ctx context.Context, ride *Ride) error {
    timer := s.scope.Timer("ride.processing.duration").Start()
    defer timer.Stop()

    s.scope.Counter("ride.requests").Inc(1)

    if err := s.process(ride); err != nil {
        s.scope.Counter("ride.errors").Inc(1)
        return err
    }

    s.scope.Gauge("ride.active").Update(float64(s.activeRides()))
    return nil
}
```

### 2.3 Uber's Microservices Architecture

**Service Patterns:**

```go
package dispatch

// Domain-oriented microservices
type RideDispatchService struct {
    rideRepo     RideRepository
    driverSvc    DriverService
    paymentSvc   PaymentService
    notifySvc    NotificationService
    eventBus     EventBus
}

func (s *RideDispatchService) DispatchRide(ctx context.Context, req *DispatchRequest) error {
    // 1. Find available drivers
    drivers, err := s.driverSvc.FindNearby(ctx, req.Location, 5*time.Minute)
    if err != nil {
        return fmt.Errorf("finding drivers: %w", err)
    }

    // 2. Match rider to driver (async)
    matchCh := make(chan *Match, 1)
    go s.matchDriver(ctx, req.RiderID, drivers, matchCh)

    // 3. Wait for match or timeout
    select {
    case match := <-matchCh:
        return s.confirmRide(ctx, match)
    case <-ctx.Done():
        return ctx.Err()
    case <-time.After(30 * time.Second):
        return ErrNoDriversAvailable
    }
}

// Event-driven communication
func (s *RideDispatchService) confirmRide(ctx context.Context, match *Match) error {
    ride := &Ride{
        ID:       generateID(),
        RiderID:  match.RiderID,
        DriverID: match.DriverID,
        Status:   StatusConfirmed,
    }

    // Publish event to event bus
    event := &RideConfirmedEvent{
        RideID:   ride.ID,
        RiderID:  ride.RiderID,
        DriverID: ride.DriverID,
    }

    return s.eventBus.Publish(ctx, "ride.confirmed", event)
}
```

**Resilience Patterns:**

```go
package client

// Circuit breaker for external service calls
import "github.com/sony/gobreaker"

type PaymentClient struct {
    cb *gobreaker.CircuitBreaker
}

func NewPaymentClient() *PaymentClient {
    settings := gobreaker.Settings{
        Name:        "payment-service",
        MaxRequests: 3,
        Interval:    10 * time.Second,
        Timeout:     60 * time.Second,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.Requests >= 3 && failureRatio >= 0.6
        },
    }

    return &PaymentClient{
        cb: gobreaker.NewCircuitBreaker(settings),
    }
}

func (c *PaymentClient) Charge(ctx context.Context, amount int64) error {
    _, err := c.cb.Execute(func() (any, error) {
        return nil, c.doCharge(ctx, amount)
    })
    return err
}
```

### 2.4 Go 1.25/1.26 Features Relevant to Uber

Uber's engineering challenges - high-throughput microservices, zero-allocation logging, and massive concurrent workloads - map directly onto Go 1.25/1.26 improvements:

- **Green Tea GC** (Go 1.26): Uber's Zap logger was specifically engineered for zero-allocation hot paths to avoid GC pressure. With Green Tea GC cutting total GC overhead by 10-40% on allocation-heavy workloads, the cost of any remaining allocation in Uber's high-RPS services (dispatch, pricing, routing) drops. Services processing millions of GPS coordinates per minute are exactly the profile the Go team's benchmarks show benefiting most.
- **Self-referential types in generics** (Go 1.26): Uber's internal graph and tree data structures (used in routing algorithms and service dependency graphs) can now use fully type-safe generic containers. This eliminates `interface{}` casting in performance-critical graph traversal code.
- **`testing/synctest`** (Go 1.25): Uber's dispatch and matching services are heavily concurrent. The `testing/synctest` package eliminates flaky timing-dependent tests - a longstanding pain point in concurrent Go testing. Uber's engineering blog has previously cited goroutine lifecycle testing as a common source of CI instability.

### 2.5 Uber Interview Expectations

**What They Test:**

1. **Coding (2 rounds, 45 min each):**
 - Data structures and algorithms
 - Focus on optimal solutions (time/space complexity)
 - Real-world problem modeling

2. **System Design (1 hour):**
 - Design Uber's dispatch system
 - Design surge pricing algorithm
 - Design driver location tracking

 **Expected Discussion Points:**
 - Database sharding strategies
 - Real-time data processing
 - Geospatial indexing
 - Event-driven architecture

3. **Domain Round:**
 - Design patterns in Go
 - Microservices best practices
 - Debugging production issues

**Sample Problem:**

```go
package matching

// Design a ride matching system
type Location struct {
    Lat, Lng float64
}

type Driver struct {
    ID       string
    Location Location
    Rating   float64
}

type RideMatcher interface {
    FindBestMatch(riderLoc Location, drivers []Driver) *Driver
}

// Implementation using geohashing
type GeoHashMatcher struct {
    precision int
}

func (m *GeoHashMatcher) FindBestMatch(riderLoc Location, drivers []Driver) *Driver {
    // Group drivers by geohash
    grid := make(map[string][]Driver)
    for _, d := range drivers {
        hash := geohash.Encode(d.Location.Lat, d.Location.Lng, m.precision)
        grid[hash] = append(grid[hash], d)
    }

    // Find nearest drivers
    riderHash := geohash.Encode(riderLoc.Lat, riderLoc.Lng, m.precision)
    candidates := grid[riderHash]

    // Add nearby cells
    for _, neighbor := range geohash.Neighbors(riderHash) {
        candidates = append(candidates, grid[neighbor]...)
    }

    // Select best driver by distance and rating
    var best *Driver
    minScore := math.MaxFloat64

    for i := range candidates {
        dist := haversine(riderLoc, candidates[i].Location)
        score := dist / (candidates[i].Rating + 1.0)

        if score < minScore {
            minScore = score
            best = &candidates[i]
        }
    }

    return best
}
```

**Preparation Tips:**
- Study geospatial algorithms
- Understand event-driven architectures
- Practice real-time system design
- Read Uber's engineering blog

---
