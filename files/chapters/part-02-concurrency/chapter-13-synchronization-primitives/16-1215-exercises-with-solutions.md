## 13.15 Exercises with Solutions

### Exercise 1: Thread-Safe LRU Cache

Implement an LRU cache with concurrent access support.

**Solution:** The LRU cache pairs a hash map for O(1) key lookup with a doubly-linked list that tracks recency. The front of the list holds the most recently accessed entry, and the back holds the eviction candidate.

The interesting design decision is the lock, and the answer is `sync.Mutex`, not `sync.RWMutex`. This surprises people, so be precise about why: **`Get` mutates shared state.** Reading a key moves its element to the front of the LRU list, which is a write to the list. If `Get` must take the write lock, then every operation on this cache takes the write lock, and an `RWMutex` would be a `Mutex` with extra overhead and a misleading name. Section 13.11 walks through this exact trap.

So use a `Mutex` and be honest about it. `Len` is the only genuine read-only method here, and one read-only method does not justify an `RWMutex`.

If you want an LRU cache whose reads are genuinely concurrent, you must stop maintaining exact recency on the read path: track recency with an atomic timestamp per entry and evict by sampling, or use a library like `dgraph-io/ristretto` that batches access records through a ring buffer for exactly this reason. That is a different exercise and a much harder one. Exact LRU and concurrent reads are in tension, and pretending otherwise with an `RWMutex` gets you the costs of both and the benefits of neither.

```go
package cache

import (
    "container/list"
    "sync"
)

type LRUCache[K comparable, V any] struct {
    // Mutex, not RWMutex: Get moves an element to the front of the LRU
    // list, so every operation is a writer. See the discussion above.
    mu       sync.Mutex
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
    c.mu.Lock()
    defer c.mu.Unlock()
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
```

### Exercise 2: Read-Write Lock with Timeout

Implement a read-write lock that supports timeouts.

Go's standard `sync.RWMutex` blocks indefinitely, which is a problem when callers need a deadline. This exercise looks easy and is a trap. Try it yourself before reading on.

**The approach that cannot work:** building it on `sync.Cond`.

The instinct is to keep the familiar `Cond` skeleton and bolt a timeout on by pushing the `Wait` into a goroutine and racing it against `ctx.Done()`:

```go
// DO NOT DO THIS. It is broken in at least four ways.
done := make(chan struct{})
go func() {
    m.cond.Wait() // called from a goroutine that does NOT hold m.mu
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
```

Run that and the process dies:

```
fatal error: sync: unlock of unlocked mutex
```

Not a panic you can recover, a `fatal error` that takes the program with it. Here is why, and each reason is independently fatal:

1. **`Cond.Wait` must be called by the goroutine that holds the lock.** `Wait` begins by calling `m.mu.Unlock()`. Here the *parent* holds `m.mu` and a *child* calls `Wait`, so the child unlocks a mutex it never locked, racing the parent's own `Unlock`. Whichever loses hits "unlock of unlocked mutex".
2. **`Wait` returns with the lock held.** If the child ever gets that far, it re-acquires `m.mu` inside `Wait` and then exits without unlocking. `m.mu` is now locked forever with no owner, and every future operation on the lock hangs.
3. **`case <-ctx.Done(): return false` leaks the child.** It is still parked in `Wait`, and `Cond.Wait` is uninterruptible, so it stays parked until some unrelated `Broadcast` arrives. Every timed-out acquisition leaks a goroutine.
4. **The `Broadcast` is a lie.** It wakes *every* waiter on the `Cond`, so unrelated goroutines wake, re-check their predicates, and go back to sleep. Waking everyone to cancel one waiter is how you turn a timeout into a thundering herd.

The root cause is the one stated in section 13.6: **`sync.Cond.Wait` cannot be cancelled, and no wrapper can make it cancellable.** There is no `WaitContext`, and you cannot build one. Cancellation in Go composes through `select`, and `select` only works on channels. A primitive that does not park on a channel cannot participate. Recognizing that a primitive is the wrong foundation, rather than engineering harder around it, is the actual skill this exercise tests.

**Solution:** model the lock as a weighted semaphore.

An RWMutex is a semaphore with `N` slots. A reader takes one slot. A writer takes all `N`, which is exactly what "excludes all readers and all other writers" means. `golang.org/x/sync/semaphore` already implements weighted acquisition with context support and FIFO waiter queueing, and it parks on channels, so cancellation composes for free.

```go
package rwlock

import (
    "context"

    "golang.org/x/sync/semaphore"
)

// maxReaders is the number of concurrent readers allowed. A writer acquires
// all of them at once, which is what makes it exclusive.
const maxReaders = 1 << 16

// TimeoutRWMutex is an RWMutex whose acquisitions honor a context.
// It is built on a semaphore rather than sync.Cond because Cond.Wait
// cannot be interrupted.
type TimeoutRWMutex struct {
    sem *semaphore.Weighted
}

func NewTimeoutRWMutex() *TimeoutRWMutex {
    return &TimeoutRWMutex{sem: semaphore.NewWeighted(maxReaders)}
}

// RLock acquires one reader slot. Returns ctx.Err() if cancelled.
func (m *TimeoutRWMutex) RLock(ctx context.Context) error {
    return m.sem.Acquire(ctx, 1)
}

func (m *TimeoutRWMutex) RUnlock() { m.sem.Release(1) }

// Lock acquires every reader slot, which excludes all readers and writers.
func (m *TimeoutRWMutex) Lock(ctx context.Context) error {
    return m.sem.Acquire(ctx, maxReaders)
}

func (m *TimeoutRWMutex) Unlock() { m.sem.Release(maxReaders) }

// TryLock variants come free: TryAcquire never blocks.
func (m *TimeoutRWMutex) TryRLock() bool { return m.sem.TryAcquire(1) }
func (m *TimeoutRWMutex) TryLock() bool  { return m.sem.TryAcquire(maxReaders) }
```

Verified under `-race` with 200 goroutines mixing readers and writers: zero exclusion violations, never more than one concurrent writer, readers genuinely running concurrently (8 at once on an 8-core machine), and a reader blocked behind a writer returns `context deadline exceeded` after exactly its timeout while leaving the lock fully usable afterward.

What the whole implementation is worth noticing for:

- **It returns `error`, not `bool`.** The caller learns *why* it failed, and `context.Cause(ctx)` still works. A `bool` throws that away.
- **There is no cancellation code.** `Acquire` takes the `ctx`. Cancellation is the semaphore's problem, and it already solved it.
- **There is no leak on timeout.** A cancelled `Acquire` removes itself from the waiter queue and acquires nothing. Compare with the `Cond` version, which leaked a goroutine per timeout.
- **`semaphore.Weighted` queues waiters FIFO**, so a writer waiting for `maxReaders` slots is not starved by a stream of arriving readers, which is the same guarantee `sync.RWMutex` gives.

The honest closing note: if you do not need cancellation, use `sync.RWMutex`. It is faster, it is in the standard library, and it has `TryLock` since Go 1.18. Build this only when a caller genuinely must give up waiting, and reach for the semaphore rather than the condition variable when you do.

### Exercise 3: Concurrent-Safe Set with Iterator

Implement a thread-safe set that supports safe iteration.

**Solution:** The set uses `map[T]struct{}` as its backing store, where the zero-size `struct{}` value means the map tracks membership without paying for values. An `RWMutex` fits here, unlike the LRU cache above, because `Contains` genuinely does not mutate anything. `Snapshot` returns a copy so callers can iterate without holding the lock.

The subtle part of this exercise is not the set, it is `ForEach`, which runs a caller-supplied callback **while holding the read lock**. That single fact creates two deadlocks, and the second one is the reason `Union` and `Intersection` below are written the way they are.

**Deadlock one: the callback touches the same set.** A callback that calls `s.Add` tries to take the write lock while the goroutine already holds the read lock. `RWMutex` does not permit upgrading, so it deadlocks against itself. Even a callback that calls `s.Contains` is unsafe, because recursive read-locking is prohibited (section 13.3): if a writer queued up in between, the second `RLock` blocks behind it, and that writer blocks behind the first `RLock`.

**Deadlock two: the callback touches a *different* set.** This one is worse, because each set is used correctly in isolation. Consider the natural implementation of `Intersection`:

```go
// BROKEN: holds s's read lock while acquiring other's read lock.
func (s *Set[T]) Intersection(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    s.ForEach(func(item T) bool {
        if other.Contains(item) { // takes other.mu while holding s.mu
            result.Add(item)
        }
        return true
    })
    return result
}
```

Now one goroutine calls `a.Intersection(b)` and another calls `b.Intersection(a)`. The first holds `a`'s read lock and wants `b`'s. The second holds `b`'s read lock and wants `a`'s. Two read locks do not normally block each other, so this looks safe, and it will pass every test you write. Add a concurrent `a.Add(...)` and `b.Add(...)` and it deadlocks, because a *pending writer* blocks newly arriving readers. Each goroutine now waits for a writer that waits for the other goroutine's read lock. Verified: this reliably deadlocks within seconds under a mixed read/write load.

The fix is to never hold one set's lock while acquiring another's. `Snapshot` copies under the lock and releases it, so the comparison happens with no lock held at all:

```go
// Correct: snapshot first, then compare with no lock held.
func (s *Set[T]) Intersection(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for _, item := range s.Snapshot() { // s.mu released before the loop
        if other.Contains(item) {
            result.Add(item)
        }
    }
    return result
}

func (s *Set[T]) Union(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for _, item := range s.Snapshot() {
        result.Add(item)
    }
    for _, item := range other.Snapshot() {
        result.Add(item)
    }
    return result
}
```

This trades exactness for safety, and that trade is worth naming: the result is now computed from a snapshot rather than from a consistent instantaneous view of both sets. For a concurrent set that guarantee was never available anyway, since the sets can change the moment you return. Do not pay for a consistency guarantee you cannot deliver.

The rule worth carrying out of this exercise: **never invoke a callback, or call into another lock-holding object, while holding a lock.** You do not know what the callee will lock, so you cannot reason about ordering, and lock ordering is the only thing that prevents deadlock. `ForEach` is kept below because it is genuinely useful and allocation-free, but its contract must be documented, and safe internal code should prefer `Snapshot`.

```go
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

// ForEach iterates with the read lock held.
//
// CONTRACT: fn must not call any method on this Set, and must not acquire
// any other lock. Doing either risks deadlock (see the discussion above).
// fn should be a short, pure function. If you need to do anything else,
// use Snapshot and iterate outside the lock.
func (s *Set[T]) ForEach(fn func(T) bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    for item := range s.items {
        if !fn(item) {
            return
        }
    }
}

// Union returns a new set with items from both.
// Uses Snapshot, not ForEach: holding s's lock while locking other
// is a lock-order inversion.
func (s *Set[T]) Union(other *Set[T]) *Set[T] {
    result := NewSet[T]()

    for _, item := range s.Snapshot() {
        result.Add(item)
    }
    for _, item := range other.Snapshot() {
        result.Add(item)
    }

    return result
}

// Intersection returns a new set with the common items.
func (s *Set[T]) Intersection(other *Set[T]) *Set[T] {
    result := NewSet[T]()

    // s.mu is released before Contains is ever called on other.
    for _, item := range s.Snapshot() {
        if other.Contains(item) {
            result.Add(item)
        }
    }

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
```

### Senior at FAANG Track

5. **Mutex contention audit.** For one production service, enable mutex profiling for a week. Identify the top three contention hotspots. Propose fixes. Measure improvement after rollout.

6. **RWMutex audit.** Grep for every `sync.RWMutex` in your team's code. For each, determine whether the read/write ratio justifies RWMutex over Mutex. Convert the ones that do not. Measure.

7. **sync.Pool audit.** Find every `sync.Pool` in your codebase. For each, verify the objects pooled are stateless (or reset on get), reasonably-sized, and actually hot-path allocations. Remove any that do not meet the criteria. Benchmark before and after.

### Staff / Principal Track

8. **Synchronization convention document.** Write the org's synchronization convention guide: when to use Mutex, when RWMutex, when atomics, when channels. Include team-specific examples. Publish. Maintain quarterly as Go evolves.

9. **Lock-free design review.** When a team proposes a lock-free data structure, run a design review covering: profile evidence justifying the complexity, correctness proof or library reference, maintenance story. Most proposals fail this review. Approve only the ones that pass.

10. **High-contention redesign.** For one service with a known contention bottleneck, lead the redesign: sharding, lock-free structure, or architectural elimination of the shared state. Document the process as a case study for future work.

11. **Atomic-style migration.** For a large codebase that uses the old function-based `sync/atomic` (`atomic.AddInt64(&x, 1)`), drive migration to the Go 1.19+ typed atomics (`atomic.Int64.Add(1)`). Measure the code-quality improvement (type safety, readability) and any performance delta.

12. **Synchronization postmortem template.** Create a template for synchronization-related incidents. Include sections for which primitive failed, what alternative would have prevented it, and what process or tooling improvement comes out of the incident. Apply retroactively to three past incidents. Extract systemic lessons.

---
