## 13.3 RWMutex: Reader/Writer Locks

`sync.RWMutex` allows multiple concurrent readers OR a single writer.

### Basic Usage

The cache below demonstrates the core `RWMutex` contract: read-only methods (`Get`, `GetMultiple`, `Size`) acquire a shared read lock with `RLock`/`RUnlock`, while mutating methods (`Set`, `SetMultiple`, `Delete`) acquire an exclusive write lock with `Lock`/`Unlock`. Holding a read lock during a multi-key read is more efficient than locking and unlocking per key because it avoids repeated contention overhead.

```go
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
```

### When to Use RWMutex vs Mutex

`RWMutex` adds bookkeeping overhead compared to a plain `Mutex`, so it only pays off when reads significantly outnumber writes and the critical section is long enough for parallelism to matter. A configuration store accessed thousands of times between rare reloads is an ideal candidate, whereas a simple counter that increments on every operation should just use a `Mutex`.

```go
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
```

### RWMutex Gotchas

The most common mistake is attempting to upgrade a held read lock into a write lock without releasing it first, which causes an immediate deadlock. Go's `RWMutex` supports neither upgrading a read lock to a write lock nor downgrading a write lock to a read lock. The `UpdateIfExists` example below shows the safe pattern: release `RLock`, perform the transformation, then re-acquire `Lock` and re-validate the key because the state may have changed during the gap.

The second mistake is more dangerous because it usually passes tests. **Recursive read-locking is prohibited.** It is tempting to assume that because many readers may hold the lock at once, one goroutine may take `RLock` twice. It may not. The `sync` documentation is explicit: when a writer is blocked on `Lock`, new `RLock` calls block so that the writer eventually gets in. If a goroutine holding a read lock then calls `RLock` again, and a writer queued up in between, the goroutine waits for a writer that is waiting for the goroutine's own first read lock. That is a deadlock, and it only manifests when a write happens to arrive in the window between the two reads, which is exactly why it survives testing and fails under production load.

```go
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

// Gotcha 2: RLock then Lock always deadlocks
func (c *Cache) DeadlockExample() {
    c.mu.RLock()
    defer c.mu.RUnlock()

    // This will deadlock!
    c.mu.Lock() // Waiting for RLock to release, but we hold it
    c.mu.Unlock()
}

// Gotcha 3: Recursive read-locking is NOT safe either.
// It appears to work in testing and deadlocks in production.
func (c *Cache) RecursiveRLockIsABug(key string) (Item, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.Get(key) // Get takes RLock again. This can deadlock.
}

// Gotcha 4: A pending writer blocks new readers
// Once a goroutine is blocked on Lock, newly arriving RLock calls
// queue behind it, so the writer waits only for the current readers
// to finish. This prevents writer starvation, but can delay readers
// under sustained write pressure.
```

### Performance Comparison

The benchmarks below run both cache types with full parallelism via `b.RunParallel`, which stresses the lock the way a production workload would. Run them yourself before you believe any claim about which lock is faster, including the claims in this book. Notice that the benchmark comes in two flavors: one where the read critical section is a single map lookup, and one where it takes a few microseconds. The gap between those two results is the whole lesson.

```go
package main

import (
    "sync"
    "testing"
    "time"
)

type MutexCache struct {
    mu    sync.Mutex
    items map[string]int
}

type RWMutexCache struct {
    mu    sync.RWMutex
    items map[string]int
}

// Short critical section: one map lookup.
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

// Long critical section: the lookup plus a few microseconds of work.
func BenchmarkMutexReadLong(b *testing.B) {
    c := &MutexCache{items: map[string]int{"key": 42}}
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            c.mu.Lock()
            _ = c.items["key"]
            busy(5 * time.Microsecond)
            c.mu.Unlock()
        }
    })
}

func BenchmarkRWMutexReadLong(b *testing.B) {
    c := &RWMutexCache{items: map[string]int{"key": 42}}
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            c.mu.RLock()
            _ = c.items["key"]
            busy(5 * time.Microsecond)
            c.mu.RUnlock()
        }
    })
}

func busy(d time.Duration) {
    end := time.Now().Add(d)
    for time.Now().Before(end) {
    }
}
```

Measured on an 8-core laptop CPU. Your numbers will differ, and that is the point:

```
BenchmarkMutexRead-8         	 6671510	        52.66 ns/op
BenchmarkRWMutexRead-8       	 7761956	        45.54 ns/op
BenchmarkMutexReadLong-8     	   68643	      5271 ns/op
BenchmarkRWMutexReadLong-8   	  520665	       670.1 ns/op
```

Read the two pairs separately. With a single map lookup under the lock, `RWMutex` is about 1.15x faster than `Mutex`: barely worth the extra type name, let alone the extra reasoning. The reason is that `RLock` still performs an atomic read-modify-write on a shared counter, so eight cores fighting over one cache line pay most of what they would have paid for a plain `Mutex` anyway. There is no reader concurrency to win, because the critical section is over before a second reader can overlap with it.

Add five microseconds of work under the lock and `RWMutex` becomes roughly 7.9x faster, because now the readers genuinely overlap and eight of them make progress at once while `Mutex` serializes them into a single-file queue.

So the honest summary is not "RWMutex is faster". It is: **RWMutex converts reader concurrency into throughput, and it can only do that if there is reader concurrency to convert.** A nanosecond-long critical section has none.

### RWMutex Is Often Slower Than Mutex

The short-critical-section benchmark above is the case most codebases actually have. RWMutex wins only when:

- Read critical sections are long (microseconds, not nanoseconds).
- Reads vastly outnumber writes (99% reads at least).
- The workload actually has concurrent readers (not just one reader at a time).

When any of these conditions fails, `sync.Mutex` is faster. RWMutex has higher per-operation overhead because it must track both reader and writer counts. For short critical sections (the common case), this overhead dominates the reader concurrency benefit.

The review rule: do not use RWMutex without profile evidence that reads outnumber writes significantly AND readers can actually run concurrently. "My access pattern is read-heavy" is not enough. Benchmark with the real workload.

### Reader Starvation Under Write Pressure

Go's RWMutex deliberately refuses to starve writers. The `sync.RWMutex` documentation puts it plainly: "If any goroutine calls Lock while the lock is already held by one or more readers, concurrent calls to RLock will block until the writer has acquired (and released) the lock, to ensure that the lock eventually becomes available to the writer." Newly arriving readers queue behind a waiting writer rather than jumping ahead. That is the guarantee that makes recursive read-locking unsafe, and it is the same guarantee that means under sustained write pressure readers can be delayed indefinitely. If readers lag badly under continuous writes, the workload is pathological for RWMutex. Consider switching to `sync.Mutex` with smaller critical sections, or using a different data structure (sharded, copy-on-write).

### Staff Lens: RWMutex as a Premature Optimization

A significant fraction of RWMutex usage in real codebases is wrong: either the contention does not justify it, or the reads are so short the overhead costs more than it saves. The staff-level review question: "show me the benchmark that proves this is faster than Mutex for this access pattern". If the answer is handwaving, switch to Mutex.

---
