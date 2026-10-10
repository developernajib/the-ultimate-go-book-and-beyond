## Part 4: Load Balancing and Upstreams

Load balancing is how the gateway distributes incoming requests across multiple instances of the same backend service. Instead of sending all traffic to a single server (which would create a bottleneck and a single point of failure), a load balancer spreads the work evenly so that no one server gets overwhelmed. In this section, we implement several load balancing algorithms, round-robin, weighted random, least connections, IP hash, and consistent hashing, each suited for different use cases. We also build a health check system that periodically pings each backend server to make sure it is still alive, automatically removing unhealthy servers from the pool.

### Load Balancer Interface
Load balancing distributes requests across healthy upstream instances using pluggable strategies: round-robin, least-connections, or consistent hashing. The upstream manager tracks instance health through active probes and passive failure counting, removing unhealthy hosts from rotation automatically.

```go
// internal/upstream/loadbalancer.go
package upstream

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"
)

// LoadBalancer selects a target from an upstream
type LoadBalancer interface {
    // Select chooses a target for the request
    Select(ctx context.Context, targets []*Target) (*Target, error)

    // Update is called after a request completes
    Update(target *Target, success bool)
}

// RoundRobinBalancer implements round-robin load balancing
type RoundRobinBalancer struct {
    counter uint64
}

func NewRoundRobinBalancer() *RoundRobinBalancer {
    return &RoundRobinBalancer{}
}

func (b *RoundRobinBalancer) Select(ctx context.Context, targets []*Target) (*Target, error) {
    if len(targets) == 0 {
        return nil, fmt.Errorf("no targets available")
    }

    // Filter healthy targets
    healthy := filterHealthy(targets)
    if len(healthy) == 0 {
        return nil, fmt.Errorf("no healthy targets available")
    }

    idx := atomic.AddUint64(&b.counter, 1)
    return healthy[idx%uint64(len(healthy))], nil
}

func (b *RoundRobinBalancer) Update(target *Target, success bool) {
    // No state to update for round-robin
}

// LeastConnectionBalancer selects the target with fewest active connections
type LeastConnectionBalancer struct {
    connections sync.Map // target ID -> connection count
}

func NewLeastConnectionBalancer() *LeastConnectionBalancer {
    return &LeastConnectionBalancer{}
}

func (b *LeastConnectionBalancer) Select(ctx context.Context, targets []*Target) (*Target, error) {
    if len(targets) == 0 {
        return nil, fmt.Errorf("no targets available")
    }

    healthy := filterHealthy(targets)
    if len(healthy) == 0 {
        return nil, fmt.Errorf("no healthy targets available")
    }

    var selected *Target
    minConnections := int64(-1)

    for _, target := range healthy {
        count := b.getConnections(target.ID)
        if minConnections == -1 || count < minConnections {
            minConnections = count
            selected = target
        }
    }

    // Increment connection count
    b.incrementConnections(selected.ID)

    return selected, nil
}

func (b *LeastConnectionBalancer) Update(target *Target, success bool) {
    b.decrementConnections(target.ID)
}

func (b *LeastConnectionBalancer) getConnections(targetID string) int64 {
    val, _ := b.connections.LoadOrStore(targetID, new(int64))
    return atomic.LoadInt64(val.(*int64))
}

func (b *LeastConnectionBalancer) incrementConnections(targetID string) {
    val, _ := b.connections.LoadOrStore(targetID, new(int64))
    atomic.AddInt64(val.(*int64), 1)
}

func (b *LeastConnectionBalancer) decrementConnections(targetID string) {
    val, _ := b.connections.LoadOrStore(targetID, new(int64))
    atomic.AddInt64(val.(*int64), -1)
}

// WeightedRandomBalancer selects targets based on weights
type WeightedRandomBalancer struct {
    rng *lockedRand
}

func NewWeightedRandomBalancer() *WeightedRandomBalancer {
    return &WeightedRandomBalancer{
        rng: newLockedRand(),
    }
}

func (b *WeightedRandomBalancer) Select(ctx context.Context, targets []*Target) (*Target, error) {
    if len(targets) == 0 {
        return nil, fmt.Errorf("no targets available")
    }

    healthy := filterHealthy(targets)
    if len(healthy) == 0 {
        return nil, fmt.Errorf("no healthy targets available")
    }

    // Calculate total weight
    totalWeight := 0
    for _, target := range healthy {
        totalWeight += target.Weight
    }

    if totalWeight == 0 {
        // All weights are 0, use uniform distribution
        return healthy[b.rng.Intn(len(healthy))], nil
    }

    // Select based on weight
    r := b.rng.Intn(totalWeight)
    sum := 0
    for _, target := range healthy {
        sum += target.Weight
        if r < sum {
            return target, nil
        }
    }

    // Fallback (shouldn't reach here)
    return healthy[len(healthy)-1], nil
}

func (b *WeightedRandomBalancer) Update(target *Target, success bool) {
    // No state to update
}

// IPHashBalancer uses consistent hashing based on client IP
type IPHashBalancer struct {
    ring *ConsistentHashRing
}

func NewIPHashBalancer() *IPHashBalancer {
    return &IPHashBalancer{
        ring: NewConsistentHashRing(100), // 100 virtual nodes per target
    }
}

func (b *IPHashBalancer) Select(ctx context.Context, targets []*Target) (*Target, error) {
    if len(targets) == 0 {
        return nil, fmt.Errorf("no targets available")
    }

    healthy := filterHealthy(targets)
    if len(healthy) == 0 {
        return nil, fmt.Errorf("no healthy targets available")
    }

    // Update ring with current healthy targets
    b.ring.Clear()
    for _, target := range healthy {
        b.ring.Add(target.ID, target)
    }

    // Get client IP from context
    clientIP := getClientIP(ctx)
    if clientIP == "" {
        // Fallback to round-robin if no IP
        return healthy[0], nil
    }

    node, ok := b.ring.Get(clientIP)
    if !ok {
        return healthy[0], nil
    }

    return node.(*Target), nil
}

func (b *IPHashBalancer) Update(target *Target, success bool) {
    // No state to update
}

func filterHealthy(targets []*Target) []*Target {
    healthy := make([]*Target, 0, len(targets))
    for _, target := range targets {
        if target.IsHealthy() {
            healthy = append(healthy, target)
        }
    }
    return healthy
}

func getClientIP(ctx context.Context) string {
    // Extract from context (set by middleware)
    if ip, ok := ctx.Value("client_ip").(string); ok {
        return ip
    }
    return ""
}
```

### Consistent Hashing Implementation

Consistent hashing maps keys to cache nodes such that only 1/n of keys must be remapped when a node joins or leaves an n-node cluster. Virtual nodes compensate for non-uniform hash distribution by assigning each physical node multiple positions on the ring.

```go
// internal/upstream/consistent_hash.go
package upstream

import (
    "hash/crc32"
    "sort"
    "sync"
)

// ConsistentHashRing implements consistent hashing
type ConsistentHashRing struct {
    mu             sync.RWMutex
    replicas       int
    keys           []uint32
    ring           map[uint32]any
}

// NewConsistentHashRing creates a new consistent hash ring
func NewConsistentHashRing(replicas int) *ConsistentHashRing {
    return &ConsistentHashRing{
        replicas: replicas,
        ring:     make(map[uint32]any),
    }
}

// Add adds a node to the ring
func (h *ConsistentHashRing) Add(key string, value any) {
    h.mu.Lock()
    defer h.mu.Unlock()

    for i := 0; i < h.replicas; i++ {
        virtualKey := hash(key + string(rune(i)))
        h.keys = append(h.keys, virtualKey)
        h.ring[virtualKey] = value
    }

    sort.Slice(h.keys, func(i, j int) bool {
        return h.keys[i] < h.keys[j]
    })
}

// Remove removes a node from the ring
func (h *ConsistentHashRing) Remove(key string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    for i := 0; i < h.replicas; i++ {
        virtualKey := hash(key + string(rune(i)))
        idx := sort.Search(len(h.keys), func(i int) bool {
            return h.keys[i] >= virtualKey
        })

        if idx < len(h.keys) && h.keys[idx] == virtualKey {
            h.keys = append(h.keys[:idx], h.keys[idx+1:]...)
        }

        delete(h.ring, virtualKey)
    }
}

// Get returns the node for the given key
func (h *ConsistentHashRing) Get(key string) (any, bool) {
    h.mu.RLock()
    defer h.mu.RUnlock()

    if len(h.keys) == 0 {
        return nil, false
    }

    hashKey := hash(key)
    idx := sort.Search(len(h.keys), func(i int) bool {
        return h.keys[i] >= hashKey
    })

    if idx == len(h.keys) {
        idx = 0
    }

    return h.ring[h.keys[idx]], true
}

// Clear removes all nodes from the ring
func (h *ConsistentHashRing) Clear() {
    h.mu.Lock()
    defer h.mu.Unlock()

    h.keys = nil
    h.ring = make(map[uint32]any)
}

func hash(key string) uint32 {
    return crc32.ChecksumIEEE([]byte(key))
}
```

### Upstream Manager

Load balancing distributes requests across healthy upstream instances using pluggable strategies: round-robin, least-connections, or consistent hashing. The upstream manager tracks instance health through active probes and passive failure counting, removing unhealthy hosts from rotation automatically.

```go
// internal/upstream/upstream.go
package upstream

import (
    "context"
    "fmt"
    "net/http"
    "net/http/httputil"
    "net/url"
    "sync"
    "sync/atomic"
    "time"

    "github.com/yourusername/gatewaygo/internal/gateway"
)

// Target alias
type Target = gateway.Target

// TargetState holds runtime state for a target
type TargetState struct {
    *Target
    healthy         atomic.Bool
    consecutiveFails atomic.Int32
    consecutiveSuccs atomic.Int32
    lastChecked     atomic.Value // time.Time
}

func NewTargetState(target *Target) *TargetState {
    ts := &TargetState{
        Target: target,
    }
    ts.healthy.Store(true)
    ts.lastChecked.Store(time.Now())
    return ts
}

func (ts *TargetState) IsHealthy() bool {
    return ts.healthy.Load()
}

func (ts *TargetState) SetHealthy(healthy bool) {
    ts.healthy.Store(healthy)
}

func (ts *TargetState) URL() string {
    return fmt.Sprintf("http://%s:%d", ts.Host, ts.Port)
}

// Upstream alias
type Upstream = gateway.Upstream

// UpstreamState holds runtime state for an upstream
type UpstreamState struct {
    *Upstream
    targets      []*TargetState
    loadBalancer LoadBalancer
    reverseProxy *httputil.ReverseProxy
    healthChecker *HealthChecker
}

// Manager manages upstreams and their targets
type Manager struct {
    mu        sync.RWMutex
    upstreams map[string]*UpstreamState
}

// NewManager creates a new upstream manager
func NewManager() *Manager {
    return &Manager{
        upstreams: make(map[string]*UpstreamState),
    }
}

// AddUpstream adds an upstream
func (m *Manager) AddUpstream(upstream *Upstream) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    if _, exists := m.upstreams[upstream.ID]; exists {
        return fmt.Errorf("upstream %s already exists", upstream.ID)
    }

    state, err := m.createUpstreamState(upstream)
    if err != nil {
        return fmt.Errorf("create upstream state: %w", err)
    }

    m.upstreams[upstream.ID] = state

    // Start health checker if enabled
    if upstream.HealthCheck != nil && upstream.HealthCheck.Enabled {
        state.healthChecker.Start()
    }

    return nil
}

// RemoveUpstream removes an upstream
func (m *Manager) RemoveUpstream(upstreamID string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    state, exists := m.upstreams[upstreamID]
    if !exists {
        return fmt.Errorf("upstream %s not found", upstreamID)
    }

    // Stop health checker
    if state.healthChecker != nil {
        state.healthChecker.Stop()
    }

    delete(m.upstreams, upstreamID)
    return nil
}

// GetUpstream returns an upstream by ID
func (m *Manager) GetUpstream(upstreamID string) (*UpstreamState, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    state, exists := m.upstreams[upstreamID]
    if !exists {
        return nil, fmt.Errorf("upstream %s not found", upstreamID)
    }

    return state, nil
}

// SelectTarget selects a target from the upstream using load balancing
func (m *Manager) SelectTarget(ctx context.Context, upstreamID string) (*TargetState, error) {
    state, err := m.GetUpstream(upstreamID)
    if err != nil {
        return nil, err
    }

    // Convert to []*Target for load balancer
    targets := make([]*Target, len(state.targets))
    for i, ts := range state.targets {
        // Wrap TargetState to implement IsHealthy()
        targets[i] = &Target{
            ID:       ts.ID,
            Host:     ts.Host,
            Port:     ts.Port,
            Weight:   ts.Weight,
            Metadata: ts.Metadata,
        }
        // Copy health status
        if ts.IsHealthy() {
            targets[i].Metadata["healthy"] = "true"
        }
    }

    target, err := state.loadBalancer.Select(ctx, targets)
    if err != nil {
        return nil, err
    }

    // Find corresponding TargetState
    for _, ts := range state.targets {
        if ts.ID == target.ID {
            return ts, nil
        }
    }

    return nil, fmt.Errorf("target state not found")
}

func (m *Manager) createUpstreamState(upstream *Upstream) (*UpstreamState, error) {
    // Create target states
    targets := make([]*TargetState, len(upstream.Targets))
    for i, target := range upstream.Targets {
        targets[i] = NewTargetState(&target)
    }

    // Create load balancer
    var lb LoadBalancer
    switch upstream.LoadBalanceType {
    case gateway.LoadBalanceRoundRobin:
        lb = NewRoundRobinBalancer()
    case gateway.LoadBalanceLeastConnection:
        lb = NewLeastConnectionBalancer()
    case gateway.LoadBalanceWeightedRandom:
        lb = NewWeightedRandomBalancer()
    case gateway.LoadBalanceIPHash, gateway.LoadBalanceConsistentHash:
        lb = NewIPHashBalancer()
    default:
        lb = NewRoundRobinBalancer()
    }

    state := &UpstreamState{
        Upstream:     upstream,
        targets:      targets,
        loadBalancer: lb,
    }

    // Create health checker
    if upstream.HealthCheck != nil && upstream.HealthCheck.Enabled {
        state.healthChecker = NewHealthChecker(upstream.HealthCheck, targets)
    }

    return state, nil
}

// Helper for Target to check health
func (t *Target) IsHealthy() bool {
    if t.Metadata == nil {
        return true
    }
    return t.Metadata["healthy"] == "true"
}
```

### Health Checker

The health checker periodically probes each upstream target and marks it healthy or unhealthy based on HTTP response status. The load balancer skips unhealthy targets until they pass health checks again.

```go
// internal/upstream/healthcheck.go
package upstream

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/yourusername/gatewaygo/internal/gateway"
    "go.uber.org/zap"
)

// HealthChecker performs health checks on targets
type HealthChecker struct {
    config    *gateway.HealthCheck
    targets   []*TargetState
    client    *http.Client
    stopChan  chan struct{}
    wg        sync.WaitGroup
    logger    *zap.Logger
}

// NewHealthChecker creates a new health checker
func NewHealthChecker(config *gateway.HealthCheck, targets []*TargetState) *HealthChecker {
    return &HealthChecker{
        config:   config,
        targets:  targets,
        client: &http.Client{
            Timeout: config.Timeout,
            Transport: &http.Transport{
                MaxIdleConns:        100,
                MaxIdleConnsPerHost: 10,
                IdleConnTimeout:     90 * time.Second,
            },
        },
        stopChan: make(chan struct{}),
        logger:   zap.L().Named("healthcheck"),
    }
}

// Start begins health checking
func (hc *HealthChecker) Start() {
    hc.wg.Add(1)
    go hc.run()
}

// Stop stops health checking
func (hc *HealthChecker) Stop() {
    close(hc.stopChan)
    hc.wg.Wait()
}

func (hc *HealthChecker) run() {
    defer hc.wg.Done()

    ticker := time.NewTicker(hc.config.Interval)
    defer ticker.Stop()

    // Initial check
    hc.checkAll()

    for {
        select {
        case <-ticker.C:
            hc.checkAll()
        case <-hc.stopChan:
            return
        }
    }
}

func (hc *HealthChecker) checkAll() {
    var wg sync.WaitGroup

    for _, target := range hc.targets {
        wg.Add(1)
        go func(t *TargetState) {
            defer wg.Done()
            hc.checkTarget(t)
        }(target)
    }

    wg.Wait()
}

func (hc *HealthChecker) checkTarget(target *TargetState) {
    ctx, cancel := context.WithTimeout(context.Background(), hc.config.Timeout)
    defer cancel()

    url := fmt.Sprintf("http://%s:%d%s", target.Host, target.Port, hc.config.HTTPPath)

    req, err := http.NewRequestWithContext(ctx, hc.config.HTTPMethod, url, nil)
    if err != nil {
        hc.handleFailure(target, fmt.Errorf("create request: %w", err))
        return
    }

    resp, err := hc.client.Do(req)
    if err != nil {
        hc.handleFailure(target, fmt.Errorf("send request: %w", err))
        return
    }
    defer resp.Body.Close()

    // Check status code
    if !hc.isExpectedStatus(resp.StatusCode) {
        hc.handleFailure(target, fmt.Errorf("unexpected status: %d", resp.StatusCode))
        return
    }

    hc.handleSuccess(target)
}

func (hc *HealthChecker) isExpectedStatus(status int) bool {
    for _, expected := range hc.config.ExpectedStatus {
        if status == expected {
            return true
        }
    }
    return false
}

func (hc *HealthChecker) handleSuccess(target *TargetState) {
    target.consecutiveFails.Store(0)
    succ := target.consecutiveSuccs.Add(1)

    if !target.IsHealthy() && succ >= int32(hc.config.HealthyThreshold) {
        target.SetHealthy(true)
        hc.logger.Info("target became healthy",
            zap.String("target_id", target.ID),
            zap.String("host", target.Host),
            zap.Int("port", target.Port),
        )
    }

    target.lastChecked.Store(time.Now())
}

func (hc *HealthChecker) handleFailure(target *TargetState, err error) {
    target.consecutiveSuccs.Store(0)
    fails := target.consecutiveFails.Add(1)

    if target.IsHealthy() && fails >= int32(hc.config.UnhealthyThreshold) {
        target.SetHealthy(false)
        hc.logger.Warn("target became unhealthy",
            zap.String("target_id", target.ID),
            zap.String("host", target.Host),
            zap.Int("port", target.Port),
            zap.Error(err),
        )
    }

    target.lastChecked.Store(time.Now())
}
```
