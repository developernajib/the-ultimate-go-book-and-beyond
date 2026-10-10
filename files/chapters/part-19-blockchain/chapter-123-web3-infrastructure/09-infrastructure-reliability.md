## 123.9 Infrastructure Reliability

### Health Checking

Health check endpoints expose runtime status to orchestration systems like Kubernetes, which use liveness and readiness probes to route traffic and restart unhealthy instances. The following implementation correctly separates the process-alive check from the request-ready check.

```go
// pkg/web3/health/checker.go
package health

import (
    "context"
    "sync"
    "time"
)

// HealthStatus represents overall health status
type HealthStatus struct {
    Healthy    bool
    Components map[string]ComponentHealth
    CheckedAt  time.Time
}

// ComponentHealth represents health of a single component
type ComponentHealth struct {
    Name    string
    Healthy bool
    Message string
    Latency time.Duration
}

// HealthChecker checks health of infrastructure components
type HealthChecker struct {
    infra     *Infrastructure
    status    HealthStatus
    mu        sync.RWMutex
    interval  time.Duration
}

// NewHealthChecker creates a new health checker
func NewHealthChecker(infra *Infrastructure) *HealthChecker {
    return &HealthChecker{
        infra:    infra,
        interval: 30 * time.Second,
        status: HealthStatus{
            Components: make(map[string]ComponentHealth),
        },
    }
}

// Run runs the health checking loop
func (hc *HealthChecker) Run(ctx context.Context) {
    ticker := time.NewTicker(hc.interval)
    defer ticker.Stop()

    // Initial check
    hc.check(ctx)

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            hc.check(ctx)
        }
    }
}

// check performs a health check
func (hc *HealthChecker) check(ctx context.Context) {
    components := make(map[string]ComponentHealth)
    allHealthy := true

    // Check RPC pool
    rpcHealth := hc.checkRPCPool(ctx)
    components["rpc"] = rpcHealth
    if !rpcHealth.Healthy {
        allHealthy = false
    }

    // Check IPFS
    if hc.infra.ipfsClient != nil {
        ipfsHealth := hc.checkIPFS(ctx)
        components["ipfs"] = ipfsHealth
        if !ipfsHealth.Healthy {
            allHealthy = false
        }
    }

    // Check indexer
    if hc.infra.indexer != nil {
        indexerHealth := hc.checkIndexer(ctx)
        components["indexer"] = indexerHealth
        if !indexerHealth.Healthy {
            allHealthy = false
        }
    }

    // Update status
    hc.mu.Lock()
    hc.status = HealthStatus{
        Healthy:    allHealthy,
        Components: components,
        CheckedAt:  time.Now(),
    }
    hc.mu.Unlock()
}

// checkRPCPool checks RPC pool health
func (hc *HealthChecker) checkRPCPool(ctx context.Context) ComponentHealth {
    start := time.Now()

    client, err := hc.infra.rpcPool.GetClient()
    if err != nil {
        return ComponentHealth{
            Name:    "RPC Pool",
            Healthy: false,
            Message: err.Error(),
            Latency: time.Since(start),
        }
    }

    _, err = client.BlockNumber(ctx)
    if err != nil {
        return ComponentHealth{
            Name:    "RPC Pool",
            Healthy: false,
            Message: err.Error(),
            Latency: time.Since(start),
        }
    }

    return ComponentHealth{
        Name:    "RPC Pool",
        Healthy: true,
        Message: "OK",
        Latency: time.Since(start),
    }
}

// checkIPFS checks IPFS health
func (hc *HealthChecker) checkIPFS(ctx context.Context) ComponentHealth {
    start := time.Now()

    // Try a simple IPFS operation
    _, err := hc.infra.ipfsClient.ID()
    if err != nil {
        return ComponentHealth{
            Name:    "IPFS",
            Healthy: false,
            Message: err.Error(),
            Latency: time.Since(start),
        }
    }

    return ComponentHealth{
        Name:    "IPFS",
        Healthy: true,
        Message: "OK",
        Latency: time.Since(start),
    }
}

// checkIndexer checks indexer health
func (hc *HealthChecker) checkIndexer(ctx context.Context) ComponentHealth {
    start := time.Now()

    // Check if indexer is accessible
    // This is a placeholder - implement actual indexer health check

    return ComponentHealth{
        Name:    "Indexer",
        Healthy: true,
        Message: "OK",
        Latency: time.Since(start),
    }
}

// Status returns the current health status
func (hc *HealthChecker) Status() HealthStatus {
    hc.mu.RLock()
    defer hc.mu.RUnlock()
    return hc.status
}
```

### Caching Strategy

The Redis-backed cache stores block and transaction data with a configurable TTL, reducing RPC calls for frequently queried historical data that will never change after sufficient confirmations. The `Get` method deserializes the cached JSON back into typed structs rather than returning raw bytes, keeping serialization concerns inside the cache layer rather than spreading them to callers.

```go
// pkg/web3/cache/cache.go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/go-redis/redis/v8"
)

// Cache provides caching for Web3 data
type Cache struct {
    client *redis.Client
    prefix string
    ttl    time.Duration
}

// NewCache creates a new cache
func NewCache(redisURL, prefix string, ttl time.Duration) (*Cache, error) {
    opt, err := redis.ParseURL(redisURL)
    if err != nil {
        return nil, fmt.Errorf("invalid Redis URL: %w", err)
    }

    client := redis.NewClient(opt)

    // Test connection
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("failed to connect to Redis: %w", err)
    }

    return &Cache{
        client: client,
        prefix: prefix,
        ttl:    ttl,
    }, nil
}

// Get retrieves a value from cache
func (c *Cache) Get(ctx context.Context, key string, dest any) error {
    fullKey := c.prefix + ":" + key

    data, err := c.client.Get(ctx, fullKey).Bytes()
    if err == redis.Nil {
        return fmt.Errorf("key not found")
    }
    if err != nil {
        return fmt.Errorf("cache get error: %w", err)
    }

    if err := json.Unmarshal(data, dest); err != nil {
        return fmt.Errorf("unmarshal error: %w", err)
    }

    return nil
}

// Set stores a value in cache
func (c *Cache) Set(ctx context.Context, key string, value any) error {
    fullKey := c.prefix + ":" + key

    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("marshal error: %w", err)
    }

    if err := c.client.Set(ctx, fullKey, data, c.ttl).Err(); err != nil {
        return fmt.Errorf("cache set error: %w", err)
    }

    return nil
}

// Delete removes a value from cache
func (c *Cache) Delete(ctx context.Context, key string) error {
    fullKey := c.prefix + ":" + key
    return c.client.Del(ctx, fullKey).Err()
}

// GetOrSet gets from cache or sets if not found
func (c *Cache) GetOrSet(
    ctx context.Context,
    key string,
    dest any,
    fetchFn func() (any, error),
) error {
    // Try to get from cache
    err := c.Get(ctx, key, dest)
    if err == nil {
        return nil
    }

    // Fetch from source
    value, err := fetchFn()
    if err != nil {
        return fmt.Errorf("fetch error: %w", err)
    }

    // Store in cache
    if err := c.Set(ctx, key, value); err != nil {
        // Log error but don't fail
        fmt.Printf("Cache set error: %v\n", err)
    }

    // Copy value to dest
    data, _ := json.Marshal(value)
    return json.Unmarshal(data, dest)
}
```

### Junior → FAANG: Web3 Infrastructure Reliability Fundamentals

Web3 infrastructure reliability starts with understanding the failure modes that are specific to blockchain systems: RPC node downtime (the node you depend on becomes unavailable), chain reorganization (previously confirmed blocks are replaced), and network congestion (gas prices spike beyond your configured limits). Each failure mode has a different manifestation and a different mitigation.

The most important first-job reliability practice is implementing health checks for every external dependency: for each RPC node your application uses, check `eth_blockNumber` and compare the returned block number against a trusted source (another node or a public block explorer). If the block number is significantly behind the expected chain head, the node may be out of sync. Routing requests away from a lagging node and alerting for investigation is the correct operational response.

Circuit breakers for RPC calls protect your application from cascading failures when a node becomes slow or unreliable. A circuit breaker tracks the error rate for recent RPC calls to a specific node: when the error rate exceeds a threshold, the circuit breaker opens and routes traffic to a backup node. After a recovery period, the circuit breaker tries a small amount of traffic on the failing node, and if successful, closes the circuit and resumes normal routing. The `github.com/sony/gobreaker` package is a solid Go implementation.

Interview entry point: design a multi-provider RPC setup with automatic failover for a Go application. You have three providers: one self-hosted Geth node (primary) and two third-party providers (Alchemy and Infura, as backups). Normal traffic goes to the self-hosted node. If the node returns an error, your circuit breaker opens and traffic fails over to Alchemy. If Alchemy also fails, traffic falls through to Infura. Metrics track which provider is being used and why, providing visibility into the failover events.

### Senior @ FAANG: Web3 Infrastructure Reliability at Production Scale

At staff level, Web3 infrastructure reliability is measured against SLOs (Service Level Objectives) that are defined with respect to the application's specific requirements. A trading application may require sub-100ms P95 RPC latency and 99.99 percent availability. An analytics application may tolerate P95 latency of 500ms and 99.9 percent availability. SLOs drive the infrastructure design: higher reliability requirements justify higher infrastructure investment.

Error budget management for Web3 infrastructure is the practice of tracking how much unreliability has been consumed against the SLO allowance. If the SLO is 99.9 percent availability (0.1 percent error budget), a 30-minute outage consumes approximately 7 percent of the monthly error budget. Tracking this consumption and slowing or pausing infrastructure changes when the error budget is low is a mature SRE practice that applies directly to Web3 infrastructure. Staff engineers define the error budget policy and enforce it through the release management process.

Observability for Web3 infrastructure requires a monitoring stack that understands blockchain-specific metrics. Standard infrastructure metrics (CPU, memory, disk, network) are necessary but not sufficient. Blockchain-specific metrics that every production Web3 infrastructure team must track include: block processing lag (how far behind the canonical chain is the local view?), RPC call latency by method (some methods are inherently slower than others), reorg frequency and depth (are reorgs happening at expected rates?), and mempool depth (how many pending transactions are waiting for inclusion?). These metrics are the early warning system for problems before they become incidents.

Disaster recovery for Web3 infrastructure is different from traditional disaster recovery because the data source (the blockchain) is always available: you cannot "lose" the blockchain, only your local view of it. The recovery objective for a Web3 infrastructure disaster (node failure, database corruption) is the time to re-sync to the canonical chain and rebuild the indexed data. This recovery time depends on the amount of data to process (for an indexer) or the sync speed (for a node), and it can range from minutes to days. Staff engineers maintain documented recovery time estimates and test recovery procedures quarterly.

The reliability of third-party blockchain infrastructure providers must be tracked and compared to their advertised SLAs. Infura, Alchemy, and Quicknode all publish uptime SLAs, but actual measured uptime may differ. Staff engineers maintain historical uptime data for each provider (using their own monitoring, not the provider's status page) and use this data to negotiate SLAs, make provider selection decisions, and justify infrastructure investment in self-hosted alternatives.

Bar-raiser signals: designing an SLO framework for Web3 infrastructure that distinguishes between "blockchain unreliability" (the chain is slow, reorging, or congested) and "infrastructure unreliability" (your nodes are down or your indexer is lagging), with separate error budgets for each so that the infrastructure team is not penalized for blockchain-level events they cannot control, or explaining how EIP-3668 (CCIP Read, Cross-Chain Interoperability Protocol) enables off-chain data lookup in a way that is verifiable on-chain, and how to implement a Go client for CCIP Read that correctly handles the off-chain gateway response and verification. These topics reveal senior-level reliability engineering thinking.

---
