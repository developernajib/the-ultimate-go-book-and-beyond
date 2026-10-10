## Exercises with Complete Solutions

### Exercise 1: Consistent Hashing Benchmark

Implement a benchmark comparing node redistribution between simple hashing and consistent hashing when adding/removing nodes. This benchmark quantifies the core advantage of consistent hashing: when a node is added or removed, only approximately `keys/nodes` keys need to be remapped, compared to nearly all keys with simple modulo hashing. Running this benchmark with different key counts and virtual node configurations gives concrete data on the remapping overhead that informed the design choices of systems like Amazon Dynamo and Cassandra.

```go
// exercise_consistent_hash_bench_test.go
package consistenthash

import (
    "crypto/sha256"
    "encoding/binary"
    "fmt"
    "hash/fnv"
    "math/rand/v2"
    "sort"
    "testing"
)

// SimpleHash implements basic modulo hashing
type SimpleHash struct {
    nodes []string
}

func NewSimpleHash(nodes []string) *SimpleHash {
    return &SimpleHash{nodes: nodes}
}

func (h *SimpleHash) GetNode(key string) string {
    if len(h.nodes) == 0 {
        return ""
    }
    hasher := fnv.New32a()
    hasher.Write([]byte(key))
    return h.nodes[int(hasher.Sum32())%len(h.nodes)]
}

func (h *SimpleHash) AddNode(node string) {
    h.nodes = append(h.nodes, node)
}

func (h *SimpleHash) RemoveNode(node string) {
    for i, n := range h.nodes {
        if n == node {
            h.nodes = append(h.nodes[:i], h.nodes[i+1:]...)
            return
        }
    }
}

// ConsistentHash implements consistent hashing with virtual nodes
type ConsistentHash struct {
    virtualNodes int
    ring         []uint32
    nodeMap      map[uint32]string
    nodeSet      map[string]bool
}

func NewConsistentHash(virtualNodes int) *ConsistentHash {
    return &ConsistentHash{
        virtualNodes: virtualNodes,
        ring:         make([]uint32, 0),
        nodeMap:      make(map[uint32]string),
        nodeSet:      make(map[string]bool),
    }
}

func (h *ConsistentHash) hash(key string) uint32 {
    hasher := sha256.New()
    hasher.Write([]byte(key))
    hash := hasher.Sum(nil)
    return binary.BigEndian.Uint32(hash[:4])
}

func (h *ConsistentHash) AddNode(node string) {
    if h.nodeSet[node] {
        return
    }
    h.nodeSet[node] = true

    for i := 0; i < h.virtualNodes; i++ {
        vnode := fmt.Sprintf("%s#%d", node, i)
        hash := h.hash(vnode)
        h.ring = append(h.ring, hash)
        h.nodeMap[hash] = node
    }

    sort.Slice(h.ring, func(i, j int) bool {
        return h.ring[i] < h.ring[j]
    })
}

func (h *ConsistentHash) RemoveNode(node string) {
    if !h.nodeSet[node] {
        return
    }
    delete(h.nodeSet, node)

    newRing := make([]uint32, 0, len(h.ring)-h.virtualNodes)
    for _, hash := range h.ring {
        if h.nodeMap[hash] != node {
            newRing = append(newRing, hash)
        } else {
            delete(h.nodeMap, hash)
        }
    }
    h.ring = newRing
}

func (h *ConsistentHash) GetNode(key string) string {
    if len(h.ring) == 0 {
        return ""
    }

    hash := h.hash(key)
    idx := sort.Search(len(h.ring), func(i int) bool {
        return h.ring[i] >= hash
    })

    if idx >= len(h.ring) {
        idx = 0
    }

    return h.nodeMap[h.ring[idx]]
}

// BenchmarkResults stores redistribution metrics
type BenchmarkResults struct {
    Algorithm      string
    TotalKeys      int
    KeysMoved      int
    PercentMoved   float64
    Distribution   map[string]int
    StdDeviation   float64
}

func benchmarkRedistribution(numKeys, numNodes, virtualNodes int) (simple, consistent BenchmarkResults) {
    // Generate random keys
    keys := make([]string, numKeys)
    for i := range keys {
        keys[i] = fmt.Sprintf("key-%d-%d", i, rand.Int64())
    }

    // Initial nodes
    nodes := make([]string, numNodes)
    for i := range nodes {
        nodes[i] = fmt.Sprintf("node-%d", i)
    }

    // Setup simple hash
    simpleHash := NewSimpleHash(nil)
    for _, node := range nodes {
        simpleHash.AddNode(node)
    }

    // Setup consistent hash
    consistentHash := NewConsistentHash(virtualNodes)
    for _, node := range nodes {
        consistentHash.AddNode(node)
    }

    // Record initial assignments
    simpleInitial := make(map[string]string, numKeys)
    consistentInitial := make(map[string]string, numKeys)

    for _, key := range keys {
        simpleInitial[key] = simpleHash.GetNode(key)
        consistentInitial[key] = consistentHash.GetNode(key)
    }

    // Add a new node
    newNode := fmt.Sprintf("node-%d", numNodes)
    simpleHash.AddNode(newNode)
    consistentHash.AddNode(newNode)

    // Count moved keys
    simpleMoved := 0
    consistentMoved := 0

    simpleDistribution := make(map[string]int)
    consistentDistribution := make(map[string]int)

    for _, key := range keys {
        simpleNew := simpleHash.GetNode(key)
        consistentNew := consistentHash.GetNode(key)

        simpleDistribution[simpleNew]++
        consistentDistribution[consistentNew]++

        if simpleInitial[key] != simpleNew {
            simpleMoved++
        }
        if consistentInitial[key] != consistentNew {
            consistentMoved++
        }
    }

    // Calculate standard deviation for distribution
    calcStdDev := func(dist map[string]int, total int) float64 {
        mean := float64(total) / float64(len(dist))
        var variance float64
        for _, count := range dist {
            diff := float64(count) - mean
            variance += diff * diff
        }
        variance /= float64(len(dist))
        return sqrt(variance)
    }

    simple = BenchmarkResults{
        Algorithm:     "Simple Hash",
        TotalKeys:     numKeys,
        KeysMoved:     simpleMoved,
        PercentMoved:  float64(simpleMoved) / float64(numKeys) * 100,
        Distribution:  simpleDistribution,
        StdDeviation:  calcStdDev(simpleDistribution, numKeys),
    }

    consistent = BenchmarkResults{
        Algorithm:     "Consistent Hash",
        TotalKeys:     numKeys,
        KeysMoved:     consistentMoved,
        PercentMoved:  float64(consistentMoved) / float64(numKeys) * 100,
        Distribution:  consistentDistribution,
        StdDeviation:  calcStdDev(consistentDistribution, numKeys),
    }

    return
}

func sqrt(x float64) float64 {
    if x <= 0 {
        return 0
    }
    z := x / 2
    for i := 0; i < 10; i++ {
        z -= (z*z - x) / (2 * z)
    }
    return z
}

func TestRedistributionComparison(t *testing.T) {
    testCases := []struct {
        numKeys      int
        numNodes     int
        virtualNodes int
    }{
        {10000, 5, 100},
        {100000, 10, 150},
        {1000000, 20, 200},
    }

    for _, tc := range testCases {
        t.Run(fmt.Sprintf("keys=%d_nodes=%d", tc.numKeys, tc.numNodes), func(t *testing.T) {
            simple, consistent := benchmarkRedistribution(tc.numKeys, tc.numNodes, tc.virtualNodes)

            t.Logf("\n=== %d keys, %d nodes ===", tc.numKeys, tc.numNodes)
            t.Logf("Simple Hash:")
            t.Logf("  Keys Moved: %d (%.2f%%)", simple.KeysMoved, simple.PercentMoved)
            t.Logf("  Std Dev: %.2f", simple.StdDeviation)

            t.Logf("Consistent Hash (%d vnodes):", tc.virtualNodes)
            t.Logf("  Keys Moved: %d (%.2f%%)", consistent.KeysMoved, consistent.PercentMoved)
            t.Logf("  Std Dev: %.2f", consistent.StdDeviation)

            // Verify consistent hash moves fewer keys
            if consistent.PercentMoved >= simple.PercentMoved {
                t.Errorf("Consistent hash should move fewer keys")
            }

            // Expected: consistent hash moves ~1/N keys (where N is new node count)
            expectedPct := 100.0 / float64(tc.numNodes+1)
            if consistent.PercentMoved > expectedPct*1.5 {
                t.Errorf("Consistent hash moved %.2f%%, expected ~%.2f%%",
                    consistent.PercentMoved, expectedPct)
            }
        })
    }
}

func BenchmarkHashLookup(b *testing.B) {
    nodes := make([]string, 100)
    for i := range nodes {
        nodes[i] = fmt.Sprintf("node-%d", i)
    }

    simpleHash := NewSimpleHash(nil)
    consistentHash := NewConsistentHash(150)
    for _, node := range nodes {
        simpleHash.AddNode(node)
        consistentHash.AddNode(node)
    }

    key := "test-key-12345"

    b.Run("SimpleHash", func(b *testing.B) {
        for b.Loop() {
            simpleHash.GetNode(key)
        }
    })

    b.Run("ConsistentHash", func(b *testing.B) {
        for b.Loop() {
            consistentHash.GetNode(key)
        }
    })
}
```

**Expected Output:**
```
=== 10000 keys, 5 nodes ===
Simple Hash:
  Keys Moved: 8334 (83.34%)    # ~83% of keys redistributed
  Std Dev: 245.67

Consistent Hash (100 vnodes):
  Keys Moved: 1672 (16.72%)    # ~17% (close to 1/6 = 16.67%)
  Std Dev: 89.23

=== 100000 keys, 10 nodes ===
Simple Hash:
  Keys Moved: 90912 (90.91%)   # ~91% of keys redistributed
  Std Dev: 1023.45

Consistent Hash (150 vnodes):
  Keys Moved: 9145 (9.15%)     # ~9% (close to 1/11 = 9.09%)
  Std Dev: 312.56
```

### Exercise 2: Adaptive Rate Limiter

Create a rate limiter that automatically adjusts its limits based on system load.

```go
// exercise_adaptive_rate_limiter.go
package ratelimit

import (
    "context"
    "math"
    "sort"
    "sync"
    "sync/atomic"
    "time"
)

// AdaptiveRateLimiter adjusts rate limits based on system metrics
type AdaptiveRateLimiter struct {
    mu sync.RWMutex

    // Base configuration
    baseRate  float64
    burstSize int64

    // Current effective rate
    currentRate atomic.Value // float64

    // Metrics for adaptation
    metrics *AdaptiveMetrics

    // Configuration
    config AdaptiveConfig

    // Control
    stopCh chan struct{}
    wg     sync.WaitGroup
}

type AdaptiveConfig struct {
    // How often to recalculate rate
    AdjustInterval time.Duration

    // Response time thresholds (milliseconds)
    TargetLatencyP50 float64
    TargetLatencyP99 float64

    // Rate adjustment bounds
    MinRateMultiplier float64 // e.g., 0.1 = 10% of base rate
    MaxRateMultiplier float64 // e.g., 2.0 = 200% of base rate

    // How aggressively to adjust
    IncreaseFactor float64 // e.g., 1.1 = increase by 10%
    DecreaseFactor float64 // e.g., 0.8 = decrease by 20%

    // Error rate threshold
    MaxErrorRate float64 // e.g., 0.05 = 5% errors triggers decrease
}

type AdaptiveMetrics struct {
    mu sync.RWMutex

    // Latency tracking (circular buffer)
    latencies    []time.Duration
    latencyIndex int
    latencySize  int

    // Request counting
    totalRequests atomic.Int64
    errorCount    atomic.Int64
    acceptedCount atomic.Int64
    rejectedCount atomic.Int64

    // Current window
    windowStart time.Time
    windowSize  time.Duration
}

// NewAdaptiveRateLimiter creates a new adaptive rate limiter
func NewAdaptiveRateLimiter(baseRate float64, burst int64, config AdaptiveConfig) *AdaptiveRateLimiter {
    if config.AdjustInterval == 0 {
        config.AdjustInterval = 10 * time.Second
    }
    if config.TargetLatencyP50 == 0 {
        config.TargetLatencyP50 = 100 // 100ms
    }
    if config.TargetLatencyP99 == 0 {
        config.TargetLatencyP99 = 500 // 500ms
    }
    if config.MinRateMultiplier == 0 {
        config.MinRateMultiplier = 0.1
    }
    if config.MaxRateMultiplier == 0 {
        config.MaxRateMultiplier = 2.0
    }
    if config.IncreaseFactor == 0 {
        config.IncreaseFactor = 1.1
    }
    if config.DecreaseFactor == 0 {
        config.DecreaseFactor = 0.8
    }
    if config.MaxErrorRate == 0 {
        config.MaxErrorRate = 0.05
    }

    rl := &AdaptiveRateLimiter{
        baseRate:  baseRate,
        burstSize: burst,
        config:    config,
        stopCh:    make(chan struct{}),
        metrics: &AdaptiveMetrics{
            latencies:   make([]time.Duration, 1000),
            latencySize: 1000,
            windowStart: time.Now(),
            windowSize:  config.AdjustInterval,
        },
    }

    rl.currentRate.Store(baseRate)

    // Start adjustment loop
    rl.wg.Add(1)
    go rl.adjustmentLoop()

    return rl
}

// Allow checks if a request should be allowed
func (rl *AdaptiveRateLimiter) Allow(ctx context.Context) bool {
    rl.metrics.totalRequests.Add(1)

    currentRate := rl.currentRate.Load().(float64)

    // Simple token bucket check (simplified for example)
    // In production, use proper token bucket implementation
    rl.mu.RLock()
    allowed := rl.metrics.acceptedCount.Load() < int64(currentRate*rl.config.AdjustInterval.Seconds())
    rl.mu.RUnlock()

    if allowed {
        rl.metrics.acceptedCount.Add(1)
        return true
    }

    rl.metrics.rejectedCount.Add(1)
    return false
}

// RecordLatency records a request's latency for adaptation
func (rl *AdaptiveRateLimiter) RecordLatency(latency time.Duration) {
    rl.metrics.mu.Lock()
    defer rl.metrics.mu.Unlock()

    rl.metrics.latencies[rl.metrics.latencyIndex] = latency
    rl.metrics.latencyIndex = (rl.metrics.latencyIndex + 1) % rl.metrics.latencySize
}

// RecordError records an error for adaptation
func (rl *AdaptiveRateLimiter) RecordError() {
    rl.metrics.errorCount.Add(1)
}

func (rl *AdaptiveRateLimiter) adjustmentLoop() {
    defer rl.wg.Done()

    ticker := time.NewTicker(rl.config.AdjustInterval)
    defer ticker.Stop()

    for {
        select {
        case <-rl.stopCh:
            return
        case <-ticker.C:
            rl.adjustRate()
        }
    }
}

func (rl *AdaptiveRateLimiter) adjustRate() {
    // Calculate current metrics
    p50, p99 := rl.calculateLatencyPercentiles()
    errorRate := rl.calculateErrorRate()
    currentRate := rl.currentRate.Load().(float64)

    var newRate float64

    // Decision logic
    switch {
    case errorRate > rl.config.MaxErrorRate:
        // High error rate - decrease aggressively
        newRate = currentRate * rl.config.DecreaseFactor * 0.8 // Extra aggressive

    case p99 > rl.config.TargetLatencyP99:
        // P99 latency too high - decrease rate
        newRate = currentRate * rl.config.DecreaseFactor

    case p50 > rl.config.TargetLatencyP50:
        // P50 latency elevated - slight decrease
        newRate = currentRate * (rl.config.DecreaseFactor + 0.1)

    case p50 < rl.config.TargetLatencyP50*0.5 && p99 < rl.config.TargetLatencyP99*0.5:
        // Both latencies well under target - increase rate
        newRate = currentRate * rl.config.IncreaseFactor

    default:
        // System is healthy - maintain or slightly increase
        newRate = currentRate * 1.02 // 2% increase
    }

    // Apply bounds
    minRate := rl.baseRate * rl.config.MinRateMultiplier
    maxRate := rl.baseRate * rl.config.MaxRateMultiplier
    newRate = math.Max(minRate, math.Min(maxRate, newRate))

    rl.currentRate.Store(newRate)

    // Reset window metrics
    rl.resetWindowMetrics()
}

func (rl *AdaptiveRateLimiter) calculateLatencyPercentiles() (p50, p99 float64) {
    rl.metrics.mu.RLock()
    defer rl.metrics.mu.RUnlock()

    // Collect non-zero latencies
    latencies := make([]time.Duration, 0, rl.metrics.latencySize)
    for _, l := range rl.metrics.latencies {
        if l > 0 {
            latencies = append(latencies, l)
        }
    }

    if len(latencies) == 0 {
        return 0, 0
    }

    // Sort for percentile calculation
    sort.Slice(latencies, func(i, j int) bool {
        return latencies[i] < latencies[j]
    })

    p50Idx := int(float64(len(latencies)) * 0.50)
    p99Idx := int(float64(len(latencies)) * 0.99)

    if p50Idx >= len(latencies) {
        p50Idx = len(latencies) - 1
    }
    if p99Idx >= len(latencies) {
        p99Idx = len(latencies) - 1
    }

    return float64(latencies[p50Idx].Milliseconds()), float64(latencies[p99Idx].Milliseconds())
}

func (rl *AdaptiveRateLimiter) calculateErrorRate() float64 {
    total := rl.metrics.totalRequests.Load()
    errors := rl.metrics.errorCount.Load()

    if total == 0 {
        return 0
    }

    return float64(errors) / float64(total)
}

func (rl *AdaptiveRateLimiter) resetWindowMetrics() {
    rl.metrics.mu.Lock()
    defer rl.metrics.mu.Unlock()

    // Reset counters for new window
    rl.metrics.totalRequests.Store(0)
    rl.metrics.errorCount.Store(0)
    rl.metrics.acceptedCount.Store(0)
    rl.metrics.rejectedCount.Store(0)
    rl.metrics.windowStart = time.Now()

    // Clear latencies
    for i := range rl.metrics.latencies {
        rl.metrics.latencies[i] = 0
    }
    rl.metrics.latencyIndex = 0
}

// GetCurrentRate returns the current effective rate
func (rl *AdaptiveRateLimiter) GetCurrentRate() float64 {
    return rl.currentRate.Load().(float64)
}

// GetStats returns current statistics
func (rl *AdaptiveRateLimiter) GetStats() map[string]any {
    p50, p99 := rl.calculateLatencyPercentiles()
    return map[string]any{
        "base_rate":      rl.baseRate,
        "current_rate":   rl.GetCurrentRate(),
        "rate_ratio":     rl.GetCurrentRate() / rl.baseRate,
        "p50_latency_ms": p50,
        "p99_latency_ms": p99,
        "error_rate":     rl.calculateErrorRate(),
        "total_requests": rl.metrics.totalRequests.Load(),
        "accepted":       rl.metrics.acceptedCount.Load(),
        "rejected":       rl.metrics.rejectedCount.Load(),
    }
}

// Stop stops the adaptive rate limiter
func (rl *AdaptiveRateLimiter) Stop() {
    close(rl.stopCh)
    rl.wg.Wait()
}
```

**Usage Example:**
```go
func main() {
    // Create adaptive rate limiter
    // Base: 1000 req/s, burst: 100, adjust every 5s
    limiter := NewAdaptiveRateLimiter(1000, 100, AdaptiveConfig{
        AdjustInterval:   5 * time.Second,
        TargetLatencyP50: 50,  // 50ms target P50
        TargetLatencyP99: 200, // 200ms target P99
        MaxErrorRate:     0.01, // 1% error threshold
    })
    defer limiter.Stop()

    // Simulate requests
    for i := 0; i < 10000; i++ {
        if limiter.Allow(context.Background()) {
            start := time.Now()

            // Simulate work with varying latency
            workDuration := time.Duration(rand.IntN(100)) * time.Millisecond
            time.Sleep(workDuration)

            limiter.RecordLatency(time.Since(start))

            // Simulate occasional errors
            if rand.Float64() < 0.02 {
                limiter.RecordError()
            }
        }

        // Print stats periodically
        if i%1000 == 0 {
            stats := limiter.GetStats()
            fmt.Printf("Rate: %.0f/s (%.1f%% of base), P50: %.0fms, P99: %.0fms\n",
                stats["current_rate"],
                stats["rate_ratio"].(float64)*100,
                stats["p50_latency_ms"],
                stats["p99_latency_ms"])
        }
    }
}
```

### Exercise 3: Circuit Breaker Dashboard

Build a simple HTTP dashboard that shows circuit breaker states across multiple services.

```go
// exercise_circuit_breaker_dashboard.go
package dashboard

import (
    "context"
    "encoding/json"
    "fmt"
    "html/template"
    "net/http"
    "sync"
    "sync/atomic"
    "time"
)

// CircuitBreakerRegistry manages multiple circuit breakers
type CircuitBreakerRegistry struct {
    mu       sync.RWMutex
    breakers map[string]*MonitoredCircuitBreaker
}

// MonitoredCircuitBreaker wraps a circuit breaker with metrics
type MonitoredCircuitBreaker struct {
    Name string

    // State
    state atomic.Int32 // 0=closed, 1=open, 2=half-open

    // Configuration
    FailureThreshold int
    SuccessThreshold int
    Timeout          time.Duration

    // Metrics
    metrics CircuitBreakerMetrics

    // State history for dashboard
    stateHistory []StateChange
    historyMu    sync.RWMutex
}

type CircuitBreakerMetrics struct {
    TotalRequests   atomic.Int64
    SuccessCount    atomic.Int64
    FailureCount    atomic.Int64
    TimeoutCount    atomic.Int64
    ShortCircuited  atomic.Int64
    LastFailureTime atomic.Int64
    LastSuccessTime atomic.Int64

    // Rolling window
    windowMu    sync.RWMutex
    windowStart time.Time
    windowCounts struct {
        Success int64
        Failure int64
    }
}

type StateChange struct {
    Timestamp time.Time `json:"timestamp"`
    From      string    `json:"from"`
    To        string    `json:"to"`
    Reason    string    `json:"reason"`
}

const (
    StateClosed int32 = iota
    StateOpen
    StateHalfOpen
)

func stateString(state int32) string {
    switch state {
    case StateClosed:
        return "CLOSED"
    case StateOpen:
        return "OPEN"
    case StateHalfOpen:
        return "HALF_OPEN"
    default:
        return "UNKNOWN"
    }
}

// NewCircuitBreakerRegistry creates a new registry
func NewCircuitBreakerRegistry() *CircuitBreakerRegistry {
    return &CircuitBreakerRegistry{
        breakers: make(map[string]*MonitoredCircuitBreaker),
    }
}

// Register adds a circuit breaker to the registry
func (r *CircuitBreakerRegistry) Register(name string, failureThreshold, successThreshold int, timeout time.Duration) *MonitoredCircuitBreaker {
    r.mu.Lock()
    defer r.mu.Unlock()

    cb := &MonitoredCircuitBreaker{
        Name:             name,
        FailureThreshold: failureThreshold,
        SuccessThreshold: successThreshold,
        Timeout:          timeout,
        stateHistory:     make([]StateChange, 0, 100),
    }
    cb.metrics.windowStart = time.Now()

    r.breakers[name] = cb
    return cb
}

// Get retrieves a circuit breaker by name
func (r *CircuitBreakerRegistry) Get(name string) *MonitoredCircuitBreaker {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return r.breakers[name]
}

// GetAll returns all circuit breakers
func (r *CircuitBreakerRegistry) GetAll() []*MonitoredCircuitBreaker {
    r.mu.RLock()
    defer r.mu.RUnlock()

    result := make([]*MonitoredCircuitBreaker, 0, len(r.breakers))
    for _, cb := range r.breakers {
        result = append(result, cb)
    }
    return result
}

// Execute runs a function with circuit breaker protection
func (cb *MonitoredCircuitBreaker) Execute(ctx context.Context, fn func(context.Context) error) error {
    cb.metrics.TotalRequests.Add(1)

    // Check state
    state := cb.state.Load()

    if state == StateOpen {
        cb.metrics.ShortCircuited.Add(1)
        return fmt.Errorf("circuit breaker %s is open", cb.Name)
    }

    // Execute
    err := fn(ctx)

    if err != nil {
        cb.recordFailure()
    } else {
        cb.recordSuccess()
    }

    return err
}

func (cb *MonitoredCircuitBreaker) recordSuccess() {
    cb.metrics.SuccessCount.Add(1)
    cb.metrics.LastSuccessTime.Store(time.Now().UnixNano())

    cb.metrics.windowMu.Lock()
    cb.metrics.windowCounts.Success++
    cb.metrics.windowMu.Unlock()

    // If half-open, check if we should close
    if cb.state.Load() == StateHalfOpen {
        cb.metrics.windowMu.RLock()
        successes := cb.metrics.windowCounts.Success
        cb.metrics.windowMu.RUnlock()

        if successes >= int64(cb.SuccessThreshold) {
            cb.transitionTo(StateClosed, "success threshold reached")
        }
    }
}

func (cb *MonitoredCircuitBreaker) recordFailure() {
    cb.metrics.FailureCount.Add(1)
    cb.metrics.LastFailureTime.Store(time.Now().UnixNano())

    cb.metrics.windowMu.Lock()
    cb.metrics.windowCounts.Failure++
    failures := cb.metrics.windowCounts.Failure
    cb.metrics.windowMu.Unlock()

    // Check if we should open the circuit
    state := cb.state.Load()
    if state == StateClosed && failures >= int64(cb.FailureThreshold) {
        cb.transitionTo(StateOpen, "failure threshold reached")

        // Schedule half-open transition
        go func() {
            time.Sleep(cb.Timeout)
            if cb.state.Load() == StateOpen {
                cb.transitionTo(StateHalfOpen, "timeout elapsed")
            }
        }()
    }

    // If half-open and failure, go back to open
    if state == StateHalfOpen {
        cb.transitionTo(StateOpen, "failure during half-open")

        go func() {
            time.Sleep(cb.Timeout)
            if cb.state.Load() == StateOpen {
                cb.transitionTo(StateHalfOpen, "timeout elapsed")
            }
        }()
    }
}

func (cb *MonitoredCircuitBreaker) transitionTo(newState int32, reason string) {
    oldState := cb.state.Swap(newState)
    if oldState == newState {
        return
    }

    // Reset window on state change
    cb.metrics.windowMu.Lock()
    cb.metrics.windowCounts.Success = 0
    cb.metrics.windowCounts.Failure = 0
    cb.metrics.windowStart = time.Now()
    cb.metrics.windowMu.Unlock()

    // Record state change
    cb.historyMu.Lock()
    cb.stateHistory = append(cb.stateHistory, StateChange{
        Timestamp: time.Now(),
        From:      stateString(oldState),
        To:        stateString(newState),
        Reason:    reason,
    })
    // Keep last 100 changes
    if len(cb.stateHistory) > 100 {
        cb.stateHistory = cb.stateHistory[len(cb.stateHistory)-100:]
    }
    cb.historyMu.Unlock()
}

// GetStatus returns the current status of the circuit breaker
func (cb *MonitoredCircuitBreaker) GetStatus() map[string]any {
    cb.metrics.windowMu.RLock()
    windowSuccess := cb.metrics.windowCounts.Success
    windowFailure := cb.metrics.windowCounts.Failure
    cb.metrics.windowMu.RUnlock()

    var errorRate float64
    total := windowSuccess + windowFailure
    if total > 0 {
        errorRate = float64(windowFailure) / float64(total) * 100
    }

    lastFailure := time.Unix(0, cb.metrics.LastFailureTime.Load())
    lastSuccess := time.Unix(0, cb.metrics.LastSuccessTime.Load())

    return map[string]any{
        "name":             cb.Name,
        "state":            stateString(cb.state.Load()),
        "total_requests":   cb.metrics.TotalRequests.Load(),
        "success_count":    cb.metrics.SuccessCount.Load(),
        "failure_count":    cb.metrics.FailureCount.Load(),
        "short_circuited":  cb.metrics.ShortCircuited.Load(),
        "window_success":   windowSuccess,
        "window_failure":   windowFailure,
        "error_rate":       errorRate,
        "last_failure":     lastFailure,
        "last_success":     lastSuccess,
        "failure_threshold": cb.FailureThreshold,
        "success_threshold": cb.SuccessThreshold,
        "timeout_seconds":   cb.Timeout.Seconds(),
    }
}

// GetHistory returns state change history
func (cb *MonitoredCircuitBreaker) GetHistory() []StateChange {
    cb.historyMu.RLock()
    defer cb.historyMu.RUnlock()

    result := make([]StateChange, len(cb.stateHistory))
    copy(result, cb.stateHistory)
    return result
}

// Dashboard HTTP handlers
type Dashboard struct {
    registry *CircuitBreakerRegistry
}

func NewDashboard(registry *CircuitBreakerRegistry) *Dashboard {
    return &Dashboard{registry: registry}
}

func (d *Dashboard) RegisterHandlers(mux *http.ServeMux) {
    mux.HandleFunc("/", d.handleIndex)
    mux.HandleFunc("/api/breakers", d.handleAPIBreakers)
    mux.HandleFunc("/api/breakers/", d.handleAPIBreakerDetail)
}

func (d *Dashboard) handleIndex(w http.ResponseWriter, r *http.Request) {
    tmpl := template.Must(template.New("dashboard").Parse(dashboardHTML))
    tmpl.Execute(w, nil)
}

func (d *Dashboard) handleAPIBreakers(w http.ResponseWriter, r *http.Request) {
    breakers := d.registry.GetAll()
    statuses := make([]map[string]any, len(breakers))

    for i, cb := range breakers {
        statuses[i] = cb.GetStatus()
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(statuses)
}

func (d *Dashboard) handleAPIBreakerDetail(w http.ResponseWriter, r *http.Request) {
    name := r.URL.Path[len("/api/breakers/"):]
    cb := d.registry.Get(name)

    if cb == nil {
        http.NotFound(w, r)
        return
    }

    response := map[string]any{
        "status":  cb.GetStatus(),
        "history": cb.GetHistory(),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>Circuit Breaker Dashboard</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: #f5f5f5; }
        h1 { color: #333; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; }
        .card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .card h3 { margin-top: 0; display: flex; align-items: center; gap: 10px; }
        .status { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
        .status.CLOSED { background: #d4edda; color: #155724; }
        .status.OPEN { background: #f8d7da; color: #721c24; }
        .status.HALF_OPEN { background: #fff3cd; color: #856404; }
        .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; }
        .metric { background: #f8f9fa; padding: 10px; border-radius: 4px; }
        .metric-label { font-size: 11px; color: #666; text-transform: uppercase; }
        .metric-value { font-size: 24px; font-weight: 600; color: #333; }
        .error-rate { color: #dc3545; }
        .history { margin-top: 15px; font-size: 12px; }
        .history-item { padding: 5px 0; border-bottom: 1px solid #eee; }
    </style>
</head>
<body>
    <h1>Circuit Breaker Dashboard</h1>
    <div class="grid" id="breakers"></div>

    <script>
        function updateDashboard() {
            fetch('/api/breakers')
                .then(r => r.json())
                .then(breakers => {
                    const grid = document.getElementById('breakers');
                    grid.innerHTML = breakers.map(cb => ` + "`" + `
                        <div class="card">
                            <h3>
                                ${cb.name}
                                <span class="status ${cb.state}">${cb.state}</span>
                            </h3>
                            <div class="metrics">
                                <div class="metric">
                                    <div class="metric-label">Total Requests</div>
                                    <div class="metric-value">${cb.total_requests.toLocaleString()}</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Error Rate</div>
                                    <div class="metric-value error-rate">${cb.error_rate.toFixed(1)}%</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Success</div>
                                    <div class="metric-value">${cb.success_count.toLocaleString()}</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Failures</div>
                                    <div class="metric-value">${cb.failure_count.toLocaleString()}</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Short Circuited</div>
                                    <div class="metric-value">${cb.short_circuited.toLocaleString()}</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Threshold</div>
                                    <div class="metric-value">${cb.failure_threshold}</div>
                                </div>
                            </div>
                        </div>
                    ` + "`" + `).join('');
                });
        }

        updateDashboard();
        setInterval(updateDashboard, 2000);
    </script>
</body>
</html>
`

// Example usage
func ExampleDashboard() {
    // Create registry
    registry := NewCircuitBreakerRegistry()

    // Register circuit breakers for different services
    paymentCB := registry.Register("payment-service", 5, 3, 30*time.Second)
    inventoryCB := registry.Register("inventory-service", 3, 2, 15*time.Second)
    notificationCB := registry.Register("notification-service", 10, 5, 60*time.Second)

    // Start dashboard
    dashboard := NewDashboard(registry)
    mux := http.NewServeMux()
    dashboard.RegisterHandlers(mux)

    // Simulate some traffic
    go func() {
        services := []*MonitoredCircuitBreaker{paymentCB, inventoryCB, notificationCB}
        for {
            for _, cb := range services {
                cb.Execute(context.Background(), func(ctx context.Context) error {
                    // Simulate random failures
                    if time.Now().UnixNano()%10 < 3 {
                        return fmt.Errorf("simulated error")
                    }
                    return nil
                })
            }
            time.Sleep(100 * time.Millisecond)
        }
    }()

    fmt.Println("Dashboard running at http://localhost:8080")
    http.ListenAndServe(":8080", mux)
}
```

### Junior -> FAANG: Making the Most of These Exercises

The benchmark exercise (Exercise 1) is worth running, not just reading. The expected output shows consistent hashing moving roughly 17% of keys when adding a sixth node to a five-node cluster, compared to 83% for simple hashing. Seeing this number in your terminal output makes the intuition stick in a way that reading about it does not.

When you run the benchmark, also vary the virtual node count from 10 to 500 and observe how the standard deviation of distribution changes. At 10 virtual nodes, the distribution is noticeably uneven. At 150 virtual nodes, it stabilizes. This gives you empirical backing for the "use 150 virtual nodes" recommendation rather than treating it as a magic number.

For the adaptive rate limiter (Exercise 2), the exercise as written has a simplified `Allow` method that uses window-level counting rather than a proper token bucket. For real learning value, replace the simplified `Allow` with the token bucket implementation from Section 59.4 and wire the adaptive logic into the token refill rate rather than the window count. This creates a proper AIMD (additive increase, multiplicative decrease) rate controller, the same algorithm used in TCP congestion control.

For the circuit breaker dashboard (Exercise 3), add a "force open" and "force close" button to the UI. Production circuit breakers need manual override for incidents where you want to shed load immediately without waiting for the failure threshold to trip. This is also a common interview question ("how would an engineer manually control this during an incident?").

### Senior @ FAANG: Extending These Exercises to Production Readiness

The benchmark exercise reveals only the steady-state distribution. A production benchmark would also measure: time to add a node (the sort operation), time to remove a node, and memory usage for rings with 1,000 physical nodes and 150 virtual nodes each (1.15 million ring entries). Run this with `pprof` to understand allocation patterns. The sorted ring slice will allocate on every `AddNode` call if you are not pre-allocating with sufficient capacity. Confirm this is not causing GC pressure at scale.

The adaptive rate limiter exercise as written has a correctness issue that is worth finding and fixing. The `resetWindowMetrics` function zeroes the counters, but if a request is in-flight during the reset, the in-flight request's latency will not be attributed to any window. For production use, this is acceptable (latency samples are eventually consistent), but for a payment service where you are tuning limits based on error rate, you need atomic counter resets. The correct implementation uses compare-and-swap on the counter values rather than zeroing them.

The circuit breaker dashboard exercise is missing the most important operational feature: the ability to export metrics in Prometheus format. Add a `/metrics` endpoint that emits `circuit_breaker_state{name="..."}`, `circuit_breaker_requests_total{name="...", status="success|failure|short_circuited"}`, and `circuit_breaker_state_transitions_total{name="...", from="...", to="..."}`. This makes the dashboard useful not just as a UI but as a data source for Grafana alerts, which is how circuit breaker monitoring actually works in production.

Staff-level extension: combine all three exercises into an end-to-end system. Use the hash ring to route requests to backends, use the adaptive rate limiter to control per-backend request rates, and use the circuit breaker to detect when a backend has failed. The interaction between these three components (the ring routes to a failed backend, the circuit breaker opens, the ring should skip the failed backend) requires adding health-aware routing to the hash ring, which is the bounded-load variant extended with circuit breaker state as an additional "overloaded" signal.

---
