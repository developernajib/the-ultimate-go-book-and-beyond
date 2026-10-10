## 10C.8 Map Concurrent Write Panic

Go's built-in `map` type is not safe for concurrent use. If two or more goroutines read and write the same map without synchronization, the runtime will often catch it and kill the process with "concurrent map writes" or "concurrent map read and map write". That check is a cheap best-effort flag inside the map implementation, not a guarantee, so the same code can also just silently corrupt the map and surface as a wrong answer or a crash somewhere unrelated later. Either way it is a fatal throw, not a panic, so `recover()` does not catch it and the whole program dies. The race detector (`-race`) reliably finds these in tests, which is exactly why the unsynchronized map usually reaches production first.

```go
package main

import (
    "fmt"
    "sync"
)

func main() {
    m := make(map[string]int)

    // DISASTER: concurrent map write.
    // Go's map is NOT goroutine-safe. This usually dies with
    // "fatal error: concurrent map writes", and when it does not, it is
    // corrupting the map instead. Neither outcome is recoverable.
    var wg sync.WaitGroup
    for i := range 100 {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            key := fmt.Sprintf("key%d", n%10)
            m[key] = n // fatal error: concurrent map writes
        }(i)
    }
    wg.Wait()
}
```

### The Fixes

Multiple correct approaches exist depending on performance requirements and access patterns. The choice between `sync.RWMutex` and `sync.Map` depends on the read/write ratio and whether the key set is stable.

```go
package main

import (
    "fmt"
    "hash/fnv"
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

// Store swaps in a whole new map. Readers keep using the old one until the
// swap lands. The contract is that nobody mutates a map after storing it:
// atomic.Value protects the pointer, not the contents behind it.
func (a *AtomicMapStore) Store(m map[string]int) {
    a.v.Store(m)
}

// FIX 4: sharded map, to cut lock contention at scale
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
    // Hash the whole key. Two traps live in the obvious `key[0]` version:
    // it panics on an empty key, and it puts every key sharing a first byte
    // into one shard, which is exactly the contention you came to remove.
    h := fnv.New32a()
    h.Write([]byte(key))
    return sm.shards[h.Sum32()%uint32(len(sm.shards))]
}

func (sm *ShardedMap) Set(key string, value int) {
    sm.shard(key).Set(key, value)
}
```

---
