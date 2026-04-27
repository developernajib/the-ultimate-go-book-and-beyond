export default `## 10C.8 Map Concurrent Write Panic

Go's built-in \`map\` type is not safe for concurrent use. If two or more goroutines read and write to the same map simultaneously without synchronization, the Go runtime detects this and triggers a fatal panic with the message "concurrent map writes." This panic cannot be recovered with \`recover()\` - it terminates the entire program. The race detector (\`-race\` flag) can help find these bugs in tests, but they often only appear under real production load when multiple goroutines happen to access the map at the same time.

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

func main() {
    m := make(map[string]int)

    // DISASTER: concurrent map write
    // Go's map is NOT goroutine-safe
    // This will panic: "concurrent map writes" (detected by the runtime)
    var wg sync.WaitGroup
    for i := range 100 {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            key := fmt.Sprintf("key%d", n%10)
            m[key] = n // PANIC: concurrent map writes
        }(i)
    }
    wg.Wait()
}
\`\`\`

### The Fixes

Multiple correct approaches exist depending on performance requirements and access patterns. The choice between \`sync.RWMutex\` and \`sync.Map\` depends on the read/write ratio and whether the key set is stable.

\`\`\`go
package main

import (
    "fmt"
    "sync"
    "sync/atomic"
)

// FIX 1: Mutex-protected map (most common)
type SafeMap struct {
    mu sync.RWMutex
    m  map[string]int
}

func NewSafeMap() *SafeMap {
    return &SafeMap{m: make(map[string]int)}
}

func (sm *SafeMap) Set(key string, value int) {
    sm.mu.Lock()
    defer sm.mu.Unlock()
    sm.m[key] = value
}

func (sm *SafeMap) Get(key string) (int, bool) {
    sm.mu.RLock()
    defer sm.mu.RUnlock()
    v, ok := sm.m[key]
    return v, ok
}

// FIX 2: sync.Map (for highly concurrent read-heavy workloads)
func useSyncMap() {
    var m sync.Map

    m.Store("key", 42)

    if v, ok := m.Load("key"); ok {
        fmt.Println(v.(int)) // 42
    }

    // LoadOrStore: atomic get-or-set
    actual, loaded := m.LoadOrStore("key2", 100)
    fmt.Println(actual, loaded) // 100 false (first time = not loaded)

    m.Range(func(k, v any) bool {
        fmt.Println(k, v)
        return true // continue iteration
    })
}

// FIX 3: atomic.Value for read-heavy, infrequent-write maps
type AtomicMapStore struct {
    v atomic.Value
}

func (a *AtomicMapStore) Load() map[string]int {
    v := a.v.Load()
    if v == nil {
        return nil
    }
    return v.(map[string]int)
}

func (a *AtomicMapStore) Store(m map[string]int) {
    a.v.Store(m) // Store a copy of the map - replace atomically
}

// FIX 4: Sharded map - reduce contention at scale
type ShardedMap struct {
    shards [256]*SafeMap
}

func NewShardedMap() *ShardedMap {
    sm := &ShardedMap{}
    for i := range 256 {
        sm.shards[i] = NewSafeMap()
    }
    return sm
}

func (sm *ShardedMap) shard(key string) *SafeMap {
    hash := uint8(key[0]) // simple hash - use fnv for production
    return sm.shards[hash]
}

func (sm *ShardedMap) Set(key string, value int) {
    sm.shard(key).Set(key, value)
}
\`\`\`

---
`;
