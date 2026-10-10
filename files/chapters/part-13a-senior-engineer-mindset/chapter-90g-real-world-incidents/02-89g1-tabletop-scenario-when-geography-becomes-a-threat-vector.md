## 90G.1 Tabletop Scenario: When Geography Becomes a Threat Vector

### The Scenario

Unlike every other incident in this chapter, this one has not happened. It is a fictional tabletop exercise, the
kind that cloud providers and large AWS customers actually run in disaster-recovery wargames, and it exists here
because the real incidents that inspired it (submarine cable cuts in the Red Sea and Baltic, datacenter strikes
during the war in Ukraine, and the industry's post-2022 geographic risk reviews) all point at the same untested
assumption: that Availability Zones are independent failure domains. Suppose coordinated drone strikes hit three
hyperscale data centers in a Gulf cloud region, two Availability Zones in one region and one in a neighboring
region. Walk through what would follow.

**The scenario's timeline:**

```
2026-03-01 02:14 UTC  First drone wave hits Region A (three AZs)
                      region-a-az2 and region-a-az3 sustain physical damage
2026-03-01 02:17 UTC  Second wave hits Region B (three AZs)
                      region-b-az2 destroyed
2026-03-01 02:19 UTC  AWS internal monitoring triggers region-wide alerts
2026-03-01 02:25 UTC  CloudWatch begins reporting AZ-level failures
2026-03-01 02:31 UTC  AWS Status Page updated: "Elevated error rates"
2026-03-01 02:45 UTC  109+ services show impaired status
2026-03-01 03:00 UTC  Banks begin reporting complete payment system failures
2026-03-01 03:15 UTC  AWS advisory: "Recovery prolonged given physical damage"
2026-03-01 04:00 UTC  AWS recommends migrating workloads to alternate regions
2026-03-01 06:00+     Regional internet traffic drops 40% - submarine cables
                      through Strait of Hormuz also disrupted
```

**Affected Services (109+ confirmed):**

| Service Category | Services Impaired |
|---|---|
| Compute | EC2, Lambda, ECS, EKS, Fargate |
| Storage | S3, EBS, EFS, FSx |
| Database | RDS, DynamoDB, ElastiCache, Aurora |
| Networking | VPC, ELB, Route 53 (regional), CloudFront (edge POPs) |
| Security | IAM (regional), KMS, Secrets Manager |
| Application | SQS, SNS, Step Functions, EventBridge |

**Who a scenario like this would hit:**

- **Banking:** regional banks whose payment processing runs exclusively in-region (data residency rules often force this)
- **Fintech:** payment platforms with single-region deployments
- **Transportation:** ride-hailing and logistics platforms serving the region
- **Government:** national digital services hosted in-country by policy
- **Enterprise:** every company that treated multi-AZ as its disaster recovery story

### Architecture Analysis: Why Multi-AZ Failed

The fundamental assumption of AWS multi-AZ deployments is that Availability Zones are physically independent
failure domains. Each AZ has independent power, cooling, and networking. The design protects against single
facility failures - a fire, a power outage, a cooling system failure. What it does not protect against is a
coordinated attack on multiple facilities in the same geographic region.

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                     Region A (three AZs)                                          │
│                                                                                   │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                          │
│   │ region-a-az1 │   │ region-a-az2 │   │ region-a-az3 │                          │
│   │   (healthy)  │   │   (STRUCK)   │   │   (STRUCK)   │                          │
│   │              │   │              │   │              │                          │
│   │  EC2  S3     │   │  ██████████  │   │  ██████████  │                          │
│   │  RDS  Lambda │   │  ██ LOST ██  │   │  ██ LOST ██  │                          │
│   │  DynamoDB    │   │  ██████████  │   │  ██████████  │                          │
│   └──────────────┘   └──────────────┘   └──────────────┘                          │
│          │                   X                   X                                │
│          │           (physical damage)   (physical damage)                        │
│          ▼                                                                        │
│   Single AZ surviving - insufficient capacity for full region load                │
└───────────────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────────────┐
│                     Region B (three AZs)                                          │
│                                                                                   │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                          │
│   │ region-b-az1 │   │ region-b-az2 │   │ region-b-az3 │                          │
│   │   (healthy)  │   │   (STRUCK)   │   │   (healthy)  │                          │
│   │              │   │              │   │              │                          │
│   │  EC2  S3     │   │  ██████████  │   │  EC2  S3     │                          │
│   │  RDS  Lambda │   │  ██ LOST ██  │   │  RDS  Lambda │                          │
│   │  DynamoDB    │   │  ██████████  │   │  DynamoDB    │                          │
│   └──────────────┘   └──────────────┘   └──────────────┘                          │
│          │                   X                   │                                │
│          │           (physical damage)           │                                │
│          ▼                                       ▼                                │
│   2 AZs surviving - degraded but partially operational                            │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**The Submarine Cable Compounding Factor:**

The attack did not happen in isolation. Since February 2024, Houthi activity in the Red Sea had already severed
three submarine cables, disrupting 25% of Asia-Europe-Middle East internet traffic. By March 2026, seventeen
cables passing through the Red Sea were at risk, and the Strait of Hormuz - through which additional cables pass
 -  was also closed. This meant that even services not hosted in the struck data centers experienced degraded
connectivity because the physical internet infrastructure connecting the Middle East to the global network was
severely compromised.

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Submarine Cable Topology                            │
│                                                                      │
│  EUROPE ────── Mediterranean ────── Red Sea ────── Indian Ocean      │
│    │                                   │              │              │
│    │            ┌──────────┐          │              │               │
│    │            │ Suez     │     ┌────┴────┐    ┌───┴────┐           │
│    │            │ Canal    │     │ Strait  │    │ Gulf   │           │
│    │            └────┬─────┘     │ of Bab  │    │ of     │           │
│    │                 │           │ el-     │    │ Oman   │           │
│    │                 │           │ Mandeb  │    └───┬────┘           │
│    │                 │           └────┬────┘        │                │
│    │                 │                │              │               │
│    │                 ▼                ▼              ▼               │
│    │           ┌──────────────────────────────────────┐              │
│    │           │    RED SEA CABLE CORRIDOR            │              │
│    │           │    17 cables at risk                 │              │
│    │           │    3 already severed (Feb 2024)      │              │
│    │           │    25% Asia-EU-ME traffic disrupted  │              │
│    │           └──────────────────────────────────────┘              │
│    │                                                                 │
│    └── Alternative: Cape of Good Hope route (+130ms latency)         │
│                                                                      │
│  ┌───────────────────────────────────────────────────────┐           │
│  │    Strait of Hormuz                                   │           │
│  │    Additional cable corridor - ALSO CLOSED            │           │
│  │    UAE ←→ Global connectivity further degraded        │           │
│  └───────────────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────┘
```

### Go Implementation: Multi-Region Failover Client

The following implementation provides a production-grade multi-region client that detects regional failures and
transparently routes requests to healthy regions. It incorporates health checking, circuit breaking, and
geopolitical risk awareness.

```go
package multiregion

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// RegionStatus represents the operational state of a cloud region.
type RegionStatus int

const (
	RegionHealthy RegionStatus = iota
	RegionDegraded
	RegionUnreachable
	RegionDestroyed // kinetic/permanent failure
)

func (s RegionStatus) String() string {
	switch s {
	case RegionHealthy:
		return "healthy"
	case RegionDegraded:
		return "degraded"
	case RegionUnreachable:
		return "unreachable"
	case RegionDestroyed:
		return "destroyed"
	default:
		return "unknown"
	}
}

// GeopoliticalRisk encodes the threat level of a geographic area.
type GeopoliticalRisk int

const (
	RiskLow GeopoliticalRisk = iota
	RiskMedium
	RiskHigh
	RiskCritical // active conflict zone
)

// Region represents a cloud provider region with health and risk metadata.
type Region struct {
	Name            string
	Endpoint        string
	Priority        int             // lower = preferred
	Status          atomic.Int32    // RegionStatus
	GeopoliticalRisk GeopoliticalRisk
	SubmarineCableDependency string // cable corridor this region depends on

	// Circuit breaker state
	consecutiveFailures atomic.Int64
	lastFailure         atomic.Int64 // unix nano
	circuitOpen         atomic.Bool
}

// IsAvailable returns true if the region can accept traffic.
func (r *Region) IsAvailable() bool {
	status := RegionStatus(r.Status.Load())
	if status == RegionDestroyed || status == RegionUnreachable {
		return false
	}
	if r.circuitOpen.Load() {
		// Check if enough time has passed to try again (half-open)
		lastFail := time.Unix(0, r.lastFailure.Load())
		if time.Since(lastFail) < circuitBreakerCooldown(r.consecutiveFailures.Load()) {
			return false
		}
	}
	return true
}

// RecordSuccess resets the circuit breaker for this region.
func (r *Region) RecordSuccess() {
	r.consecutiveFailures.Store(0)
	r.circuitOpen.Store(false)
}

// RecordFailure increments failure count and potentially opens the circuit.
func (r *Region) RecordFailure() {
	failures := r.consecutiveFailures.Add(1)
	r.lastFailure.Store(time.Now().UnixNano())
	if failures >= 3 {
		r.circuitOpen.Store(true)
	}
}

func circuitBreakerCooldown(failures int64) time.Duration {
	base := time.Second * 5
	// Exponential backoff capped at 5 minutes
	cooldown := base * time.Duration(1<<min(failures-3, 6))
	if cooldown > 5*time.Minute {
		cooldown = 5 * time.Minute
	}
	return cooldown
}

// MultiRegionClient routes requests across multiple regions with automatic
// failover, health-aware routing, and geopolitical risk consideration.
type MultiRegionClient struct {
	regions    []*Region
	httpClient *http.Client
	logger     *slog.Logger

	mu             sync.RWMutex
	cableStatus    map[string]bool // cable corridor → operational
	activeRegion   string
}

// MultiRegionConfig holds configuration for the multi-region client.
type MultiRegionConfig struct {
	Regions        []*Region
	HealthInterval time.Duration
	HTTPTimeout    time.Duration
	Logger         *slog.Logger
}

// NewMultiRegionClient creates a client configured for multi-region failover.
func NewMultiRegionClient(cfg MultiRegionConfig) *MultiRegionClient {
	if cfg.HealthInterval == 0 {
		cfg.HealthInterval = 10 * time.Second
	}
	if cfg.HTTPTimeout == 0 {
		cfg.HTTPTimeout = 5 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	c := &MultiRegionClient{
		regions: cfg.Regions,
		httpClient: &http.Client{
			Timeout: cfg.HTTPTimeout,
		},
		logger:      cfg.Logger,
		cableStatus: make(map[string]bool),
	}

	// Initialize all cable corridors as operational
	for _, r := range cfg.Regions {
		if r.SubmarineCableDependency != "" {
			c.cableStatus[r.SubmarineCableDependency] = true
		}
	}

	return c
}

// Start begins background health checking. Cancel the context to stop.
func (c *MultiRegionClient) Start(ctx context.Context, healthInterval time.Duration) {
	go c.healthCheckLoop(ctx, healthInterval)
}

func (c *MultiRegionClient) healthCheckLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.checkAllRegions(ctx)
		}
	}
}

func (c *MultiRegionClient) checkAllRegions(ctx context.Context) {
	var wg sync.WaitGroup
	for _, region := range c.regions {
		wg.Add(1)
		go func(r *Region) {
			defer wg.Done()
			c.checkRegion(ctx, r)
		}(region)
	}
	wg.Wait()
}

func (c *MultiRegionClient) checkRegion(ctx context.Context, r *Region) {
	// Skip destroyed regions permanently
	if RegionStatus(r.Status.Load()) == RegionDestroyed {
		return
	}

	healthCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(healthCtx, http.MethodGet, r.Endpoint+"/health", nil)
	if err != nil {
		c.logger.Error("failed to create health request",
			"region", r.Name, "error", err)
		return
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		r.RecordFailure()
		c.logger.Warn("health check failed",
			"region", r.Name, "error", err,
			"consecutive_failures", r.consecutiveFailures.Load())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		prevStatus := RegionStatus(r.Status.Load())
		r.Status.Store(int32(RegionHealthy))
		r.RecordSuccess()
		if prevStatus != RegionHealthy {
			c.logger.Info("region recovered",
				"region", r.Name, "previous_status", prevStatus.String())
		}
	} else if resp.StatusCode == http.StatusServiceUnavailable {
		r.Status.Store(int32(RegionDegraded))
		r.RecordFailure()
		c.logger.Warn("region degraded", "region", r.Name)
	}
}

// selectRegion chooses the best available region considering health,
// priority, geopolitical risk, and cable corridor status.
func (c *MultiRegionClient) selectRegion() (*Region, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var candidates []*Region
	for _, r := range c.regions {
		if !r.IsAvailable() {
			continue
		}
		// Check cable corridor
		if r.SubmarineCableDependency != "" {
			if operational, exists := c.cableStatus[r.SubmarineCableDependency]; exists && !operational {
				continue
			}
		}
		candidates = append(candidates, r)
	}

	if len(candidates) == 0 {
		return nil, errors.New("no healthy regions available - all regions failed or circuits open")
	}

	// Sort by priority (lower = better), then by geopolitical risk
	best := candidates[0]
	for _, r := range candidates[1:] {
		if r.Priority < best.Priority {
			best = r
		} else if r.Priority == best.Priority && r.GeopoliticalRisk < best.GeopoliticalRisk {
			best = r
		}
	}

	return best, nil
}

// Do executes an HTTP request with automatic multi-region failover.
func (c *MultiRegionClient) Do(ctx context.Context, method, path string, opts ...RequestOption) (*http.Response, error) {
	var lastErr error

	// Try each available region in priority order
	tried := make(map[string]bool)
	for attempt := 0; attempt < len(c.regions); attempt++ {
		region, err := c.selectRegionExcluding(tried)
		if err != nil {
			if lastErr != nil {
				return nil, fmt.Errorf("all regions exhausted, last error: %w", lastErr)
			}
			return nil, err
		}
		tried[region.Name] = true

		url := region.Endpoint + path
		req, err := http.NewRequestWithContext(ctx, method, url, nil)
		if err != nil {
			lastErr = err
			continue
		}
		for _, opt := range opts {
			opt(req)
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			region.RecordFailure()
			lastErr = fmt.Errorf("region %s: %w", region.Name, err)
			c.logger.Warn("request failed, trying next region",
				"region", region.Name, "error", err)
			continue
		}

		if resp.StatusCode >= 500 {
			region.RecordFailure()
			resp.Body.Close()
			lastErr = fmt.Errorf("region %s: HTTP %d", region.Name, resp.StatusCode)
			c.logger.Warn("server error, trying next region",
				"region", region.Name, "status", resp.StatusCode)
			continue
		}

		region.RecordSuccess()
		return resp, nil
	}

	return nil, fmt.Errorf("all %d regions failed: %w", len(c.regions), lastErr)
}

func (c *MultiRegionClient) selectRegionExcluding(excluded map[string]bool) (*Region, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var best *Region
	for _, r := range c.regions {
		if excluded[r.Name] || !r.IsAvailable() {
			continue
		}
		if r.SubmarineCableDependency != "" {
			if operational, exists := c.cableStatus[r.SubmarineCableDependency]; exists && !operational {
				continue
			}
		}
		if best == nil || r.Priority < best.Priority {
			best = r
		}
	}

	if best == nil {
		return nil, errors.New("no regions available")
	}
	return best, nil
}

// MarkCableCorridorDown marks a submarine cable corridor as non-operational,
// causing regions that depend on it to be deprioritized.
func (c *MultiRegionClient) MarkCableCorridorDown(corridor string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cableStatus[corridor] = false
	c.logger.Warn("cable corridor marked down", "corridor", corridor)
}

// MarkRegionDestroyed permanently marks a region as destroyed (kinetic attack,
// natural disaster). The region will not be retried until manually restored.
func (c *MultiRegionClient) MarkRegionDestroyed(regionName string) {
	for _, r := range c.regions {
		if r.Name == regionName {
			r.Status.Store(int32(RegionDestroyed))
			r.circuitOpen.Store(true)
			c.logger.Error("region marked as destroyed",
				"region", regionName)
			return
		}
	}
}

// RequestOption configures an HTTP request before it is sent.
type RequestOption func(*http.Request)

// WithHeader adds a header to the request.
func WithHeader(key, value string) RequestOption {
	return func(r *http.Request) {
		r.Header.Set(key, value)
	}
}

// SetupMiddleEastClient demonstrates configuring regions with geopolitical risk.
func SetupMiddleEastClient() *MultiRegionClient {
	regions := []*Region{
		{
			Name:                     "eu-west-1",
			Endpoint:                 "https://api.eu-west-1.example.com",
			Priority:                 1, // primary after Middle East evacuation
			GeopoliticalRisk:         RiskLow,
			SubmarineCableDependency: "atlantic",
		},
		{
			Name:                     "ap-south-1",
			Endpoint:                 "https://api.ap-south-1.example.com",
			Priority:                 2,
			GeopoliticalRisk:         RiskLow,
			SubmarineCableDependency: "india-europe",
		},
		{
			Name:                     "me-central-1",
			Endpoint:                 "https://api.me-central-1.example.com",
			Priority:                 0, // normally preferred for latency
			GeopoliticalRisk:         RiskCritical,
			SubmarineCableDependency: "red-sea-hormuz",
		},
		{
			Name:                     "me-south-1",
			Endpoint:                 "https://api.me-south-1.example.com",
			Priority:                 0,
			GeopoliticalRisk:         RiskCritical,
			SubmarineCableDependency: "red-sea-hormuz",
		},
	}

	client := NewMultiRegionClient(MultiRegionConfig{
		Regions:        regions,
		HealthInterval: 10 * time.Second,
		HTTPTimeout:    5 * time.Second,
	})

	return client
}
```

### Key Lessons

**Lesson 1: Multi-AZ is not disaster recovery.** Multi-AZ protects against single facility failures. It does not
protect against coordinated regional attacks, regional natural disasters, or geopolitical events that affect all
facilities in a geographic area. True disaster recovery requires multi-region, and for the highest tier of
resilience, multi-provider or multi-continent deployments.

**Lesson 2: Submarine cable dependencies are a hidden single point of failure.** The Middle East incident was
compounded by the fact that submarine cables through the Red Sea and Strait of Hormuz were already degraded or
severed. Your region failover is useless if the network path to the failover region also fails. Understand the
physical network topology connecting your regions.

**Lesson 3: Geopolitical risk must be part of infrastructure planning.** As Cisco's Nik Kale stated: "If your
disaster recovery plan doesn't account for the possibility that an entire geographic region becomes operationally
hostile overnight, you don't have a disaster recovery plan." This is not paranoia - it happened.

**Lesson 4: Recovery time for physical damage is measured in weeks, not minutes.** Software failures are typically
resolved in hours. Hardware replacement after kinetic damage requires procurement, shipping, installation, and
validation. AWS advised customers to migrate to alternate regions because recovery was not possible on any
reasonable timeline.

### Junior → FAANG: Multi-Region Failover as a System Design Topic

The multi-region client implementation in this section is a condensed version of what FAANG system design interviews probe with "design a globally available service." Know the four components: health checking, circuit breaking, priority-based routing, and automatic failover. You do not need to know the geopolitical risk dimension for an interview, but the circuit breaker and health check patterns are expected knowledge at any level above entry. Describe the exponential backoff in the circuit breaker cooldown: "the cooldown grows with the failure count so a permanently failed region does not consume health-check resources at the same rate as a transiently failed one."

### Senior @ FAANG: Infrastructure Resilience as an ADR

At L6, the decision to go multi-region versus multi-AZ is an architectural decision that belongs in an ADR with quantified trade-offs. The additional cost of multi-region (data replication lag, cross-region bandwidth costs, complexity of active-active versus active-passive) must be weighed against the additional availability guarantee. For most consumer-facing services, the tail of the risk distribution (a kinetic strike, a regional power outage, a geopolitically-forced evacuation) is improbable but not impossible. The ADR documents the decision and the risk tolerance explicitly, so that when a future engineer proposes cutting costs by eliminating the secondary region, the reasoning is on record.

The submarine cable dependency is a real architectural concern that most engineers have never mapped. At staff level, you should know which submarine cable corridors your primary cloud regions depend on, and whether your multi-region failover architecture assumes that the network path to the failover region is independent of the network path to the primary region. In the Middle East case, they were not independent.

---
