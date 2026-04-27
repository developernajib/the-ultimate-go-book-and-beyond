export default `## 13.15 Exercises with Solutions

### Exercise 1: Thread-Safe LRU Cache

Implement an LRU cache with concurrent access support.

**Solution:** The LRU cache pairs a hash map for O(1) key lookup with a doubly-linked list that tracks recency, the front of the list holds the most recently accessed entry, and the back holds the eviction candidate. A \`sync.RWMutex\` protects both structures. Note that \`Get\` requires a write lock (not a read lock) because it moves the accessed element to the front of the LRU list, which mutates shared state.

\`\`\`go
package cache

import (
    "container/list"
    "sync"
)

type LRUCache[K comparable, V any] struct {
    mu       sync.RWMutex
    capacity int
    items    map[K]*list.Element
    order    *list.List
}

type entry[K comparable, V any] struct {
    key   K
    value V
}

func NewLRUCache[K comparable, V any](capacity int) *LRUCache[K, V] {
    return &LRUCache[K, V]{
        capacity: capacity,
        items:    make(map[K]*list.Element),
        order:    list.New(),
    }
}

func (c *LRUCache[K, V]) Get(key K) (V, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    elem, ok := c.items[key]
    if !ok {
        var zero V
        return zero, false
    }

    // Move to front (most recently used)
    c.order.MoveToFront(elem)
    return elem.Value.(*entry[K, V]).value, true
}

func (c *LRUCache[K, V]) Put(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Update existing
    if elem, ok := c.items[key]; ok {
        c.order.MoveToFront(elem)
        elem.Value.(*entry[K, V]).value = value
        return
    }

    // Evict if at capacity
    if c.order.Len() >= c.capacity {
        oldest := c.order.Back()
        if oldest != nil {
            c.order.Remove(oldest)
            delete(c.items, oldest.Value.(*entry[K, V]).key)
        }
    }

    // Add new entry
    e := &entry[K, V]{key: key, value: value}
    elem := c.order.PushFront(e)
    c.items[key] = elem
}

func (c *LRUCache[K, V]) Delete(key K) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if elem, ok := c.items[key]; ok {
        c.order.Remove(elem)
        delete(c.items, key)
    }
}

func (c *LRUCache[K, V]) Len() int {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.order.Len()
}

// Test
func TestLRUCache(t *testing.T) {
    cache := NewLRUCache[string, int](2)

    cache.Put("a", 1)
    cache.Put("b", 2)

    if v, ok := cache.Get("a"); !ok || v != 1 {
        t.Error("Expected a=1")
    }

    cache.Put("c", 3)  // Evicts "b" (least recently used)

    if _, ok := cache.Get("b"); ok {
        t.Error("Expected b to be evicted")
    }
}
\`\`\`

### Exercise 2: Read-Write Lock with Timeout

Implement a read-write lock that supports timeouts.

**Solution:** Go's standard \`sync.RWMutex\` blocks indefinitely, which is problematic when callers need a deadline. This implementation builds a timeout-aware RWMutex on top of \`sync.Mutex\` and \`sync.Cond\`. A \`pending\` counter gives writer priority, readers back off when a writer is waiting, and the \`RLockContext\`/\`LockContext\` methods periodically wake from \`Cond.Wait\` to check the context deadline.

\`\`\`go
package sync

import (
    "context"
    "sync"
    "time"
)

type TimeoutRWMutex struct {
    mu      sync.Mutex
    cond    *sync.Cond
    readers int
    writer  bool
    pending int  // Pending writers
}

func NewTimeoutRWMutex() *TimeoutRWMutex {
    m := &TimeoutRWMutex{}
    m.cond = sync.NewCond(&m.mu)
    return m
}

func (m *TimeoutRWMutex) RLock() {
    m.mu.Lock()
    defer m.mu.Unlock()

    // Wait while writer active or pending
    for m.writer || m.pending > 0 {
        m.cond.Wait()
    }
    m.readers++
}

func (m *TimeoutRWMutex) RLockTimeout(timeout time.Duration) bool {
    ctx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()
    return m.RLockContext(ctx)
}

func (m *TimeoutRWMutex) RLockContext(ctx context.Context) bool {
    m.mu.Lock()

    for m.writer || m.pending > 0 {
        // Check context before waiting
        select {
        case <-ctx.Done():
            m.mu.Unlock()
            return false
        default:
        }

        // Wait with periodic check
        done := make(chan struct{})
        go func() {
            m.cond.Wait()
            close(done)
        }()

        m.mu.Unlock()

        select {
        case <-done:
            m.mu.Lock()
        case <-ctx.Done():
            m.cond.Broadcast()  // Wake up waiter
            return false
        }
    }

    m.readers++
    m.mu.Unlock()
    return true
}

func (m *TimeoutRWMutex) RUnlock() {
    m.mu.Lock()
    defer m.mu.Unlock()

    m.readers--
    if m.readers == 0 {
        m.cond.Broadcast()
    }
}

func (m *TimeoutRWMutex) Lock() {
    m.mu.Lock()
    defer m.mu.Unlock()

    m.pending++
    for m.readers > 0 || m.writer {
        m.cond.Wait()
    }
    m.pending--
    m.writer = true
}

func (m *TimeoutRWMutex) LockTimeout(timeout time.Duration) bool {
    ctx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()
    return m.LockContext(ctx)
}

func (m *TimeoutRWMutex) LockContext(ctx context.Context) bool {
    m.mu.Lock()

    m.pending++
    defer func() {
        if m.pending > 0 {
            m.pending--
        }
    }()

    for m.readers > 0 || m.writer {
        select {
        case <-ctx.Done():
            m.pending--
            m.mu.Unlock()
            m.cond.Broadcast()
            return false
        default:
        }

        done := make(chan struct{})
        go func() {
            m.cond.Wait()
            close(done)
        }()

        m.mu.Unlock()

        select {
        case <-done:
            m.mu.Lock()
        case <-ctx.Done():
            m.cond.Broadcast()
            return false
        }
    }

    m.writer = true
    m.mu.Unlock()
    return true
}

func (m *TimeoutRWMutex) Unlock() {
    m.mu.Lock()
    defer m.mu.Unlock()

    m.writer = false
    m.cond.Broadcast()
}
\`\`\`

### Exercise 3: Concurrent-Safe Set with Iterator

Implement a thread-safe set that supports safe iteration.

**Solution:** The set uses \`map[T]struct{}\` as its backing store, the zero-size \`struct{}\` value means the map tracks membership without wasting memory on values. An \`RWMutex\` allows concurrent \`Contains\` and \`ForEach\` calls while serializing \`Add\` and \`Remove\`. The \`Snapshot\` method returns a copy of the elements, allowing the caller to iterate without holding the lock, which avoids the deadlock risk that arises when a callback in \`ForEach\` tries to modify the set.

\`\`\`go
package collections

import (
    "sync"
)

type Set[T comparable] struct {
    mu    sync.RWMutex
    items map[T]struct{}
}

func NewSet[T comparable]() *Set[T] {
    return &Set[T]{
        items: make(map[T]struct{}),
    }
}

func (s *Set[T]) Add(item T) bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    if _, exists := s.items[item]; exists {
        return false
    }
    s.items[item] = struct{}{}
    return true
}

func (s *Set[T]) Remove(item T) bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    if _, exists := s.items[item]; !exists {
        return false
    }
    delete(s.items, item)
    return true
}

func (s *Set[T]) Contains(item T) bool {
    s.mu.RLock()
    defer s.mu.RUnlock()

    _, exists := s.items[item]
    return exists
}

func (s *Set[T]) Size() int {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return len(s.items)
}

// Snapshot returns a copy for safe iteration
func (s *Set[T]) Snapshot() []T {
    s.mu.RLock()
    defer s.mu.RUnlock()

    result := make([]T, 0, len(s.items))
    for item := range s.items {
        result = append(result, item)
    }
    return result
}

// ForEach iterates with read lock held
func (s *Set[T]) ForEach(fn func(T) bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    for item := range s.items {
        if !fn(item) {
            return
        }
    }
}

// Union returns new set with items from both
func (s *Set[T]) Union(other *Set[T]) *Set[T] {
    result := NewSet[T]()

    s.ForEach(func(item T) bool {
        result.Add(item)
        return true
    })

    other.ForEach(func(item T) bool {
        result.Add(item)
        return true
    })

    return result
}

// Intersection returns new set with common items
func (s *Set[T]) Intersection(other *Set[T]) *Set[T] {
    result := NewSet[T]()

    s.ForEach(func(item T) bool {
        if other.Contains(item) {
            result.Add(item)
        }
        return true
    })

    return result
}

// Test
func TestConcurrentSet(t *testing.T) {
    set := NewSet[int]()

    var wg sync.WaitGroup

    // Concurrent adds
    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            set.Add(n % 100)  // Add numbers 0-99
        }(i)
    }

    wg.Wait()

    if set.Size() != 100 {
        t.Errorf("Expected 100 items, got %d", set.Size())
    }
}
\`\`\`

### Senior at FAANG Track

5. **Mutex contention audit.** For one production service, enable mutex profiling for a week. Identify the top three contention hotspots. Propose fixes. Measure improvement after rollout.

6. **RWMutex audit.** Grep for every \`sync.RWMutex\` in your team's code. For each, determine whether the read/write ratio justifies RWMutex over Mutex. Convert the ones that do not. Measure.

7. **sync.Pool audit.** Find every \`sync.Pool\` in your codebase. For each, verify the objects pooled are stateless (or reset on get), reasonably-sized, and actually hot-path allocations. Remove any that do not meet the criteria. Benchmark before and after.

### Staff / Principal Track

8. **Synchronization convention document.** Write the org's synchronization convention guide: when to use Mutex, when RWMutex, when atomics, when channels. Include team-specific examples. Publish. Maintain quarterly as Go evolves.

9. **Lock-free design review.** When a team proposes a lock-free data structure, run a design review covering: profile evidence justifying the complexity, correctness proof or library reference, maintenance story. Most proposals fail this review; approve only the ones that pass.

10. **High-contention redesign.** For one service with a known contention bottleneck, lead the redesign: sharding, lock-free structure, or architectural elimination of the shared state. Document the process as a case study for future work.

11. **Atomic-style migration.** For a large codebase that uses the old function-based \`sync/atomic\` (\`atomic.AddInt64(&x, 1)\`), drive migration to the Go 1.19+ typed atomics (\`atomic.Int64.Add(1)\`). Measure the code-quality improvement (type safety, readability) and any performance delta.

12. **Synchronization postmortem template.** Create a template for synchronization-related incidents. Include sections for which primitive failed, what alternative would have prevented it, and what process or tooling improvement comes out of the incident. Apply retroactively to three past incidents. Extract systemic lessons.

---
`;
