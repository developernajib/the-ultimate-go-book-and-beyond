## 123.3 RPC Optimization

### Connection Pooling and Load Balancing

Efficient RPC management is crucial for application performance:

```go
// pkg/web3/rpc_pool.go
package web3

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
)

// RPCClient wraps an Ethereum client with additional metadata
type RPCClient struct {
    client      *ethclient.Client
    config      NodeConfig
    healthy     atomic.Bool
    lastChecked atomic.Int64
    requests    atomic.Uint64
    errors      atomic.Uint64
}

// RPCPool manages a pool of RPC clients with load balancing
type RPCPool struct {
    clients     []*RPCClient
    current     atomic.Uint32
    mu          sync.RWMutex
    strategy    LoadBalanceStrategy
    healthCheck time.Duration
}

// LoadBalanceStrategy defines load balancing strategies
type LoadBalanceStrategy int

const (
    RoundRobin LoadBalanceStrategy = iota
    LeastConnections
    WeightedRoundRobin
    Random
)

// NewRPCPool creates a new RPC connection pool
func NewRPCPool(configs []NodeConfig) (*RPCPool, error) {
    if len(configs) == 0 {
        return nil, fmt.Errorf("at least one node configuration required")
    }

    pool := &RPCPool{
        clients:     make([]*RPCClient, 0, len(configs)),
        strategy:    RoundRobin,
        healthCheck: 30 * time.Second,
    }

    // Initialize clients
    for _, config := range configs {
        client, err := ethclient.Dial(config.URL)
        if err != nil {
            // Log error but continue with other clients
            fmt.Printf("Failed to connect to %s: %v\n", config.URL, err)
            continue
        }

        rpcClient := &RPCClient{
            client: client,
            config: config,
        }
        rpcClient.healthy.Store(true)
        rpcClient.lastChecked.Store(time.Now().Unix())

        pool.clients = append(pool.clients, rpcClient)
    }

    if len(pool.clients) == 0 {
        return nil, fmt.Errorf("failed to connect to any nodes")
    }

    return pool, nil
}

// GetClient returns a client from the pool using the configured strategy
func (p *RPCPool) GetClient() (*ethclient.Client, error) {
    p.mu.RLock()
    defer p.mu.RUnlock()

    if len(p.clients) == 0 {
        return nil, fmt.Errorf("no clients available")
    }

    var selectedClient *RPCClient

    switch p.strategy {
    case RoundRobin:
        selectedClient = p.roundRobin()
    case LeastConnections:
        selectedClient = p.leastConnections()
    case WeightedRoundRobin:
        selectedClient = p.weightedRoundRobin()
    default:
        selectedClient = p.roundRobin()
    }

    if selectedClient == nil {
        return nil, fmt.Errorf("no healthy clients available")
    }

    selectedClient.requests.Add(1)
    return selectedClient.client, nil
}

// roundRobin implements round-robin load balancing
func (p *RPCPool) roundRobin() *RPCClient {
    attempts := 0
    maxAttempts := len(p.clients)

    for attempts < maxAttempts {
        index := p.current.Add(1) % uint32(len(p.clients))
        client := p.clients[index]

        if client.healthy.Load() {
            return client
        }

        attempts++
    }

    return nil
}

// leastConnections returns the client with the least active requests
func (p *RPCPool) leastConnections() *RPCClient {
    var selected *RPCClient
    minRequests := ^uint64(0) // Max uint64

    for _, client := range p.clients {
        if !client.healthy.Load() {
            continue
        }

        requests := client.requests.Load()
        if requests < minRequests {
            minRequests = requests
            selected = client
        }
    }

    return selected
}

// weightedRoundRobin implements weighted round-robin based on priority
func (p *RPCPool) weightedRoundRobin() *RPCClient {
    // Sort clients by priority (lower is better)
    for _, client := range p.clients {
        if client.healthy.Load() {
            return client
        }
    }
    return nil
}

// Monitor monitors client health
func (p *RPCPool) Monitor(ctx context.Context) {
    ticker := time.NewTicker(p.healthCheck)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            p.checkHealth(ctx)
        }
    }
}

// checkHealth checks health of all clients
func (p *RPCPool) checkHealth(ctx context.Context) {
    p.mu.RLock()
    clients := make([]*RPCClient, len(p.clients))
    copy(clients, p.clients)
    p.mu.RUnlock()

    var wg sync.WaitGroup
    for _, client := range clients {
        wg.Add(1)
        go func(c *RPCClient) {
            defer wg.Done()
            p.checkClientHealth(ctx, c)
        }(client)
    }
    wg.Wait()
}

// checkClientHealth checks health of a single client
func (p *RPCPool) checkClientHealth(ctx context.Context, client *RPCClient) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    // Try to get latest block number
    _, err := client.client.BlockNumber(ctx)

    wasHealthy := client.healthy.Load()
    isHealthy := err == nil

    client.healthy.Store(isHealthy)
    client.lastChecked.Store(time.Now().Unix())

    if err != nil {
        client.errors.Add(1)
    }

    // Log status changes
    if wasHealthy != isHealthy {
        if isHealthy {
            fmt.Printf("Node %s recovered\n", client.config.URL)
        } else {
            fmt.Printf("Node %s unhealthy: %v\n", client.config.URL, err)
        }
    }
}

// GetStats returns statistics for all clients
func (p *RPCPool) GetStats() []ClientStats {
    p.mu.RLock()
    defer p.mu.RUnlock()

    stats := make([]ClientStats, len(p.clients))
    for i, client := range p.clients {
        stats[i] = ClientStats{
            URL:         client.config.URL,
            Healthy:     client.healthy.Load(),
            Requests:    client.requests.Load(),
            Errors:      client.errors.Load(),
            LastChecked: time.Unix(client.lastChecked.Load(), 0),
        }
    }

    return stats
}

// ClientStats represents statistics for a single client
type ClientStats struct {
    URL         string
    Healthy     bool
    Requests    uint64
    Errors      uint64
    LastChecked time.Time
}

// Close closes all clients in the pool
func (p *RPCPool) Close() error {
    p.mu.Lock()
    defer p.mu.Unlock()

    for _, client := range p.clients {
        client.client.Close()
    }

    return nil
}

// AddClient adds a new client to the pool
func (p *RPCPool) AddClient(config NodeConfig) error {
    client, err := ethclient.Dial(config.URL)
    if err != nil {
        return fmt.Errorf("failed to connect to %s: %w", config.URL, err)
    }

    rpcClient := &RPCClient{
        client: client,
        config: config,
    }
    rpcClient.healthy.Store(true)
    rpcClient.lastChecked.Store(time.Now().Unix())

    p.mu.Lock()
    p.clients = append(p.clients, rpcClient)
    p.mu.Unlock()

    return nil
}

// RemoveClient removes a client from the pool by URL
func (p *RPCPool) RemoveClient(url string) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    for i, client := range p.clients {
        if client.config.URL == url {
            client.client.Close()
            p.clients = append(p.clients[:i], p.clients[i+1:]...)
            return nil
        }
    }

    return fmt.Errorf("client not found: %s", url)
}
```

### Rate Limiting

Implement rate limiting to avoid hitting provider limits:

```go
// pkg/web3/rate_limiter.go
package web3

import (
    "context"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// RateLimiter implements rate limiting for RPC requests
type RateLimiter struct {
    limiters map[string]*rate.Limiter
    mu       sync.RWMutex

    // Default limits
    requestsPerSecond int
    burst             int
}

// NewRateLimiter creates a new rate limiter
func NewRateLimiter(requestsPerSecond, burst int) *RateLimiter {
    return &RateLimiter{
        limiters:          make(map[string]*rate.Limiter),
        requestsPerSecond: requestsPerSecond,
        burst:             burst,
    }
}

// GetLimiter returns a rate limiter for a specific endpoint
func (rl *RateLimiter) GetLimiter(endpoint string) *rate.Limiter {
    rl.mu.RLock()
    limiter, exists := rl.limiters[endpoint]
    rl.mu.RUnlock()

    if exists {
        return limiter
    }

    rl.mu.Lock()
    defer rl.mu.Unlock()

    // Double-check after acquiring write lock
    if limiter, exists := rl.limiters[endpoint]; exists {
        return limiter
    }

    limiter = rate.NewLimiter(
        rate.Limit(rl.requestsPerSecond),
        rl.burst,
    )
    rl.limiters[endpoint] = limiter

    return limiter
}

// Wait waits for permission to make a request
func (rl *RateLimiter) Wait(ctx context.Context, endpoint string) error {
    limiter := rl.GetLimiter(endpoint)
    return limiter.Wait(ctx)
}

// Allow checks if a request is allowed without blocking
func (rl *RateLimiter) Allow(endpoint string) bool {
    limiter := rl.GetLimiter(endpoint)
    return limiter.Allow()
}

// RateLimitedClient wraps an Ethereum client with rate limiting
type RateLimitedClient struct {
    client      *ethclient.Client
    rateLimiter *RateLimiter
    endpoint    string
}

// NewRateLimitedClient creates a new rate-limited client
func NewRateLimitedClient(
    client *ethclient.Client,
    endpoint string,
    requestsPerSecond, burst int,
) *RateLimitedClient {
    return &RateLimitedClient{
        client:      client,
        rateLimiter: NewRateLimiter(requestsPerSecond, burst),
        endpoint:    endpoint,
    }
}

// BlockNumber gets the latest block number with rate limiting
func (c *RateLimitedClient) BlockNumber(ctx context.Context) (uint64, error) {
    if err := c.rateLimiter.Wait(ctx, c.endpoint); err != nil {
        return 0, err
    }
    return c.client.BlockNumber(ctx)
}
```

### Retry Logic with Exponential Backoff

The retry handler wraps each RPC call with exponential backoff and jitter, distinguishing transient errors (rate limits, timeouts) from permanent ones (invalid parameters) to avoid retrying calls that will always fail. Context cancellation propagates through the retry loop so upstream deadlines abort the retry cycle rather than letting it run past the caller's timeout.

```go
// pkg/web3/retry.go
package web3

import (
    "context"
    "fmt"
    "math"
    "time"
)

// RetryConfig represents retry configuration
type RetryConfig struct {
    MaxRetries     int
    InitialBackoff time.Duration
    MaxBackoff     time.Duration
    Multiplier     float64
}

// DefaultRetryConfig returns default retry configuration
func DefaultRetryConfig() RetryConfig {
    return RetryConfig{
        MaxRetries:     3,
        InitialBackoff: 100 * time.Millisecond,
        MaxBackoff:     10 * time.Second,
        Multiplier:     2.0,
    }
}

// RetryableFunc is a function that can be retried
type RetryableFunc func(ctx context.Context) error

// Retry executes a function with exponential backoff retry
func Retry(ctx context.Context, config RetryConfig, fn RetryableFunc) error {
    var lastErr error

    for attempt := 0; attempt <= config.MaxRetries; attempt++ {
        if attempt > 0 {
            backoff := calculateBackoff(attempt, config)

            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(backoff):
            }
        }

        err := fn(ctx)
        if err == nil {
            return nil
        }

        lastErr = err

        // Check if error is retryable
        if !isRetryable(err) {
            return err
        }
    }

    return fmt.Errorf("max retries exceeded: %w", lastErr)
}

// calculateBackoff calculates backoff duration for an attempt
func calculateBackoff(attempt int, config RetryConfig) time.Duration {
    backoff := float64(config.InitialBackoff) * math.Pow(config.Multiplier, float64(attempt-1))

    if backoff > float64(config.MaxBackoff) {
        backoff = float64(config.MaxBackoff)
    }

    return time.Duration(backoff)
}

// isRetryable determines if an error is retryable
func isRetryable(err error) bool {
    // Add logic to determine if error is retryable
    // For example, network errors are retryable, but invalid input is not
    return true
}
```

### Junior → FAANG: RPC Optimization for Latency and Cost

RPC optimization for Web3 infrastructure is about reducing the number of round-trip calls, batching those that cannot be avoided, and caching results where the data's immutability allows it. For junior engineers, the most impactful optimization is simply identifying which RPC calls are made on every request to your API and which of those calls can be batched or cached.

JSON-RPC batching (sending multiple RPC calls in a single HTTP request) is supported by all major Ethereum clients and reduces the number of HTTP round trips by a factor equal to the batch size. Instead of making ten individual `eth_getBalance` calls, you send one HTTP request containing all ten calls as a JSON array and receive all ten results in one response. The reduction in latency is significant when the HTTP round trip is the dominant latency component.

The Ethereum JSON-RPC batch limit varies by provider: Geth has no built-in batch size limit (though very large batches may time out), Alchemy limits to 250 calls per batch, and Infura limits to 100. In Go, implementing batch RPC calls requires working at the transport level: the `ethclient.Client` provides per-call methods, but batching requires using the underlying RPC client's `BatchCall` method with raw `rpc.BatchElem` structs.

For interview preparation, describe a caching strategy for Ethereum data. Block data for blocks older than 64 blocks can be cached indefinitely (they are finalized and will not change). Transaction receipts for transactions in finalized blocks can also be cached indefinitely. Contract code (`eth_getCode`) for addresses that are not upgradeable proxy contracts can be cached indefinitely. Implementing these caching rules reduces RPC costs significantly for read-heavy applications.

### Senior @ FAANG: RPC Optimization as Platform Infrastructure

At staff level, RPC optimization is a platform-wide concern that affects the cost, latency, and reliability of every application that uses Web3 infrastructure. A poorly optimized RPC layer wastes money (third-party RPC providers charge per call), increases latency (unnecessary round trips add to user-visible response times), and puts pressure on node infrastructure (excessive RPC load can degrade node performance for all consumers).

The RPC middleware layer is the architectural pattern for implementing organization-wide RPC optimization. A reverse proxy (or a custom Go service) that sits between applications and the Ethereum node can implement: request deduplication (two concurrent requests for the same block number result in one upstream call), response caching (with TTL calibrated to the data's mutability), rate limiting (to protect the node from being overwhelmed by any single application), and request logging (for debugging and cost attribution). Building this middleware layer as a shared platform service is more efficient than having each team implement their own caching and deduplication logic.

The Multicall3 pattern for batching read operations is the most impactful application-level optimization for read-heavy Web3 applications. Multicall3 allows hundreds of contract read calls to be combined into a single `eth_call`, with all results returned in a single response. For applications that need to read balances, allowances, or state from many addresses at once, Multicall3 can reduce RPC calls by two orders of magnitude. Staff engineers who identify high-frequency sequential read patterns in application code should recommend Multicall3 as the optimization before considering infrastructure scaling.

RPC provider cost management at scale requires monitoring and attribution. A large Web3 platform may make millions of RPC calls per day, costing thousands of dollars in third-party provider fees. Implementing per-team and per-application attribution (by routing all RPC calls through the middleware layer and logging the caller identity) allows cost to be attributed accurately and creates the visibility needed to prioritize optimization work. Staff engineers who implement this attribution system enable data-driven cost optimization decisions.

WebSocket subscription optimization is distinct from HTTP RPC optimization. WebSocket subscriptions (`eth_subscribe`) are stateful and long-lived, and maintaining hundreds of subscriptions from a single application can overwhelm both the client and the provider. The correct pattern is to have a single subscription fan-out service: one WebSocket connection per provider per subscription type, with application consumers registering interest and receiving updates through in-process channels. This pattern reduces the number of open WebSocket connections by orders of magnitude while maintaining real-time delivery to all consumers.

Bar-raiser signals: designing an RPC load-balancing strategy that prioritizes low-latency nodes for user-facing requests and uses higher-latency, lower-cost nodes for background processing (batch indexing, historical data fetching), or explaining the latency difference between using `eth_call` with the `latest` block tag (which requires the node to look up its current head block first) versus `eth_call` with a specific block number (which can be served from the block's cached state without any head lookup). These optimization details reveal genuine performance engineering depth.

---
