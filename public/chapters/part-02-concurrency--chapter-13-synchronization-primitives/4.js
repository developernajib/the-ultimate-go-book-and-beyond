export default `## 13.3 RWMutex: Reader/Writer Locks

\`sync.RWMutex\` allows multiple concurrent readers OR a single writer.

### Basic Usage

The cache below demonstrates the core \`RWMutex\` contract: read-only methods (\`Get\`, \`GetMultiple\`, \`Size\`) acquire a shared read lock with \`RLock\`/\`RUnlock\`, while mutating methods (\`Set\`, \`SetMultiple\`, \`Delete\`) acquire an exclusive write lock with \`Lock\`/\`Unlock\`. Holding a read lock during a multi-key read is more efficient than locking and unlocking per key because it avoids repeated contention overhead.

\`\`\`go
type Cache struct {
    mu    sync.RWMutex
    items map[string]Item
}

func NewCache() *Cache {
    return &Cache{
        items: make(map[string]Item),
    }
}

// Multiple goroutines can read concurrently
func (c *Cache) Get(key string) (Item, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    item, ok := c.items[key]
    return item, ok
}

// GetMultiple demonstrates holding read lock for multiple reads
func (c *Cache) GetMultiple(keys []string) map[string]Item {
    c.mu.RLock()
    defer c.mu.RUnlock()

    result := make(map[string]Item, len(keys))
    for _, key := range keys {
        if item, ok := c.items[key]; ok {
            result[key] = item
        }
    }
    return result
}

// Writers get exclusive access
func (c *Cache) Set(key string, item Item) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[key] = item
}

// SetMultiple demonstrates holding write lock for batch updates
func (c *Cache) SetMultiple(items map[string]Item) {
    c.mu.Lock()
    defer c.mu.Unlock()

    for key, item := range items {
        c.items[key] = item
    }
}

func (c *Cache) Delete(key string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    delete(c.items, key)
}

// Size returns the number of items
func (c *Cache) Size() int {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return len(c.items)
}
\`\`\`

### When to Use RWMutex vs Mutex

\`RWMutex\` adds bookkeeping overhead compared to a plain \`Mutex\`, so it only pays off when reads significantly outnumber writes and the critical section is long enough for parallelism to matter. A configuration store accessed thousands of times between rare reloads is an ideal candidate, whereas a simple counter that increments on every operation should just use a \`Mutex\`.

\`\`\`go
/*
Decision factors:

1. Read/Write Ratio
   - RWMutex: > 10:1 reads to writes
   - Mutex: < 10:1 or uncertain

2. Critical Section Duration
   - RWMutex: Long read operations benefit from parallelism
   - Mutex: Very short operations (RWMutex overhead dominates)

3. Contention Level
   - RWMutex: High read contention benefits from parallelism
   - Mutex: Low contention (overhead not worth it)
*/

// Configuration store: RWMutex appropriate (read-heavy)
type ConfigStore struct {
    mu     sync.RWMutex
    config map[string]string
}

// Counter: Mutex preferred (writes frequent, operation short)
type Counter struct {
    mu    sync.Mutex
    value int64
}
\`\`\`

### RWMutex Gotchas

The most common mistake is attempting to upgrade a held read lock into a write lock without releasing it first, which causes an immediate deadlock. The \`UpdateIfExists\` example below shows the safe pattern: release \`RLock\`, perform the transformation, then re-acquire \`Lock\` and re-validate the key because the state may have changed during the gap.

\`\`\`go
// Gotcha 1: Cannot upgrade read lock to write lock
func (c *Cache) UpdateIfExists(key string, transform func(Item) Item) bool {
    c.mu.RLock()
    item, ok := c.items[key]
    c.mu.RUnlock()  // Must release read lock first!

    if !ok {
        return false
    }

    newItem := transform(item)

    c.mu.Lock()
    // Must check again - item might have been deleted
    if _, ok := c.items[key]; !ok {
        c.mu.Unlock()
        return false
    }
    c.items[key] = newItem
    c.mu.Unlock()

    return true
}

// Gotcha 2: RLock inside RLock is OK, but RLock then Lock deadlocks
func (c *Cache) DeadlockExample() {
    c.mu.RLock()
    defer c.mu.RUnlock()

    // This will deadlock!
    c.mu.Lock()  // Waiting for RLock to release, but we hold it
    c.mu.Unlock()
}

// Gotcha 3: Writer starvation under heavy reads
// RWMutex gives priority to writers to prevent starvation
// But if readers keep arriving, writer may wait long time
\`\`\`

### Performance Comparison

The benchmarks below run both cache types with full parallelism via \`b.RunParallel\`, which stresses the lock precisely as a production workload would. The results confirm that \`RWMutex\` can be four to five times faster than \`Mutex\` in read-heavy scenarios on multi-core hardware.

\`\`\`go
package main

import (
    "sync"
    "testing"
)

type MutexCache struct {
    mu    sync.Mutex
    items map[string]int
}

type RWMutexCache struct {
    mu    sync.RWMutex
    items map[string]int
}

func BenchmarkMutexRead(b *testing.B) {
    c := &MutexCache{items: map[string]int{"key": 42}}
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            c.mu.Lock()
            _ = c.items["key"]
            c.mu.Unlock()
        }
    })
}

func BenchmarkRWMutexRead(b *testing.B) {
    c := &RWMutexCache{items: map[string]int{"key": 42}}
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            c.mu.RLock()
            _ = c.items["key"]
            c.mu.RUnlock()
        }
    })
}

/*
Results on 8-core machine:
BenchmarkMutexRead-8          10000000    150 ns/op
BenchmarkRWMutexRead-8        50000000     32 ns/op

RWMutex is 4-5x faster for parallel reads!
*/
\`\`\`

### RWMutex Is Often Slower Than Mutex

The benchmark above is misleading. RWMutex wins only when:

- Read critical sections are long (microseconds, not nanoseconds).
- Reads vastly outnumber writes (99% reads at least).
- The workload actually has concurrent readers (not just one reader at a time).

When any of these conditions fails, \`sync.Mutex\` is faster. RWMutex has higher per-operation overhead because it must track both reader and writer counts. For short critical sections (the common case), this overhead dominates the reader concurrency benefit.

The review rule: do not use RWMutex without profile evidence that reads outnumber writes significantly AND readers can actually run concurrently. "My access pattern is read-heavy" is not enough. Benchmark with the real workload.

### Reader Starvation Under Write Pressure

Go's RWMutex implementation starves writers (readers acquiring after a waiting writer is queued must wait). This is the safer default but can cause unexpected latency. If writers lag indefinitely under continuous reads, the workload is pathological for RWMutex. Consider switching to \`sync.Mutex\` with smaller critical sections, or using a different data structure (sharded, copy-on-write).

### Staff Lens: RWMutex as a Premature Optimisation

A significant fraction of RWMutex usage in real codebases is wrong: either the contention does not justify it, or the reads are so short the overhead costs more than it saves. The staff-level review question: "show me the benchmark that proves this is faster than Mutex for this access pattern". If the answer is handwaving, switch to Mutex.

---
`;
