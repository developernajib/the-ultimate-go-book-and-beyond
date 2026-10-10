## 58.7 Company Case Studies

### Google: Spanner - Globally Distributed Database

Google Spanner achieves global distribution with strong consistency using TrueTime (Corbett et al., *Spanner: Google’s Globally-Distributed Database*, OSDI 2012), an API that exposes clock uncertainty as an explicit bounded interval rather than pretending clocks are perfectly synchronized. By waiting out the uncertainty interval before committing, Spanner ensures that externally consistent transactions are assigned timestamps that reflect their true global ordering, a property no other distributed database at the time could guarantee. The following code models the TrueTime pattern in Go, demonstrating how bounded clock skew can be used to implement externally consistent distributed operations.

```go
// google/pkg/spanner/truetime.go
// Spanner-style TrueTime-based consistency
package spanner

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type Write struct {
    Key   string
    Value []byte
}

type Replica struct {
    ID string
}

func (r *Replica) Read(ctx context.Context, key string, timestamp time.Time) ([]byte, error) {
    return []byte("data"), nil
}

type Directory struct{}

func (d *Directory) GetZone(key string) *Zone {
    return &Zone{}
}

func generateTxID() string {
    return fmt.Sprintf("tx-%d", time.Now().UnixNano())
}

// TrueTime provides bounded uncertainty timestamps
type TrueTime struct {
    // Uncertainty bounds from GPS/atomic clocks
    maxUncertainty time.Duration
}

type TTInterval struct {
    Earliest time.Time
    Latest   time.Time
}

func (tt *TrueTime) Now() TTInterval {
    now := time.Now()
    return TTInterval{
        Earliest: now.Add(-tt.maxUncertainty),
        Latest:   now.Add(tt.maxUncertainty),
    }
}

// Transaction with external consistency
type SpannerTransaction struct {
    id        string
    truetime  *TrueTime
    startTime TTInterval
    writes    []Write
    readSet   map[string]TTInterval
    mu        sync.Mutex
}

func (tx *SpannerTransaction) performCommit(ctx context.Context, commitTime time.Time) error {
    return nil
}

// Commit waits until timestamp is definitely passed
func (tx *SpannerTransaction) Commit(ctx context.Context) error {
    commitTime := tx.truetime.Now()

    // Wait out uncertainty: commit-wait
    // Ensures all nodes will see this transaction's timestamp as "in the past"
    waitDuration := time.Until(commitTime.Latest)
    if waitDuration > 0 {
        select {
        case <-time.After(waitDuration):
        case <-ctx.Done():
            return ctx.Err()
        }
    }

    // Now safe to commit - all nodes will agree on ordering
    return tx.performCommit(ctx, commitTime.Latest)
}

// SpannerDatabase simulates Spanner's architecture
type SpannerDatabase struct {
    zones     []*Zone
    truetime  *TrueTime
    directory *Directory // Maps keys to splits
}

type Zone struct {
    ID       string
    Leader   *Replica
    Replicas []*Replica
}

func (db *SpannerDatabase) nearestReplica(zone *Zone) *Replica {
    if len(zone.Replicas) > 0 {
        return zone.Replicas[0]
    }
    return zone.Leader
}

// Read with strong consistency
func (db *SpannerDatabase) Read(ctx context.Context, key string, timestamp time.Time) ([]byte, error) {
    zone := db.directory.GetZone(key)

    // Strong reads go to leader
    if timestamp.IsZero() {
        timestamp = db.truetime.Now().Latest
    }

    return zone.Leader.Read(ctx, key, timestamp)
}

// Stale read for lower latency
func (db *SpannerDatabase) StaleRead(ctx context.Context, key string, staleness time.Duration) ([]byte, error) {
    zone := db.directory.GetZone(key)

    // Stale reads can go to any replica
    timestamp := db.truetime.Now().Earliest.Add(-staleness)

    // Pick nearest replica
    nearest := db.nearestReplica(zone)
    return nearest.Read(ctx, key, timestamp)
}

// Global transaction across zones
func (db *SpannerDatabase) BeginTransaction(ctx context.Context) (*SpannerTransaction, error) {
    tx := &SpannerTransaction{
        id:        generateTxID(),
        truetime:  db.truetime,
        startTime: db.truetime.Now(),
        writes:    make([]Write, 0),
        readSet:   make(map[string]TTInterval),
    }

    return tx, nil
}
```

### Amazon: DynamoDB - Multi-Region Eventual Consistency

Amazon DynamoDB's global tables replicate data across AWS regions with configurable consistency (originating from DeCandia et al., *Dynamo: Amazon’s Highly Available Key-value Store*, SOSP 2007, and AWS DynamoDB Global Tables architecture). Writes go to the local region first and replicate asynchronously to others, providing low-latency writes from any region. Conflicts between concurrent writes to different regions are resolved using last-writer-wins timestamps or application-defined resolvers. The code below models DynamoDB's replication architecture in Go, including version vectors for conflict detection and a stream-based replication worker that processes changes from the DynamoDB Streams changelog.

```go
// amazon/pkg/dynamodb/global_tables.go
// DynamoDB-style global table replication
package dynamodb

import (
    "context"
    "time"
)

type Partition struct {
    ID string
}

type StreamRecord struct {
    Item Item
}

type DynamoDBStreams struct {
    globalTable *GlobalTable
}

func (s *DynamoDBStreams) GetRecords(ctx context.Context, position string, limit int) ([]StreamRecord, string, error) {
    return nil, position, nil
}

// GlobalTable manages multi-region replication
type GlobalTable struct {
    name          string
    regions       map[string]*RegionalTable
    conflictRes   ConflictResolution
    replicator    *StreamReplicator
}

type RegionalTable struct {
    region     string
    partitions []*Partition
    streams    *DynamoDBStreams
}

func (t *RegionalTable) put(ctx context.Context, item Item) error {
    return nil
}

func (t *RegionalTable) get(ctx context.Context, pk, sk string) (*Item, error) {
    return nil, nil
}

func (t *RegionalTable) getFromLeader(ctx context.Context, pk, sk string) (*Item, error) {
    return nil, nil
}

func (t *RegionalTable) getFromAnyReplica(ctx context.Context, pk, sk string) (*Item, error) {
    return nil, nil
}

type ConflictResolution int

const (
    LastWriterWins ConflictResolution = iota // Based on timestamp
    CustomResolver                            // Application-defined
)

// Item with version vector for conflict detection
type Item struct {
    PK        string                 `json:"pk"`
    SK        string                 `json:"sk"`
    Data      map[string]any `json:"data"`
    Version   map[string]int64       `json:"version"` // Region -> version
    Timestamp time.Time              `json:"ts"`
    Region    string                 `json:"region"`
}

// Write with eventual consistency
func (gt *GlobalTable) PutItem(ctx context.Context, region string, item Item) error {
    table := gt.regions[region]

    // Write to local region first
    item.Region = region
    item.Timestamp = time.Now()
    if item.Version == nil {
        item.Version = make(map[string]int64)
    }
    item.Version[region]++

    if err := table.put(ctx, item); err != nil {
        return err
    }

    // Asynchronously replicate to other regions via streams
    gt.replicator.Replicate(ctx, item)

    return nil
}

// Read with consistency options
type ReadConsistency int

const (
    EventuallyConsistent ReadConsistency = iota
    StronglyConsistent
)

func (gt *GlobalTable) GetItem(ctx context.Context, region string, pk, sk string, consistency ReadConsistency) (*Item, error) {
    table := gt.regions[region]

    switch consistency {
    case StronglyConsistent:
        // Read from leader partition
        return table.getFromLeader(ctx, pk, sk)
    case EventuallyConsistent:
        // Read from any replica (faster)
        return table.getFromAnyReplica(ctx, pk, sk)
    }

    return nil, nil
}

// StreamReplicator handles cross-region replication
type StreamReplicator struct {
    globalTable *GlobalTable
    workers     map[string]*ReplicationWorker
}

func (r *StreamReplicator) Replicate(ctx context.Context, item Item) {}

type ReplicationWorker struct {
    sourceRegion string
    targetRegion string
    stream       *DynamoDBStreams
    position     string // Shard iterator
}

func (r *StreamReplicator) Start(ctx context.Context) {
    for _, worker := range r.workers {
        go worker.processStream(ctx)
    }
}

func (w *ReplicationWorker) processStream(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
            records, newPosition, _ := w.stream.GetRecords(ctx, w.position, 100)
            w.position = newPosition

            for _, record := range records {
                _ = w.replicateRecord(ctx, record)
            }

            time.Sleep(100 * time.Millisecond) // Polling interval
        }
    }
}

func (w *ReplicationWorker) replicateRecord(ctx context.Context, record StreamRecord) error {
    targetTable := w.stream.globalTable.regions[w.targetRegion]

    // Check for conflicts
    existing, err := targetTable.get(ctx, record.Item.PK, record.Item.SK)
    if err == nil && existing != nil {
        // Resolve conflict
        resolved := w.resolveConflict(existing, &record.Item)
        return targetTable.put(ctx, *resolved)
    }

    return targetTable.put(ctx, record.Item)
}

func mergeVersionVectors(v1, v2 map[string]int64) map[string]int64 {
    merged := make(map[string]int64)
    for k, v := range v1 {
        merged[k] = v
    }
    for k, v := range v2 {
        if cur, ok := merged[k]; !ok || v > cur {
            merged[k] = v
        }
    }
    return merged
}

func (w *ReplicationWorker) resolveConflict(existing, incoming *Item) *Item {
    switch w.stream.globalTable.conflictRes {
    case LastWriterWins:
        if incoming.Timestamp.After(existing.Timestamp) {
            return incoming
        }
        return existing
    default:
        // Merge version vectors
        merged := mergeVersionVectors(existing.Version, incoming.Version)
        incoming.Version = merged
        return incoming
    }
}
```

### Netflix: EVCache - Distributed Caching at Scale

Netflix's EVCache (*Announcing EVCache: Distributed in-memory datastore for Cloud*, Netflix Technology Blog, 2013) is a distributed caching system built on top of memcached that handles millions of operations per second across multiple AWS availability zones. Its key design principle is zone awareness: reads go to the local zone first for minimal latency, with automatic fallback to other zones on miss or failure. Writes replicate to all zones in parallel, and a consistent hash ring routes keys to specific servers within each zone cluster. The implementation below demonstrates zone-aware reads with fallback, parallel cross-zone writes, batched multi-key fetches, and the consistent hashing algorithm that keeps key distribution stable as nodes are added or removed.

```go
// netflix/pkg/evcache/client.go
// Netflix EVCache-style distributed cache
package evcache

import (
    "context"
    "errors"
    "hash/crc32"
    "sort"
    "sync"
    "time"
)

var ErrCacheMiss = errors.New("evcache: cache miss")

type MemcachedServer struct {
    Addr string
}

func (s *MemcachedServer) Get(ctx context.Context, key string) ([]byte, error) {
    return []byte("val"), nil
}

func (s *MemcachedServer) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
    return nil
}

func (s *MemcachedServer) GetMulti(ctx context.Context, keys []string) (map[string][]byte, error) {
    res := make(map[string][]byte)
    for _, k := range keys {
        res[k] = []byte("val")
    }
    return res, nil
}

type CacheMetrics struct {
    mu sync.Mutex
}

func (m *CacheMetrics) RecordHit(zone string) {}
func (m *CacheMetrics) RecordMiss(zone string) {}
func (m *CacheMetrics) RecordError(zone, op string) {}

// EVCache client with zone awareness
type EVCache struct {
    appName    string
    zones      map[string]*ZoneCluster
    localZone  string
    hashRing   *ConsistentHashRing
    fallback   *FallbackPolicy
    metrics    *CacheMetrics
}

type ZoneCluster struct {
    zone    string
    servers []*MemcachedServer
    ring    *ConsistentHashRing
}

type FallbackPolicy struct {
    RetryOtherZones bool
    MaxRetries      int
    RetryDelay      time.Duration
}

// Get with zone fallback
func (e *EVCache) Get(ctx context.Context, key string) ([]byte, error) {
    // Try local zone first
    value, err := e.getFromZone(ctx, e.localZone, key)
    if err == nil {
        e.metrics.RecordHit(e.localZone)
        return value, nil
    }

    e.metrics.RecordMiss(e.localZone)

    // Fallback to other zones if enabled
    if e.fallback.RetryOtherZones {
        for zone := range e.zones {
            if zone == e.localZone {
                continue
            }

            value, err = e.getFromZone(ctx, zone, key)
            if err == nil {
                e.metrics.RecordHit(zone)
                return value, nil
            }
        }
    }

    return nil, ErrCacheMiss
}

func (e *EVCache) getFromZone(ctx context.Context, zone string, key string) ([]byte, error) {
    cluster := e.zones[zone]
    server := cluster.ring.GetNode(key)

    return server.Get(ctx, key)
}

// Set with replication to all zones
func (e *EVCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
    var wg sync.WaitGroup
    errChan := make(chan error, len(e.zones))

    // Write to all zones in parallel
    for zone, cluster := range e.zones {
        wg.Add(1)
        go func(z string, c *ZoneCluster) {
            defer wg.Done()

            server := c.ring.GetNode(key)
            if err := server.Set(ctx, key, value, ttl); err != nil {
                errChan <- err
                e.metrics.RecordError(z, "set")
            }
        }(zone, cluster)
    }

    wg.Wait()
    close(errChan)

    // Collect errors
    var errs []error
    for err := range errChan {
        errs = append(errs, err)
    }

    // Success if at least one zone accepted the write
    if len(errs) < len(e.zones) {
        return nil
    }

    return errs[0]
}

// Batch get for efficiency
func (e *EVCache) BatchGet(ctx context.Context, keys []string) (map[string][]byte, error) {
    // Group keys by server
    serverKeys := make(map[*MemcachedServer][]string)
    cluster := e.zones[e.localZone]

    for _, key := range keys {
        server := cluster.ring.GetNode(key)
        serverKeys[server] = append(serverKeys[server], key)
    }

    results := make(map[string][]byte)
    var mu sync.Mutex
    var wg sync.WaitGroup

    // Parallel fetch from each server
    for server, keys := range serverKeys {
        wg.Add(1)
        go func(s *MemcachedServer, k []string) {
            defer wg.Done()

            values, _ := s.GetMulti(ctx, k)
            mu.Lock()
            for key, val := range values {
                results[key] = val
            }
            mu.Unlock()
        }(server, keys)
    }

    wg.Wait()

    return results, nil
}

// ConsistentHashRing for server selection
type ConsistentHashRing struct {
    ring     map[uint32]*MemcachedServer
    sorted   []uint32
    replicas int
    mu       sync.RWMutex
}

func (r *ConsistentHashRing) GetNode(key string) *MemcachedServer {
    r.mu.RLock()
    defer r.mu.RUnlock()

    hash := crc32.ChecksumIEEE([]byte(key))

    // Binary search for first node >= hash
    idx := r.search(hash)
    return r.ring[r.sorted[idx]]
}

func (r *ConsistentHashRing) search(hash uint32) int {
    idx := sort.Search(len(r.sorted), func(i int) bool {
        return r.sorted[i] >= hash
    })
    if idx == len(r.sorted) {
        return 0 // past the last node: wrap around the ring
    }
    return idx
}
```

### Junior → FAANG: Learning from Real Systems

The three systems in this case study section (Spanner, DynamoDB Global Tables, EVCache) represent different points on the consistency-availability spectrum, and studying them is more valuable than studying abstract theory because interviewers at these companies built or operate these systems.

For junior candidates, the key takeaways are:

Spanner's TrueTime commit-wait is the mechanism that makes external consistency possible across datacenters without a global lock. The insight is that bounded clock uncertainty can be used to enforce ordering. You do not need to memorize the implementation, but you should be able to explain the concept: wait until the committed timestamp is definitely in the past for every node, which requires knowing how uncertain the clocks are.

DynamoDB Global Tables uses last-writer-wins conflict resolution by default. The version vector in the code shows how conflict detection works: if two regions both write to the same key during a partition, the one with the later timestamp wins when the partition heals. This is a deliberate AP choice. The user-visible consequence is that a write made during a network partition may be silently overwritten when the partition heals. For most DynamoDB use cases this is acceptable. For financial records it is not, which is why DynamoDB is not the right choice for ledger data.

EVCache's zone-aware design is a pattern worth internalizing: prefer local reads for latency, replicate writes to all zones for durability, fall back to other zones only on miss. This pattern appears in many distributed caching systems and is a clean answer to the question "how do you design a cache for a multi-AZ deployment?"

### Senior @ FAANG: Applying Case Study Lessons to Your Platform

These three case studies illustrate different points on the spectrum of distributed system design. At staff level, the question is not "what did Google and Netflix build?" but "which of these patterns apply to the systems I own, and where do my systems fall short of this quality bar?"

**Spanner's external consistency model and when to demand it.** TrueTime commit-wait is expensive: it adds milliseconds to every write. Google built Spanner because they had use cases (F1, the advertising backend) where global strong consistency was non-negotiable. Most teams do not have this requirement. The staff-level discipline is being explicit about whether your system requires external consistency or whether bounded staleness is acceptable, and documenting that decision so it is not accidentally upgraded or downgraded by a future team.

**DynamoDB conflict resolution as an organizational decision.** The choice between last-writer-wins and application-defined conflict resolution is not a database configuration. It is a product decision. Last-writer-wins is correct for user preference data (the latest update is what the user intended). It is wrong for collaborative editing (concurrent updates should be merged, not discarded). At the staff level, you identify which data types in your domain require merge-based conflict resolution, and you design or choose the data store that supports it. CRDTs (Conflict-free Replicated Data Types) are the theoretically clean answer, but they add significant implementation complexity. Most production systems use simpler approaches: operational transformation for collaborative text, application-level merge logic for structured data.

**EVCache zone architecture as a reliability pattern.** The zone-aware fallback in EVCache is a specific instance of a general pattern: prefer local, fall back to remote, never fail hard when the fallback is available. At the staff level, you apply this pattern beyond caching: database reads prefer the local replica (with a fallback to the primary for strong consistency), service calls prefer the local zone (with a fallback to another zone), and static asset serving prefers the CDN edge (with a fallback to the origin). Each of these fallback paths needs to be tested regularly, because a fallback that has never been exercised in production is not a reliable fallback.

**The cost of zone replication.** EVCache's parallel write to all zones adds latency proportional to the slowest zone write. If one zone is experiencing elevated latency, every cache write is delayed by that zone. At the staff level, you measure this overhead and decide whether to accept it (write to all zones and block until all succeed), relax it (write to all zones and return after the local zone succeeds, treat failures in other zones as best-effort), or eliminate it (use region-scoped caches rather than zone-replicated caches, accepting that a zone failure causes cache misses rather than falls back to a hot cache). This is an explicit trade-off between write latency and read availability, and it should be documented.

---
