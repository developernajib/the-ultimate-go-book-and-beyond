## 63.7 Company Case Studies

### Redis at Twitter

Twitter's home timeline architecture (detailed by Raffi Krikorian in *"Timelines at Scale"*, QCon SF 2012, and the Twitter Engineering Blog) is built on a fan-out-on-write model: when a user posts a tweet, the system pushes the tweet into the Redis sorted sets of all their followers, trading write amplification for fast read performance. For celebrity users with millions of followers, a hybrid approach fetches their tweets at read time and merges them into the pre-assembled timeline, avoiding unbounded fan-out. The Redis cluster uses sorted sets with timestamps as scores, enabling efficient reverse-chronological pagination with `ZREVRANGE`.

```go
// twitter/timeline_cache.go
package twitter

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// TwitterTimelineCache implements Twitter's timeline caching strategy
type TwitterTimelineCache struct {
    cluster *redis.ClusterClient
    maxLen  int64
    ttl     time.Duration
}

type Tweet struct {
    ID        string    `json:"id"`
    UserID    string    `json:"user_id"`
    Content   string    `json:"content"`
    Timestamp time.Time `json:"timestamp"`
    Score     float64   `json:"-"` // Timestamp as score for sorted set
}

// FanOutOnWrite pushes tweet to all follower timelines
func (c *TwitterTimelineCache) FanOutOnWrite(ctx context.Context, tweet *Tweet, followerIDs []string) error {
    pipe := c.cluster.Pipeline()

    tweetJSON, _ := json.Marshal(tweet)
    score := float64(tweet.Timestamp.UnixNano())

    for _, followerID := range followerIDs {
        key := fmt.Sprintf("timeline:%s", followerID)

        // Add to sorted set with timestamp as score
        pipe.ZAdd(ctx, key, redis.Z{
            Score:  score,
            Member: string(tweetJSON),
        })

        // Trim to max length (keep most recent)
        pipe.ZRemRangeByRank(ctx, key, 0, -c.maxLen-1)

        // Set TTL
        pipe.Expire(ctx, key, c.ttl)
    }

    _, err := pipe.Exec(ctx)
    return err
}

// GetTimeline retrieves a user's home timeline
func (c *TwitterTimelineCache) GetTimeline(ctx context.Context, userID string, offset, limit int64) ([]*Tweet, error) {
    key := fmt.Sprintf("timeline:%s", userID)

    // Get tweets in reverse chronological order
    results, err := c.cluster.ZRevRange(ctx, key, offset, offset+limit-1).Result()
    if err != nil {
        return nil, err
    }

    tweets := make([]*Tweet, 0, len(results))
    for _, r := range results {
        var tweet Tweet
        if json.Unmarshal([]byte(r), &tweet) == nil {
            tweets = append(tweets, &tweet)
        }
    }

    return tweets, nil
}

// HybridApproach combines fan-out-on-write for normal users
// and fan-out-on-read for celebrity users (millions of followers)
func (c *TwitterTimelineCache) HybridApproach(ctx context.Context, userID string, offset, limit int64, celebrityFollows []string) ([]*Tweet, error) {
    // Get cached timeline (fan-out-on-write results)
    tweets, err := c.GetTimeline(ctx, userID, offset, limit)
    if err != nil {
        return nil, err
    }

    // Merge with celebrity tweets (fan-out-on-read)
    for _, celebID := range celebrityFollows {
        celebTweets, _ := c.GetUserTweets(ctx, celebID, 10)
        tweets = c.mergeTimelines(tweets, celebTweets)
    }

    return tweets[:min(len(tweets), int(limit))], nil
}
```

### Memcached at Facebook

Facebook's cache architecture (detailed by Rajesh Nishtala et al. in *"Scaling Memcache at Facebook"*, 10th USENIX Symposium on Networked Systems Design and Implementation, NSDI '13) uses a lease-based mechanism to prevent thundering herd on cache misses. When a cache miss occurs, the first requester receives a lease token and is responsible for fetching and repopulating the cache. All subsequent requesters for the same key see that a lease is held and either wait or receive a slightly stale value. This approach eliminates the stampede problem without requiring the `singleflight` pattern at the application layer. Cross-region replication uses an McRouter-like proxy that replicates writes to all data center pools.

```go
// facebook/graph_cache.go
package facebook

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// FacebookGraphCache implements Facebook's social graph caching
type FacebookGraphCache struct {
    pools    map[string]*MemcachedPool // Region -> Pool
    leasesMu sync.Map                   // Lease management for thundering herd
}

type LeaseToken struct {
    Token     uint64
    ExpiresAt time.Time
}

// GetWithLease prevents thundering herd using lease mechanism
func (c *FacebookGraphCache) GetWithLease(ctx context.Context, key string) ([]byte, *LeaseToken, error) {
    pool := c.getPool(key)

    // Try to get value
    value, err := pool.Get(ctx, key)
    if err == nil {
        return value, nil, nil
    }

    // Cache miss - acquire the lease atomically. A Load check
    // followed by a separate Store would let two concurrent misses
    // both grant themselves the lease, recreating the exact stampede
    // this mechanism exists to prevent.
    leaseKey := "lease:" + key
    lease := &LeaseToken{
        Token:     generateToken(),
        ExpiresAt: time.Now().Add(10 * time.Second),
    }

    if existing, loaded := c.leasesMu.LoadOrStore(leaseKey, lease); loaded {
        current := existing.(*LeaseToken)
        if time.Now().Before(current.ExpiresAt) {
            // Another request holds the lease, wait or return stale
            return nil, nil, ErrLeaseHeld
        }
        // Previous lease expired: take it over
        c.leasesMu.Store(leaseKey, lease)
    }

    return nil, lease, ErrCacheMiss
}

// SetWithLease sets value only if lease is still valid
func (c *FacebookGraphCache) SetWithLease(ctx context.Context, key string, value []byte, lease *LeaseToken) error {
    leaseKey := "lease:" + key

    // Verify lease is still valid
    existing, ok := c.leasesMu.Load(leaseKey)
    if !ok {
        return ErrLeaseExpired
    }

    currentLease := existing.(*LeaseToken)
    if currentLease.Token != lease.Token {
        return ErrLeaseInvalid
    }

    // Set value
    pool := c.getPool(key)
    if err := pool.Set(ctx, key, value, time.Hour); err != nil {
        return err
    }

    // Release lease
    c.leasesMu.Delete(leaseKey)

    return nil
}

// McRouter-style replication across regions
func (c *FacebookGraphCache) SetWithReplication(ctx context.Context, key string, value []byte) error {
    var wg sync.WaitGroup
    errCh := make(chan error, len(c.pools))

    for region, pool := range c.pools {
        wg.Add(1)
        go func(r string, p *MemcachedPool) {
            defer wg.Done()
            if err := p.Set(ctx, key, value, time.Hour); err != nil {
                errCh <- fmt.Errorf("region %s: %w", r, err)
            }
        }(region, pool)
    }

    wg.Wait()
    close(errCh)

    // Collect errors
    var errs []error
    for err := range errCh {
        errs = append(errs, err)
    }

    if len(errs) > len(c.pools)/2 {
        return fmt.Errorf("replication failed: %v", errs)
    }

    return nil
}
```

### DynamoDB DAX at Amazon

Amazon DynamoDB Accelerator (DAX) (detailed in AWS Architecture documentation and the whitepaper *"In-Memory Acceleration with DynamoDB Accelerator (DAX)"*) is a write-through, read-cache layer that sits between the application and DynamoDB, providing microsecond read latency for frequently accessed items. DAX maintains two separate caches: an item cache keyed by primary key for individual GetItem requests, and a query cache keyed by the query hash for result sets. Negative caching (storing the fact that a key does not exist) prevents repeated database lookups for missing items, which is critical for workloads with high miss rates on non-existent keys.

```go
// amazon/dax_cache.go
package amazon

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// DAXCluster implements DynamoDB DAX-style caching
type DAXCluster struct {
    itemCache  *ItemCache
    queryCache *QueryCache
    nodes      []*DAXNode
    router     *ConsistentHashRouter
}

type ItemCache struct {
    cache sync.Map // Partition key + sort key -> Item
    ttl   time.Duration
}

type QueryCache struct {
    cache sync.Map // Query hash -> Results
    ttl   time.Duration
}

// GetItem retrieves item with negative caching
func (d *DAXCluster) GetItem(ctx context.Context, tableName, pk, sk string) (*Item, error) {
    cacheKey := fmt.Sprintf("%s:%s:%s", tableName, pk, sk)

    // Check item cache
    if cached, ok := d.itemCache.cache.Load(cacheKey); ok {
        entry := cached.(*cacheEntry)
        if time.Now().Before(entry.expiresAt) {
            if entry.item == nil {
                return nil, ErrItemNotFound // Negative cache hit
            }
            return entry.item, nil
        }
        d.itemCache.cache.Delete(cacheKey)
    }

    // Route to appropriate node
    node := d.router.GetNode(cacheKey)

    // Fetch from DynamoDB
    item, err := node.FetchFromDynamoDB(ctx, tableName, pk, sk)

    // Cache result (including negative results)
    entry := &cacheEntry{
        item:      item,
        expiresAt: time.Now().Add(d.itemCache.ttl),
    }
    d.itemCache.cache.Store(cacheKey, entry)

    if err != nil {
        return nil, err
    }
    return item, nil
}

// Query with result caching
func (d *DAXCluster) Query(ctx context.Context, params *QueryParams) (*QueryResult, error) {
    queryHash := params.Hash()

    // Check query cache
    if cached, ok := d.queryCache.cache.Load(queryHash); ok {
        entry := cached.(*queryCacheEntry)
        if time.Now().Before(entry.expiresAt) {
            return entry.result, nil
        }
    }

    // Execute query
    node := d.router.GetNode(params.TableName + params.PartitionKey)
    result, err := node.ExecuteQuery(ctx, params)
    if err != nil {
        return nil, err
    }

    // Cache query result
    d.queryCache.cache.Store(queryHash, &queryCacheEntry{
        result:    result,
        expiresAt: time.Now().Add(d.queryCache.ttl),
    })

    // Also cache individual items
    for _, item := range result.Items {
        itemKey := fmt.Sprintf("%s:%s:%s", params.TableName, item.PK, item.SK)
        d.itemCache.cache.Store(itemKey, &cacheEntry{
            item:      item,
            expiresAt: time.Now().Add(d.itemCache.ttl),
        })
    }

    return result, nil
}
```

### Junior -> FAANG: Learning from Production War Stories

Company case studies are interview currency. FAANG interviewers frequently ask "have you read any engineering blog posts about distributed caching?" and candidates who can cite Twitter's fan-out-on-write model, Facebook's lease mechanism, or Amazon DAX's dual-cache design stand out from those who can only describe their own projects.

The Twitter timeline example teaches the fan-out tradeoff: fan-out-on-write costs write amplification (writing to every follower's timeline on each tweet), while fan-out-on-read costs read latency (assembling the timeline from multiple sources on every page load). The hybrid approach for celebrity users is the key insight: the threshold between the two strategies is not static, it depends on follower count. This is the kind of nuanced tradeoff that separates strong candidates from weak ones.

The Facebook lease mechanism directly answers the "how do you prevent thundering herd?" question with a more sophisticated answer than `singleflight`. The lease approach delegates stampede prevention to the cache layer rather than the application layer, which matters when you have many independent services all hitting the same cache. Knowing this reference means you can say "this is what Facebook did at scale" rather than speaking only from first principles.

A first-job habit: read at least one engineering blog post from a major tech company per week. The Twitter, Facebook, and Amazon examples in this chapter are all based on published papers and posts. Being able to cite these signals that you engage with the field beyond your own work.

### Senior @ FAANG: Extracting Architectural Principles from Case Studies

The three case studies in this chapter are not just historical trivia. Each encodes an architectural decision that resolves a fundamental tension in distributed caching, and a senior engineer must be able to extract and apply those principles.

**Twitter's fan-out threshold is a capacity planning decision, not a product decision**

The hybrid approach for celebrity users exists because fan-out-on-write is O(followers) per tweet, and for a user with 50 million followers that is 50 million Redis writes on every post. The decision to switch to fan-out-on-read for high-follower accounts is driven by write throughput constraints of the Redis cluster, not by user experience preferences. A staff-level question: "At what follower count do you switch strategies, and how do you make that threshold dynamic?" The answer involves tracking the p99 write latency for fan-out jobs and switching a user to the hybrid model when their fan-out consistently exceeds the write SLA. This is a feedback-controlled threshold, not a static config value.

**Facebook's lease mechanism is a protocol, not an implementation detail**

The lease token approach solves the thundering-herd problem at the cache protocol level. The insight is that the solution does not require coordination between application servers: the cache itself issues and validates leases. This is a property of the cache API design, not the application code. When designing a cache platform for multiple teams, a senior engineer proposes lease-aware cache APIs (like Memcached's `cas` command) rather than relying on each team to independently implement `singleflight`. Platform-level stampede prevention is cheaper and more reliable than per-team application-level prevention.

**DAX's dual-cache (item cache plus query cache) is a pattern for all ORM-backed systems**

The DAX design splits item cache (keyed by primary key) from query cache (keyed by query hash). These have different invalidation semantics: an item update invalidates exactly one item cache entry but potentially many query cache entries (any query whose result set included that item). Most application-level caches conflate these and either under-invalidate (serving stale query results) or over-invalidate (invalidating too many query results and hurting hit rate). A principal engineer designs explicit invalidation contracts for both cache tiers, with a registry that tracks which query cache keys contain a given item ID.

**Negative caching is a correctness feature, not a performance optimization**

DAX's negative caching (caching the fact that an item does not exist) is primarily about correctness and cost control, not performance. Without negative caching, a workload that repeatedly looks up non-existent items (such as an attacker probing user IDs) generates a database query on every miss. Negative caching with a short TTL caps the database amplification. The senior concern: the TTL for negative cache entries must be shorter than the TTL for positive entries, because a miss may become a hit (a new item is created) and you cannot serve "not found" after creation.

---
