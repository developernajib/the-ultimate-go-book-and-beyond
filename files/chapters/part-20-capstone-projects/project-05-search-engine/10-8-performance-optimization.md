## 8. Performance Optimization

Raw correctness is not enough for a production search engine, users expect sub-100ms response times even on large datasets. This section tackles two of the most impactful optimizations. First, we build a thread-safe LRU (Least Recently Used) cache that stores recent query results in memory so repeated searches return instantly without touching the index. Second, we write Go benchmarks that measure indexing throughput and query latency, giving you hard numbers to guide further tuning.

### 8.1 Caching Layer
The LRU cache stores recent query results keyed by the normalized query string. Entries expire after a configurable TTL and are evicted when the cache exceeds its capacity limit.

```go
// internal/util/cache/cache.go
package cache

import (
    "container/list"
    "sync"
)

// LRUCache implements a thread-safe LRU cache
type LRUCache struct {
    mu       sync.RWMutex
    capacity int
    items    map[string]*list.Element
    evict    *list.List
}

type entry struct {
    key   string
    value any
}

func NewLRUCache(capacity int) *LRUCache {
    return &LRUCache{
        capacity: capacity,
        items:    make(map[string]*list.Element),
        evict:    list.New(),
    }
}

func (c *LRUCache) Get(key string) (any, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    elem, ok := c.items[key]
    if !ok {
        return nil, false
    }

    c.evict.MoveToFront(elem)
    return elem.Value.(*entry).value, true
}

func (c *LRUCache) Put(key string, value any) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if elem, ok := c.items[key]; ok {
        c.evict.MoveToFront(elem)
        elem.Value.(*entry).value = value
        return
    }

    elem := c.evict.PushFront(&entry{key: key, value: value})
    c.items[key] = elem

    if c.evict.Len() > c.capacity {
        oldest := c.evict.Back()
        if oldest != nil {
            c.evict.Remove(oldest)
            delete(c.items, oldest.Value.(*entry).key)
        }
    }
}

func (c *LRUCache) Size() int {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.evict.Len()
}
```

### 8.2 Benchmarking

Benchmarking the cache under realistic load validates throughput limits, latency percentiles, and memory pressure behavior before production deployment. Go's built-in `testing.B` framework combined with `pprof` profiling identifies hot code paths, serialization overhead, and lock contention at high concurrency.

```go
// benchmarks/search_bench_test.go
package benchmarks

import (
    "testing"

    "github.com/yourorg/gosearch/internal/analyzer"
    "github.com/yourorg/gosearch/internal/index/inverted"
    "github.com/yourorg/gosearch/internal/query/executor"
    "github.com/yourorg/gosearch/internal/query/parser"
    "github.com/yourorg/gosearch/internal/ranking"
)

func BenchmarkIndexing(b *testing.B) {
    index := inverted.NewInvertedIndex(analyzer.NewStandardAnalyzer())

    b.ResetTimer()
    for b.Loop() {
        doc := &inverted.Document{
            ID: uint32(i),
            Fields: map[string]string{
                "title": "Benchmark Document",
                "body":  "This is a test document for benchmarking indexing performance",
            },
        }
        index.IndexDocument(doc)
    }
}

func BenchmarkSearch(b *testing.B) {
    // Setup
    index := inverted.NewInvertedIndex(analyzer.NewStandardAnalyzer())
    for i := 0; i < 10000; i++ {
        doc := &inverted.Document{
            ID: uint32(i),
            Fields: map[string]string{
                "title": "Document Title",
                "body":  "This is document body with some searchable content",
            },
        }
        index.IndexDocument(doc)
    }

    scorer := ranking.NewBM25Scorer(index)
    exec := executor.NewExecutor(index, scorer)
    p := parser.NewParser("body", "OR")

    query, _ := p.Parse("searchable content")

    b.ResetTimer()
    for b.Loop() {
        exec.Execute(query, 10)
    }
}
```

### Junior → FAANG: Query Result Caching as a Latency Multiplier

The query result cache (LRU storing recent query results by normalized query string) is the simplest and most impactful performance optimization for a search engine. If 20% of queries are repeated (a common pattern for popular search terms), the cache eliminates 20% of full query executions. At high QPS, this translates directly to lower latency and higher throughput.

Cache invalidation for query results is simpler than for arbitrary data: every time a document is indexed or deleted, all cached results are potentially stale. The simplest invalidation strategy is to clear the entire cache on any index mutation. More sophisticated strategies use a cache version counter (increment on mutation, include in the cache key) to invalidate only stale entries.

Benchmark-driven optimization (measure before changing, measure after changing, compare) is the discipline this chapter models. The numbers from your benchmarks become the baseline against which every subsequent optimization is measured. Never optimize without a baseline.

### Senior @ FAANG: Performance Optimization as a Systems Engineering Discipline

At senior level, performance optimization for a search engine is a systems engineering discipline that spans multiple layers: query planning (reorder evaluation to minimize intermediate result size), index compression (reduce I/O for posting list reads), parallel query execution (fan out to multiple index shards simultaneously), and result caching (avoid redundant computation for repeated queries).

WAND (Weak AND) is the production query optimization technique for top-K ranked retrieval. Rather than fully evaluating all documents that match any query term, WAND uses score upper bounds to prune documents that cannot possibly appear in the top-K results. For a query with a large union of matching documents, WAND can reduce the evaluated set by 90% or more while guaranteeing the same top-K results. This is the technique that makes Elasticsearch fast for relevance-ranked queries on large corpora.

Memory allocation profiling is the most common optimization opportunity for Go search engines. Posting list intersection allocates new slices for intermediate results. BM25 scoring allocates float64 slices for scores. At high QPS, these allocations create GC pressure that manifests as periodic latency spikes. Using pre-allocated result buffers (from `sync.Pool`) and in-place intersection algorithms eliminates these allocations. Profile with `pprof` before optimizing, not after.

---
