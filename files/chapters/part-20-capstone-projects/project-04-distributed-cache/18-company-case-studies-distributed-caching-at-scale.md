## Company Case Studies: Distributed Caching at Scale

### Netflix: EVCache for Global Video Streaming

Netflix's EVCache serves billions of requests daily:

```go
// Netflix EVCache-style distributed caching
package evcache

import (
    "context"
    "sync"
    "time"

    "github.com/cespare/xxhash/v2"
)

// EVCacheClient handles multi-region cache operations
type EVCacheClient struct {
    regions       map[string]*RegionClient
    localRegion   string
    consistentHash *ConsistentHashRing
    replicator    *AsyncReplicator
    fallback      FallbackPolicy
}

// RegionClient manages cache servers in a region
type RegionClient struct {
    region      string
    servers     []*CacheServer
    hashRing    *ConsistentHashRing
    healthCheck *HealthChecker
}

// CacheEntry with versioning for conflict resolution
type CacheEntry struct {
    Key          string    `json:"key"`
    Value        []byte    `json:"value"`
    Version      uint64    `json:"version"`
    TTL          time.Duration
    CreatedAt    time.Time `json:"created_at"`
    Region       string    `json:"region"`
    Compressed   bool      `json:"compressed"`
}

// Get retrieves from local region with fallback
func (c *EVCacheClient) Get(ctx context.Context, key string) (*CacheEntry, error) {
    // Try local region first
    entry, err := c.getFromRegion(ctx, c.localRegion, key)
    if err == nil {
        return entry, nil
    }

    // Fallback to other regions based on policy
    if c.fallback == FallbackNone {
        return nil, ErrCacheMiss
    }

    for region, client := range c.regions {
        if region == c.localRegion {
            continue
        }

        entry, err = c.getFromRegion(ctx, region, key)
        if err == nil {
            // Async backfill to local region
            go c.backfill(ctx, c.localRegion, entry)
            return entry, nil
        }
    }

    return nil, ErrCacheMiss
}

// Set writes to local region and replicates async
func (c *EVCacheClient) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
    entry := &CacheEntry{
        Key:       key,
        Value:     value,
        Version:   uint64(time.Now().UnixNano()),
        TTL:       ttl,
        CreatedAt: time.Now(),
        Region:    c.localRegion,
    }

    // Compress large values
    if len(value) > 1024 {
        entry.Value = compress(value)
        entry.Compressed = true
    }

    // Write to local region
    if err := c.setInRegion(ctx, c.localRegion, entry); err != nil {
        return err
    }

    // Async replication to other regions
    c.replicator.Replicate(entry)

    return nil
}

// getFromRegion retrieves from specific region with retry
func (c *EVCacheClient) getFromRegion(ctx context.Context, region, key string) (*CacheEntry, error) {
    client := c.regions[region]
    if client == nil {
        return nil, ErrRegionNotFound
    }

    // Get server from hash ring
    server := client.hashRing.GetNode(key)
    if server == nil || !server.IsHealthy() {
        // Try replica
        server = client.hashRing.GetReplicaNode(key)
    }

    entry, err := server.Get(ctx, key)
    if err != nil {
        return nil, err
    }

    // Decompress if needed
    if entry.Compressed {
        entry.Value = decompress(entry.Value)
        entry.Compressed = false
    }

    return entry, nil
}

// AsyncReplicator handles cross-region replication
type AsyncReplicator struct {
    queue      chan *CacheEntry
    regions    map[string]*RegionClient
    batchSize  int
    flushEvery time.Duration
}

func (r *AsyncReplicator) Replicate(entry *CacheEntry) {
    select {
    case r.queue <- entry:
    default:
        // Queue full, drop oldest
        <-r.queue
        r.queue <- entry
    }
}

func (r *AsyncReplicator) run() {
    batch := make([]*CacheEntry, 0, r.batchSize)
    ticker := time.NewTicker(r.flushEvery)

    for {
        select {
        case entry := <-r.queue:
            batch = append(batch, entry)
            if len(batch) >= r.batchSize {
                r.flush(batch)
                batch = batch[:0]
            }
        case <-ticker.C:
            if len(batch) > 0 {
                r.flush(batch)
                batch = batch[:0]
            }
        }
    }
}
```

### Meta/Facebook: TAO Distributed Object Cache

Meta's TAO serves social graph data:

```go
// Meta TAO-style object cache with graph associations
package tao

import (
    "context"
    "sync"
    "time"
)

// TAOClient handles object and association caching
type TAOClient struct {
    objectCache      *ShardedCache
    associationCache *ShardedCache
    leaderFollower   *LeaderFollowerCluster
}

// Object represents a cached entity (user, post, photo)
type Object struct {
    ID        uint64            `json:"id"`
    Type      string            `json:"type"`
    Data      map[string]any    `json:"data"`
    Version   uint64            `json:"version"`
    UpdatedAt time.Time         `json:"updated_at"`
}

// Association represents graph edges (friends, likes, comments)
type Association struct {
    ID1       uint64    `json:"id1"`
    Type      string    `json:"type"`
    ID2       uint64    `json:"id2"`
    Time      int64     `json:"time"`
    Data      []byte    `json:"data"`
}

// AssocGet retrieves associations with caching
func (t *TAOClient) AssocGet(ctx context.Context, id1 uint64, atype string, id2s []uint64) ([]Association, error) {
    // Check cache first
    cached := make([]Association, 0, len(id2s))
    missing := make([]uint64, 0)

    for _, id2 := range id2s {
        key := t.assocKey(id1, atype, id2)
        if assoc, ok := t.associationCache.Get(key); ok {
            cached = append(cached, assoc.(Association))
        } else {
            missing = append(missing, id2)
        }
    }

    if len(missing) == 0 {
        return cached, nil
    }

    // Fetch missing from leader
    fetched, err := t.leaderFollower.AssocGet(ctx, id1, atype, missing)
    if err != nil {
        return nil, err
    }

    // Cache fetched associations
    for _, assoc := range fetched {
        key := t.assocKey(assoc.ID1, assoc.Type, assoc.ID2)
        t.associationCache.Set(key, assoc, 5*time.Minute)
        cached = append(cached, assoc)
    }

    return cached, nil
}

// AssocRange retrieves association range (friends list, recent likes)
func (t *TAOClient) AssocRange(ctx context.Context, id1 uint64, atype string, offset, limit int) ([]Association, error) {
    // Range queries bypass cache, go directly to leader
    return t.leaderFollower.AssocRange(ctx, id1, atype, offset, limit)
}

// AssocCount gets association count with caching
func (t *TAOClient) AssocCount(ctx context.Context, id1 uint64, atype string) (int64, error) {
    key := t.countKey(id1, atype)

    if count, ok := t.associationCache.Get(key); ok {
        return count.(int64), nil
    }

    count, err := t.leaderFollower.AssocCount(ctx, id1, atype)
    if err != nil {
        return 0, err
    }

    t.associationCache.Set(key, count, time.Minute)
    return count, nil
}

// ObjGet retrieves object with caching
func (t *TAOClient) ObjGet(ctx context.Context, id uint64) (*Object, error) {
    key := t.objKey(id)

    if obj, ok := t.objectCache.Get(key); ok {
        return obj.(*Object), nil
    }

    obj, err := t.leaderFollower.ObjGet(ctx, id)
    if err != nil {
        return nil, err
    }

    t.objectCache.Set(key, obj, 5*time.Minute)
    return obj, nil
}

func (t *TAOClient) assocKey(id1 uint64, atype string, id2 uint64) string {
    return fmt.Sprintf("a:%d:%s:%d", id1, atype, id2)
}
```

### Uber: Redis Clusters for Ride Matching

Uber uses Redis for real-time geospatial operations:

```go
// Uber-style geospatial caching for ride matching
package uber

import (
    "context"
    "time"

    "github.com/redis/go-redis/v9"
)

// GeoCacheService handles driver location caching
type GeoCacheService struct {
    redis        *redis.ClusterClient
    geoIndex     string
    ttlSeconds   int
}

// DriverLocation represents driver position
type DriverLocation struct {
    DriverID    string    `json:"driver_id"`
    Latitude    float64   `json:"latitude"`
    Longitude   float64   `json:"longitude"`
    Heading     float64   `json:"heading"`
    Speed       float64   `json:"speed"`
    Status      string    `json:"status"` // available, busy, offline
    VehicleType string    `json:"vehicle_type"`
    UpdatedAt   time.Time `json:"updated_at"`
}

// UpdateDriverLocation updates driver position in geo index
func (s *GeoCacheService) UpdateDriverLocation(ctx context.Context, loc *DriverLocation) error {
    pipe := s.redis.Pipeline()

    // Update geospatial index
    pipe.GeoAdd(ctx, s.geoIndex, &redis.GeoLocation{
        Name:      loc.DriverID,
        Longitude: loc.Longitude,
        Latitude:  loc.Latitude,
    })

    // Store driver metadata
    driverKey := fmt.Sprintf("driver:%s", loc.DriverID)
    data, _ := json.Marshal(loc)
    pipe.Set(ctx, driverKey, data, time.Duration(s.ttlSeconds)*time.Second)

    // Add to status index for filtering
    statusKey := fmt.Sprintf("drivers:%s:%s", loc.VehicleType, loc.Status)
    pipe.SAdd(ctx, statusKey, loc.DriverID)
    pipe.Expire(ctx, statusKey, time.Duration(s.ttlSeconds)*time.Second)

    _, err := pipe.Exec(ctx)
    return err
}

// FindNearbyDrivers returns drivers within radius
func (s *GeoCacheService) FindNearbyDrivers(ctx context.Context, lat, lng, radiusKm float64, vehicleType string, limit int) ([]*DriverLocation, error) {
    // Find drivers within radius
    results, err := s.redis.GeoRadius(ctx, s.geoIndex, lng, lat, &redis.GeoRadiusQuery{
        Radius:      radiusKm,
        Unit:        "km",
        WithCoord:   true,
        WithDist:    true,
        Count:       limit * 3, // Get extra for filtering
        Sort:        "ASC",
    }).Result()

    if err != nil {
        return nil, err
    }

    // Filter by vehicle type and availability
    statusKey := fmt.Sprintf("drivers:%s:available", vehicleType)
    availableSet, err := s.redis.SMembers(ctx, statusKey).Result()
    if err != nil {
        return nil, err
    }

    available := make(map[string]bool)
    for _, id := range availableSet {
        available[id] = true
    }

    drivers := make([]*DriverLocation, 0, limit)
    for _, result := range results {
        if !available[result.Name] {
            continue
        }

        // Get full driver data
        driverKey := fmt.Sprintf("driver:%s", result.Name)
        data, err := s.redis.Get(ctx, driverKey).Bytes()
        if err != nil {
            continue
        }

        var driver DriverLocation
        json.Unmarshal(data, &driver)
        drivers = append(drivers, &driver)

        if len(drivers) >= limit {
            break
        }
    }

    return drivers, nil
}

// CalculateETA estimates arrival time using cached traffic data
func (s *GeoCacheService) CalculateETA(ctx context.Context, driverID string, destLat, destLng float64) (time.Duration, error) {
    // Get driver location
    driverKey := fmt.Sprintf("driver:%s", driverID)
    data, err := s.redis.Get(ctx, driverKey).Bytes()
    if err != nil {
        return 0, err
    }

    var driver DriverLocation
    json.Unmarshal(data, &driver)

    // Get cached traffic multiplier for route
    trafficKey := fmt.Sprintf("traffic:%s", s.getRouteCell(driver.Latitude, driver.Longitude, destLat, destLng))
    multiplier := 1.0
    if val, err := s.redis.Get(ctx, trafficKey).Float64(); err == nil {
        multiplier = val
    }

    // Calculate base ETA
    distance := haversine(driver.Latitude, driver.Longitude, destLat, destLng)
    baseTime := distance / 30.0 // Assume 30 km/h average

    return time.Duration(baseTime * multiplier * float64(time.Hour)), nil
}
```

### Amazon ElastiCache: Managed Redis at Scale

ElastiCache patterns for AWS workloads:

```go
// ElastiCache cluster management patterns
package elasticache

import (
    "context"
    "time"

    "github.com/redis/go-redis/v9"
)

// ElastiCacheClient handles cluster-aware operations
type ElastiCacheClient struct {
    cluster       *redis.ClusterClient
    readReplicas  []*redis.Client
    readPolicy    ReadPolicy
    metrics       *CacheMetrics
}

// ReadPolicy determines read routing
type ReadPolicy int

const (
    ReadFromPrimary ReadPolicy = iota
    ReadFromReplica
    ReadFromPreferredReplica
)

// NewElastiCacheClient creates client with configuration endpoint
func NewElastiCacheClient(configEndpoint string) (*ElastiCacheClient, error) {
    cluster := redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:        []string{configEndpoint},
        ReadOnly:     true,
        RouteByLatency: true,
        PoolSize:     100,
        MinIdleConns: 10,
        DialTimeout:  5 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
    })

    return &ElastiCacheClient{
        cluster: cluster,
        metrics: NewCacheMetrics(),
    }, nil
}

// Get with automatic replica routing
func (c *ElastiCacheClient) Get(ctx context.Context, key string) (string, error) {
    start := time.Now()
    defer func() {
        c.metrics.RecordLatency("get", time.Since(start))
    }()

    val, err := c.cluster.Get(ctx, key).Result()
    if err == redis.Nil {
        c.metrics.RecordMiss()
        return "", ErrCacheMiss
    }
    if err != nil {
        c.metrics.RecordError("get")
        return "", err
    }

    c.metrics.RecordHit()
    return val, nil
}

// Pipeline executes batched operations
func (c *ElastiCacheClient) Pipeline(ctx context.Context, ops func(pipe redis.Pipeliner) error) error {
    pipe := c.cluster.Pipeline()
    if err := ops(pipe); err != nil {
        return err
    }

    _, err := pipe.Exec(ctx)
    return err
}

// CacheAside implements cache-aside pattern
func (c *ElastiCacheClient) CacheAside(ctx context.Context, key string, ttl time.Duration, loader func() (string, error)) (string, error) {
    // Try cache first
    val, err := c.Get(ctx, key)
    if err == nil {
        return val, nil
    }

    // Load from source
    val, err = loader()
    if err != nil {
        return "", err
    }

    // Cache the value
    c.cluster.Set(ctx, key, val, ttl)

    return val, nil
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Netflix EVCache | Multi-region replication, fallback policies | 30M+ RPS |
| Meta TAO | Graph-aware caching, association storage | Billions of reads/sec |
| Uber | Geospatial indexing, real-time updates | Millions of location updates/sec |
| AWS ElastiCache | Managed clusters, auto-failover | Enterprise-grade SLA |

---

### Junior → FAANG: EVCache as a Reference Architecture

Netflix's EVCache (built on Memcached with a custom replication layer) is the canonical reference for global cache architecture. The key design insight is that replication is regional and writes propagate from origin to all regional caches asynchronously. Reads are served from the nearest regional cache. This architecture provides low-latency global reads at the cost of brief cross-region inconsistency.

For interviews, use EVCache as an example of a specific cache design decision: "Netflix chose eventual consistency across regions because their use case (video metadata) can tolerate brief staleness but cannot tolerate high read latency." That framing shows you understand the CAP theorem in a concrete context.

Facebook's Memcache at scale (documented in the "Scaling Memcache at Facebook" NSDI 2013 paper) is required reading for any distributed systems engineer. The paper describes lease tokens (for thundering herd prevention), regional pools, and cold cluster warmup. These patterns appear in every large-scale cache deployment.

### Senior @ FAANG: Case Studies as Architecture Pattern Libraries

At senior level, case studies build a pattern library that informs future architectural decisions. EVCache's write-to-all-regions approach prevents cache misses during regional failovers. Facebook's lease token pattern prevents thundering herds during cache population. Twitter's Twemproxy (the proxy-based Memcache sharding approach) enables horizontal scaling without client-side consistent hashing logic.

Each pattern solves a specific problem at a specific scale. Before applying a pattern, verify that the problem it solves is the problem you actually have. Implementing lease tokens (complex) to prevent thundering herd (a problem that only occurs at high traffic) is premature optimization if your traffic is modest. The pattern library is most valuable when you know both the problem and the scale threshold at which it becomes relevant.

Uber's geospatial cache (storing driver locations with Redis GEO commands) demonstrates that a cache can be more than a simple key-value store. The choice to use Redis GEO rather than a custom spatial index is a build-vs-buy decision: Redis GEO provides O(N+log(M)) radius queries using geohash encoding, which satisfies Uber's use case without custom implementation. Know when the standard tool is sufficient.

---
