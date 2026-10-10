## Scaling Search Infrastructure

A search system that works at 100K documents faces fundamentally different challenges at 500M documents. This section covers the infrastructure decisions required to operate search at scale.

### Elasticsearch Cluster Sizing

**Shard sizing rules of thumb:**
- Target shard size: 20-50 GB for primary shards.
- Maximum shard count per node: 20 shards per GB of heap. A 32 GB heap node handles ~640 shards.
- Replica shards: Always run at least 1 replica for fault tolerance. 2 replicas for read-heavy workloads.
- Over-sharding is a common mistake: thousands of small shards cause overhead that outweighs parallelism benefits.

**JVM heap settings:**

```bash
# elasticsearch.yml / jvm.options
# Never exceed 50% of physical RAM, never exceed 26 GB (compressed OOPs threshold).
-Xms16g
-Xmx16g
```

**Index template for a 500M-document news corpus:**

```json
{
  "index_patterns": ["news-*"],
  "settings": {
    "number_of_shards": 12,
    "number_of_replicas": 1,
    "refresh_interval": "30s",
    "index.codec": "best_compression",
    "index.merge.scheduler.max_thread_count": 1
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "title":       { "type": "text", "analyzer": "english" },
      "body":        { "type": "text", "analyzer": "english", "index_options": "offsets" },
      "published_at":{ "type": "date" },
      "category":    { "type": "keyword" },
      "popularity":  { "type": "float" }
    }
  }
}
```

### Index Lifecycle Management (ILM)

ILM automates moving indices through hot, warm, cold, and frozen tiers as data ages. This dramatically reduces storage costs while keeping fresh data on fast SSDs.

```
Hot tier   → Active indexing + search. NVMe SSDs. Retain 7 days.
Warm tier  → Search only. SATA SSDs. Retain 30 days.
Cold tier  → Infrequent search. HDD or S3-backed. Retain 1 year.
Frozen tier→ Rare access. Fully offloaded to S3. Retain indefinitely.
```

```json
{
  "policy": {
    "phases": {
      "hot":  { "actions": { "rollover": { "max_age": "7d", "max_size": "50gb" } } },
      "warm": { "min_age": "7d",  "actions": { "shrink": { "number_of_shards": 1 }, "forcemerge": { "max_num_segments": 1 } } },
      "cold": { "min_age": "30d", "actions": { "freeze": {} } },
      "delete":{ "min_age": "365d","actions": { "delete": {} } }
    }
  }
}
```

### Reindex Without Downtime

Zero-downtime reindex is a standard pattern when changing mappings or analyzers: 1. Create `index-v2` with the new mapping.
2. Point a write alias to both `index-v1` and `index-v2` during backfill.
3. Run the Reindex API with `slices: auto` for parallel reindexing.
4. Verify document counts match.
5. Update the read alias to point to `index-v2` only.
6. Remove the write alias from `index-v1`.
7. Delete `index-v1` once confident.

### Go Bulk Indexing with Backpressure
Naive bulk indexing floods Elasticsearch and causes indexing queue saturation. The correct approach uses a semaphore to bound concurrent bulk requests:

```go
package indexer

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "sync"

    "github.com/elastic/go-elasticsearch/v8"
)

const (
    bulkBatchSize    = 500
    maxConcurrentReqs = 4 // backpressure: max in-flight bulk requests
)

// BulkIndexer indexes documents in batches with bounded concurrency.
type BulkIndexer struct {
    client    *elasticsearch.Client
    indexName string
    sem       chan struct{}
}

// NewBulkIndexer creates a BulkIndexer with bounded concurrency.
func NewBulkIndexer(client *elasticsearch.Client, indexName string) *BulkIndexer {
    return &BulkIndexer{
        client:    client,
        indexName: indexName,
        sem:       make(chan struct{}, maxConcurrentReqs),
    }
}

// IndexDocuments indexes all docs in batches, blocking when maxConcurrentReqs
// bulk requests are already in-flight (backpressure).
func (bi *BulkIndexer) IndexDocuments(ctx context.Context, docs []map[string]any) error {
    var wg sync.WaitGroup
    errs := make(chan error, len(docs)/bulkBatchSize+1)

    for i := 0; i < len(docs); i += bulkBatchSize {
        end := i + bulkBatchSize
        if end > len(docs) {
            end = len(docs)
        }
        batch := docs[i:end]

        // Acquire semaphore slot (blocks if maxConcurrentReqs are in flight).
        select {
        case bi.sem <- struct{}{}:
        case <-ctx.Done():
            return ctx.Err()
        }

        wg.Add(1)
        go func(b []map[string]any) {
            defer wg.Done()
            defer func() { <-bi.sem }() // release slot

            if err := bi.sendBatch(ctx, b); err != nil {
                errs <- err
            }
        }(batch)
    }

    wg.Wait()
    close(errs)

    for err := range errs {
        if err != nil {
            return err
        }
    }
    return nil
}

func (bi *BulkIndexer) sendBatch(ctx context.Context, docs []map[string]any) error {
    var buf bytes.Buffer
    for _, doc := range docs {
        id, _ := doc["id"].(string)
        meta := map[string]any{
            "index": map[string]any{
                "_index": bi.indexName,
                "_id":    id,
            },
        }
        if err := json.NewEncoder(&buf).Encode(meta); err != nil {
            return err
        }
        if err := json.NewEncoder(&buf).Encode(doc); err != nil {
            return err
        }
    }

    res, err := bi.client.Bulk(bytes.NewReader(buf.Bytes()),
        bi.client.Bulk.WithContext(ctx),
        bi.client.Bulk.WithIndex(bi.indexName),
    )
    if err != nil {
        return fmt.Errorf("bulk request: %w", err)
    }
    defer res.Body.Close()

    if res.IsError() {
        return fmt.Errorf("bulk response error: %s", res.Status())
    }
    slog.Info("bulk batch indexed", "count", len(docs), "status", res.Status())
    return nil
}
```

### Search Caching Strategy

Caching at multiple layers reduces latency and protects the Elasticsearch cluster from hot query traffic:

**Layer 1 - Elasticsearch built-in caches:**
- **Query cache**: Caches filter clause results (non-scoring queries). Evicted on segment merge.
- **Request cache**: Caches aggregation results for `size=0` requests. Very effective for dashboard queries.
- **Field data cache**: Caches fielddata for sorting/aggregations on text fields.

**Layer 2 - Application-level Go cache:**

```go
package cache

import (
    "crypto/sha256"
    "encoding/json"
    "fmt"
    "sync"
    "time"
)

// SearchCache is a thread-safe LRU-style cache for search results with TTL.
type SearchCache struct {
    mu      sync.RWMutex
    entries map[string]*cacheEntry
    ttl     time.Duration
    maxSize int
}

type cacheEntry struct {
    value     []byte
    expiresAt time.Time
}

// NewSearchCache creates a search result cache with the given TTL and max entry count.
func NewSearchCache(ttl time.Duration, maxSize int) *SearchCache {
    c := &SearchCache{
        entries: make(map[string]*cacheEntry),
        ttl:     ttl,
        maxSize: maxSize,
    }
    go c.evictLoop()
    return c
}

// Get retrieves a cached result by query key. Returns nil, false if not found or expired.
func (c *SearchCache) Get(query any) ([]byte, bool) {
    key := c.hashKey(query)
    c.mu.RLock()
    defer c.mu.RUnlock()
    entry, ok := c.entries[key]
    if !ok || time.Now().After(entry.expiresAt) {
        return nil, false
    }
    return entry.value, true
}

// Set stores a result in the cache under the given query key.
func (c *SearchCache) Set(query any, value []byte) {
    key := c.hashKey(query)
    c.mu.Lock()
    defer c.mu.Unlock()
    if len(c.entries) >= c.maxSize {
        c.evictOldest()
    }
    c.entries[key] = &cacheEntry{value: value, expiresAt: time.Now().Add(c.ttl)}
}

func (c *SearchCache) hashKey(query any) string {
    b, _ := json.Marshal(query)
    return fmt.Sprintf("%x", sha256.Sum256(b))
}

func (c *SearchCache) evictOldest() {
    var oldestKey string
    var oldestTime time.Time
    for k, v := range c.entries {
        if oldestKey == "" || v.expiresAt.Before(oldestTime) {
            oldestKey = k
            oldestTime = v.expiresAt
        }
    }
    delete(c.entries, oldestKey)
}

func (c *SearchCache) evictLoop() {
    ticker := time.NewTicker(c.ttl / 2)
    for range ticker.C {
        now := time.Now()
        c.mu.Lock()
        for k, v := range c.entries {
            if now.After(v.expiresAt) {
                delete(c.entries, k)
            }
        }
        c.mu.Unlock()
    }
}
```

### Elasticsearch vs OpenSearch vs Custom Lucene

| Dimension | Elasticsearch | OpenSearch | Custom Lucene |
|-----------|--------------|------------|---------------|
| **License** | SSPL (v8+, not OSI) | Apache 2.0 | Apache 2.0 |
| **Managed** | Elastic Cloud | AWS OpenSearch Service | Self-managed only |
| **Features** | Most complete (ML, ESQL, vector) | Good parity with ES 7.x | Full control |
| **Vector search** | Built-in (HNSW) | Built-in (k-NN plugin) | Via Lucene 9+ HNSW |
| **Learning curve** | Medium | Medium | Very high |
| **Customization** | Plugin API | Plugin API | Unlimited |
| **Best for** | Enterprises needing managed full-text + vector | AWS shops, open-source requirement | Search startups building differentiated products |

For most production systems, Elasticsearch or OpenSearch are the correct choice. Build on custom Lucene only when your ranking requirements are so specialized that no query DSL can express them - e.g., a trading platform with real-time financial score blending.

---
