## Part 2: Key-Value Store with LRU Eviction

### Thread-Safe KV Store

The key-value store is the heart of GoCache. It stores all cached data in a Go `map` and uses a doubly linked list to track access order for LRU (Least Recently Used) eviction. Because multiple client connections read and write concurrently, every operation must be protected by a `sync.RWMutex` to prevent data races. When the store exceeds its configured memory limit, it automatically removes the least recently accessed entries to make room for new ones. A background goroutine also runs periodically to clean up keys that have expired based on their TTL.

```go
// internal/store/store.go
package store

import (
    "container/list"
    "sync"
    "time"
)

type entry struct {
    key       string
    value     []byte
    expiresAt *time.Time
    element   *list.Element // For LRU
}

type Store struct {
    mu          sync.RWMutex
    data        map[string]*entry
    lru         *list.List
    maxMemory   int64
    currentSize int64
    stats       *Stats
}

type Stats struct {
    Hits      int64
    Misses    int64
    Evictions int64
    Keys      int64
}

func NewStore(maxMemory int64) *Store {
    s := &Store{
        data:      make(map[string]*entry),
        lru:       list.New(),
        maxMemory: maxMemory,
        stats:     &Stats{},
    }

    // Start expiration cleanup goroutine
    go s.cleanupExpired()

    return s
}

func (s *Store) Get(key string) ([]byte, bool) {
    s.mu.Lock()
    defer s.mu.Unlock()

    e, exists := s.data[key]
    if !exists {
        s.stats.Misses++
        return nil, false
    }

    // Check expiration
    if e.expiresAt != nil && time.Now().After(*e.expiresAt) {
        s.deleteEntry(key, e)
        s.stats.Misses++
        return nil, false
    }

    // Update LRU
    s.lru.MoveToFront(e.element)
    s.stats.Hits++

    return e.value, true
}

func (s *Store) Set(key string, value []byte, ttl *time.Duration) {
    s.mu.Lock()
    defer s.mu.Unlock()

    // Check if key exists
    if e, exists := s.data[key]; exists {
        // Update existing entry
        s.currentSize -= int64(len(e.value))
        s.currentSize += int64(len(value))

        e.value = value
        if ttl != nil {
            expiresAt := time.Now().Add(*ttl)
            e.expiresAt = &expiresAt
        } else {
            e.expiresAt = nil
        }

        s.lru.MoveToFront(e.element)
    } else {
        // Create new entry
        newSize := s.currentSize + int64(len(key)) + int64(len(value))

        // Evict if necessary
        for newSize > s.maxMemory && s.lru.Len() > 0 {
            s.evictLRU()
            newSize = s.currentSize + int64(len(key)) + int64(len(value))
        }

        var expiresAt *time.Time
        if ttl != nil {
            exp := time.Now().Add(*ttl)
            expiresAt = &exp
        }

        elem := s.lru.PushFront(key)
        e := &entry{
            key:       key,
            value:     value,
            expiresAt: expiresAt,
            element:   elem,
        }

        s.data[key] = e
        s.currentSize += int64(len(key)) + int64(len(value))
        s.stats.Keys++
    }
}

func (s *Store) Delete(key string) bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    e, exists := s.data[key]
    if !exists {
        return false
    }

    s.deleteEntry(key, e)
    return true
}

func (s *Store) deleteEntry(key string, e *entry) {
    s.lru.Remove(e.element)
    delete(s.data, key)
    s.currentSize -= int64(len(key)) + int64(len(e.value))
    s.stats.Keys--
}

func (s *Store) evictLRU() {
    elem := s.lru.Back()
    if elem == nil {
        return
    }

    key := elem.Value.(string)
    e := s.data[key]
    s.deleteEntry(key, e)
    s.stats.Evictions++
}

func (s *Store) TTL(key string) (int64, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    e, exists := s.data[key]
    if !exists {
        return -2, false // Key doesn't exist
    }

    if e.expiresAt == nil {
        return -1, true // No expiration
    }

    ttl := time.Until(*e.expiresAt)
    if ttl < 0 {
        return -2, false // Already expired
    }

    return int64(ttl.Seconds()), true
}

func (s *Store) Expire(key string, ttl time.Duration) bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    e, exists := s.data[key]
    if !exists {
        return false
    }

    expiresAt := time.Now().Add(ttl)
    e.expiresAt = &expiresAt
    return true
}

func (s *Store) cleanupExpired() {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for range ticker.C {
        s.mu.Lock()

        now := time.Now()
        expired := make([]string, 0)

        // Collect expired keys (max 100 per cycle)
        count := 0
        for key, e := range s.data {
            if e.expiresAt != nil && now.After(*e.expiresAt) {
                expired = append(expired, key)
                count++
                if count >= 100 {
                    break
                }
            }
        }

        // Delete expired keys
        for _, key := range expired {
            if e, exists := s.data[key]; exists {
                s.deleteEntry(key, e)
            }
        }

        s.mu.Unlock()
    }
}

func (s *Store) GetStats() Stats {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return *s.stats
}

func (s *Store) Size() int64 {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return s.currentSize
}

func (s *Store) Keys() []string {
    s.mu.RLock()
    defer s.mu.RUnlock()

    keys := make([]string, 0, len(s.data))
    for k := range s.data {
        keys = append(keys, k)
    }
    return keys
}
```

---

### Junior → FAANG: LRU as a Classic Interview Data Structure

LRU (Least Recently Used) eviction is one of the most commonly tested data structure topics in FAANG interviews. The O(1) implementation requires a combination of a hash map (for O(1) key lookup) and a doubly linked list (for O(1) move-to-front on access and O(1) remove-from-tail on eviction). Know this data structure implementation by heart.

The `sync.RWMutex` usage (read lock for reads, write lock for writes) is the correct concurrency pattern for a cache with many concurrent readers. `RLock` allows multiple concurrent readers. `Lock` gives exclusive access for writes. Know when to use each.

TTL-based expiration (background goroutine periodically scanning and evicting expired keys) is the lazy eviction strategy. The alternative is eager eviction (check TTL on every read). Lazy eviction is more efficient for large key spaces where most keys have long TTLs. Eager eviction (also called "passive expiration") is efficient for key spaces where most reads are on recently accessed keys. Redis uses both: lazy expiration on read, plus a periodic background scan for keys that are never read again.

### Senior @ FAANG: Memory Management as a Performance and Reliability Concern

At senior level, the LRU eviction policy is a memory management contract. The cache must never exceed its configured memory limit, and must maintain consistent performance (O(1) eviction) as it approaches the limit. If the eviction policy is O(n) (linear scan to find the LRU entry), performance degrades as the cache fills.

Sharded locking (splitting the key space into N shards, each with its own mutex) is the standard optimization for high-concurrency caches. A single `sync.RWMutex` serializes all concurrent writes. With 16 shards and a good hash function, write throughput scales with the number of shards until CPU becomes the bottleneck. Measure the throughput difference between single-lock and sharded-lock implementations at your target concurrency level before committing to the additional complexity.

Memory fragmentation is a Go-specific concern for long-running cache servers. The Go allocator releases memory to the OS lazily. A cache that fills and then partially evicts may retain OS memory for minutes. For a production cache server where memory is a billing cost, configuring `GOMEMLIMIT` and `GOGC` to force more aggressive GC is appropriate. Profile memory behavior under production load patterns before tuning these parameters.

---
