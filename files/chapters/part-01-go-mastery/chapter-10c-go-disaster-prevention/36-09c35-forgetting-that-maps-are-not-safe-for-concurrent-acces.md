## 10C.35 Forgetting That Maps Are Not Safe for Concurrent Access

Go maps are **not goroutine-safe**. Concurrent reads are fine. A concurrent read+write or write+write is a data race, and the runtime carries a cheap flag inside the map implementation that usually notices and kills the process outright. Note the word *usually*: the check is a best-effort backstop, not a guarantee. When it fires you get a **fatal error**, not a panic, so `recover()` is not involved and cannot help. When it does not fire, you get a silently corrupted map instead, which is worse.

### The Disaster

Go's built-in map is not goroutine-safe. A concurrent read and write, or two concurrent writes, will often trip the runtime's map-concurrency check and terminate the program with "concurrent map read and map write" or "concurrent map writes". That is a fatal error, and `recover` does not catch it. The check is opportunistic, though, so treat a clean run as no evidence at all. `-race` is the tool that actually settles the question.

```go
package main

import (
    "fmt"
    "sync"
)

func main() {
    // WRONG: concurrent map access without synchronization
    m := make(map[string]int)

    var wg sync.WaitGroup
    for i := range 100 {
        wg.Add(1)
        go func() {
            defer wg.Done()
            key := fmt.Sprintf("key-%d", i%10)
            m[key] = i // "fatal error: concurrent map writes", most runs
            // recover() cannot catch this. On the runs where the check does
            // not fire, the map is corrupted instead and nothing is said.
        }()
    }
    wg.Wait()

    // Even concurrent read + write is FATAL:
    // go func() { m["key"] = 1 }()  // write
    // go func() { _ = m["key"] }()  // read - FATAL with concurrent write
}
```

The crash looks like this (addresses and line numbers vary by build):

```
fatal error: concurrent map writes

goroutine 18 [running]:
runtime.throw(...)
    .../src/runtime/panic.go
runtime.mapassign_faststr(...)
```

### Why It's Dangerous

- It is a fatal error, not a panic, so `recover()` cannot catch it and no deferred cleanup runs
- The runtime check is a backstop, not a detector. It may not fire, in which case the map is quietly corrupted and the wrong answer shows up somewhere else entirely.
- `-race` is not timing-dependent in the way people assume. It tracks happens-before relationships, so it reports the race whenever both accesses execute, even if they were seconds apart and never actually overlapped. The catch is that the racing code has to *run*: a test that never exercises the concurrent path finds nothing.
- Without `-race` in CI, the bug surfaces under production load, where concurrency is real
- The crash is total. No graceful shutdown, no draining, no in-flight requests completed.

### The Fix: sync.RWMutex or sync.Map

Protect shared maps with `sync.RWMutex` for general use, or use `sync.Map` for write-once-read-many access patterns. A generic wrapper makes the mutex approach type-safe and reusable.

```go
package main

import (
    "fmt"
    "sync"
)

// --- Pattern 1: Map protected by sync.RWMutex (recommended for most cases) ---

type SafeMap[K comparable, V any] struct {
    mu sync.RWMutex
    m  map[K]V
}

func NewSafeMap[K comparable, V any]() *SafeMap[K, V] {
    return &SafeMap[K, V]{m: make(map[K]V)}
}

func (sm *SafeMap[K, V]) Set(key K, value V) {
    sm.mu.Lock()
    defer sm.mu.Unlock()
    sm.m[key] = value
}

func (sm *SafeMap[K, V]) Get(key K) (V, bool) {
    sm.mu.RLock()
    defer sm.mu.RUnlock()
    val, ok := sm.m[key]
    return val, ok
}

func (sm *SafeMap[K, V]) Delete(key K) {
    sm.mu.Lock()
    defer sm.mu.Unlock()
    delete(sm.m, key)
}

func (sm *SafeMap[K, V]) Len() int {
    sm.mu.RLock()
    defer sm.mu.RUnlock()
    return len(sm.m)
}

// --- Pattern 2: sync.Map (for specific use cases) ---
// Use sync.Map when:
//   1. Keys are written once and read many times (cache pattern)
//   2. Multiple goroutines read/write disjoint sets of keys
// Do NOT use sync.Map when:
//   1. You need type safety (sync.Map uses any for keys and values)
//   2. You need to iterate frequently
//   3. Write patterns are uniform across keys

func main() {
    // Pattern 1: RWMutex-based safe map
    sm := NewSafeMap[string, int]()

    var wg sync.WaitGroup
    for i := range 100 {
        wg.Add(1)
        go func() {
            defer wg.Done()
            key := fmt.Sprintf("key-%d", i%10)
            sm.Set(key, i) // safe, the mutex serializes every write
        }()
    }
    wg.Wait()
    fmt.Println("safe map length:", sm.Len()) // 10

    // Pattern 2: sync.Map for cache-like patterns
    var cache sync.Map

    // Store
    cache.Store("config-key", "config-value")

    // Load
    if val, ok := cache.Load("config-key"); ok {
        fmt.Println("cached:", val.(string))
    }

    // LoadOrStore: an atomic "get or set", which a mutex-based map can only
    // match with an explicit lock around both halves
    actual, loaded := cache.LoadOrStore("new-key", "default-value")
    fmt.Printf("value=%v, wasLoaded=%v\n", actual, loaded) // default-value, false

    // Range walks a snapshot rather than taking a global lock, so it is not
    // a consistent point-in-time view: entries added during the walk may or
    // may not appear. Never treat it as an atomic iteration.
    cache.Range(func(key, value any) bool {
        fmt.Printf("  %v: %v\n", key, value)
        return true // return false to stop early
    })
}
```

**The Rule:** Never access a Go map from multiple goroutines without synchronization. Use `sync.RWMutex` for most cases (type-safe, predictable performance). Use `sync.Map` only for write-once-read-many or disjoint-key patterns.

---
