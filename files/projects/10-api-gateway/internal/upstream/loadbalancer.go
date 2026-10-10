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
