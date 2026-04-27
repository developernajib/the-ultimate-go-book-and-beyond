export default `## 10C.35 Forgetting That Maps Are Not Safe for Concurrent Access

Go maps are **not goroutine-safe**. Concurrent reads are fine, but a concurrent read+write or write+write causes a **fatal runtime panic** - not a data race, but a hard crash. The Go runtime deliberately detects this and kills the program with a message that cannot be recovered.

### The Disaster

Go's built-in map is not goroutine-safe. A concurrent read and write, or two concurrent writes, triggers the runtime's map-concurrency detector and terminates the program with "concurrent map read and map write", a fatal error that cannot be caught with \`recover\`. The race detector (\`-race\`) catches this in testing before it reaches production.

\`\`\`go
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
            m[key] = i // FATAL: concurrent map writes
            // Runtime panic: "fatal error: concurrent map writes"
            // This is NOT recoverable with recover()!
        }()
    }
    wg.Wait()

    // Even concurrent read + write panics:
    // go func() { m["key"] = 1 }()  // write
    // go func() { _ = m["key"] }()  // read - FATAL with concurrent write
}
\`\`\`

The exact panic message:

\`\`\`
fatal error: concurrent map writes

goroutine 18 [running]:
runtime.throw({0x10a3b2e, 0x15})
    /usr/local/go/src/runtime/panic.go:1077 +0x48
runtime.mapassign_faststr(0xc00007e000, {0x10a1e7a, 0x5})
\`\`\`

### Why It's Dangerous

- This panic is **not recoverable** - \`recover()\` cannot catch it
- The race detector (\`-race\`) can detect it, but only if the timing is right during tests
- The bug may appear only under production load when multiple goroutines hit the same map
- It's a complete program crash with no graceful shutdown

### The Fix: sync.RWMutex or sync.Map

Protect shared maps with \`sync.RWMutex\` for general use, or use \`sync.Map\` for write-once-read-many access patterns. A generic wrapper makes the mutex approach type-safe and reusable.

\`\`\`go
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
            sm.Set(key, i) // safe - protected by mutex
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

    // LoadOrStore - atomic "get or set"
    actual, loaded := cache.LoadOrStore("new-key", "default-value")
    fmt.Printf("value=%v, wasLoaded=%v\\n", actual, loaded) // default-value, false

    // Range - iterate (but don't modify during iteration)
    cache.Range(func(key, value any) bool {
        fmt.Printf("  %v: %v\\n", key, value)
        return true // return false to stop iteration
    })
}
\`\`\`

**The Rule:** Never access a Go map from multiple goroutines without synchronization. Use \`sync.RWMutex\` for most cases (type-safe, predictable performance). Use \`sync.Map\` only for write-once-read-many or disjoint-key patterns.

---
`;
