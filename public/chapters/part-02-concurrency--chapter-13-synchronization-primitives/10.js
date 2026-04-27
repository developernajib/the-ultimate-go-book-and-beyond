export default `## 13.9 Atomic Operations

\`sync/atomic\` provides low-level atomic memory operations.

### Atomic Integers (Go 1.19+ Types)

Go 1.19 introduced first-class atomic types such as \`atomic.Int64\` and \`atomic.Uint64\` that replace the older function-based API with a cleaner, method-oriented interface. These types embed the integer value and expose operations like \`Add\`, \`Load\`, \`Store\`, \`Swap\`, and \`CompareAndSwap\` directly on the struct, eliminating the need to pass pointers explicitly. Building a lock-free counter on top of \`atomic.Int64\` is a common pattern for high-throughput metrics where mutex overhead would become a bottleneck.

\`\`\`go
package main

import (
    "fmt"
    "sync/atomic"
)

func main() {
    // Modern atomic types (Go 1.19+)
    var counter atomic.Int64

    // Add
    counter.Add(1)
    counter.Add(10)

    // Load
    value := counter.Load()
    fmt.Println("Counter:", value)

    // Store
    counter.Store(100)

    // Swap
    old := counter.Swap(200)
    fmt.Println("Old value:", old)

    // CompareAndSwap
    swapped := counter.CompareAndSwap(200, 300)
    fmt.Println("Swapped:", swapped)

    // All integer types available
    var i32 atomic.Int32
    var u64 atomic.Uint64
    var u32 atomic.Uint32
    var uptr atomic.Uintptr

    // Demonstrate usage
    _ = i32
    _ = u64
    _ = u32
    _ = uptr
}

// Lock-free counter
type Counter struct {
    value atomic.Int64
}

func (c *Counter) Increment() int64 {
    return c.value.Add(1)
}

func (c *Counter) Decrement() int64 {
    return c.value.Add(-1)
}

func (c *Counter) Value() int64 {
    return c.value.Load()
}

func (c *Counter) Reset() {
    c.value.Store(0)
}
\`\`\`

### Atomic Bool and Pointer

\`atomic.Bool\` provides a race-free way to signal state transitions, such as a shutdown flag, across goroutines without the overhead of a mutex. \`atomic.Pointer[T]\` is particularly powerful for configuration hot-reload scenarios: a writer atomically swaps in a new pointer while readers always see a consistent snapshot of the old or new value, never a partial update. Because the pointer swap itself is atomic, readers require no locking whatsoever.

\`\`\`go
// Atomic boolean for flags
var shutdown atomic.Bool

func StartShutdown() {
    shutdown.Store(true)
}

func IsShuttingDown() bool {
    return shutdown.Load()
}

// Atomic pointer for configuration hot-reload
type Config struct {
    MaxConns int
    Timeout  time.Duration
    Debug    bool
}

var currentConfig atomic.Pointer[Config]

func UpdateConfig(cfg *Config) {
    currentConfig.Store(cfg)
}

func GetConfig() *Config {
    return currentConfig.Load()
}

// Safe initialization
func init() {
    currentConfig.Store(&Config{
        MaxConns: 100,
        Timeout:  30 * time.Second,
        Debug:    false,
    })
}
\`\`\`

### Atomic Value for Complex Types

\`atomic.Value\` allows any interface value to be stored and loaded atomically, making it suitable for sharing immutable, complex types like maps or slices across goroutines. The key discipline is to treat stored values as read-only: writers must copy the data into a new structure before calling \`Store\`, never mutating the object after it has been published. This copy-on-write approach lets readers access the current snapshot lock-free while writers prepare the next version in isolation.

\`\`\`go
var routeTable atomic.Value  // Stores map[string]Handler

type Handler func(w http.ResponseWriter, r *http.Request)

func init() {
    routeTable.Store(make(map[string]Handler))
}

func UpdateRoutes(routes map[string]Handler) {
    // Create a new map (don't modify existing)
    newRoutes := make(map[string]Handler, len(routes))
    for k, v := range routes {
        newRoutes[k] = v
    }
    routeTable.Store(newRoutes)
}

func GetHandler(path string) (Handler, bool) {
    routes := routeTable.Load().(map[string]Handler)
    h, ok := routes[path]
    return h, ok
}
\`\`\`

### Compare-And-Swap Patterns

Compare-and-swap (CAS) is the foundation of lock-free algorithms: it atomically checks whether a value still matches an expected snapshot and, only if it does, replaces it with a new value. When a CAS fails, because another goroutine raced in and changed the value, the caller simply reloads the current state and retries, forming a tight retry loop that avoids starvation without any blocking. The generic lock-free stack below uses this technique on \`atomic.Pointer\` to push and pop nodes safely across concurrent goroutines.

\`\`\`go
// Lock-free stack
type Stack[T any] struct {
    head atomic.Pointer[node[T]]
}

type node[T any] struct {
    value T
    next  *node[T]
}

func (s *Stack[T]) Push(value T) {
    n := &node[T]{value: value}
    for {
        oldHead := s.head.Load()
        n.next = oldHead
        if s.head.CompareAndSwap(oldHead, n) {
            return
        }
        // CAS failed, retry
    }
}

func (s *Stack[T]) Pop() (T, bool) {
    for {
        oldHead := s.head.Load()
        if oldHead == nil {
            var zero T
            return zero, false
        }
        if s.head.CompareAndSwap(oldHead, oldHead.next) {
            return oldHead.value, true
        }
        // CAS failed, retry
    }
}

// Atomic max update
func AtomicMax(addr *atomic.Int64, value int64) {
    for {
        old := addr.Load()
        if value <= old {
            return
        }
        if addr.CompareAndSwap(old, value) {
            return
        }
    }
}
\`\`\`

### When to Use Atomics vs Mutex

Choosing between atomics and a mutex comes down to the scope of the invariant you need to protect. Atomics excel at isolated, single-variable operations, counters, flags, pointer swaps, where each update is self-contained and no other state needs to change in the same transaction. A mutex is the right tool when multiple fields must remain consistent with each other, as shown in the \`AccountBalance\` example below where \`balance\`, \`pending\`, and \`history\` must all update together or not at all.

\`\`\`go
/*
Use atomics for:
- Simple counters (increment, decrement)
- Boolean flags (started, stopped, shutdown)
- Single value updates (configuration pointer)
- Lock-free data structures
- Performance-critical paths

Use mutex when:
- Multiple values need consistent update
- Complex invariants must be maintained
- Read-modify-write with complex logic
- Easier to reason about correctness
*/

// Atomics: Simple counter
type MetricsCounter struct {
    requests atomic.Int64
    errors   atomic.Int64
}

func (m *MetricsCounter) RecordRequest() {
    m.requests.Add(1)
}

func (m *MetricsCounter) RecordError() {
    m.errors.Add(1)
}

// Mutex: Consistent multi-value update
type AccountBalance struct {
    mu      sync.Mutex
    balance int64
    pending int64
    history []Transaction
}

func (a *AccountBalance) Deposit(amount int64, tx Transaction) {
    a.mu.Lock()
    defer a.mu.Unlock()

    // All three must update together
    a.balance += amount
    a.pending -= amount
    a.history = append(a.history, tx)
}
\`\`\`

### atomic.Pointer for Lock-Free Configuration

One of the most useful atomic types is \`atomic.Pointer[T]\`, introduced in Go 1.19. It enables lock-free configuration updates:

\`\`\`go
var cfg atomic.Pointer[Config]

// Reader (hot path, no locks)
current := cfg.Load()
_ = current.SomeField

// Writer (infrequent)
newCfg := &Config{...}
cfg.Store(newCfg)
\`\`\`

Readers never block. Writers atomically swap the pointer. Old configuration becomes garbage when no reader references it. This is the canonical pattern for runtime-updatable configuration in high-throughput services. Cloudflare's edge services use exactly this pattern for per-request configuration lookup.

### Memory Ordering in Go

Go's atomic operations have sequentially consistent semantics (stronger than C++'s default). This means: any two atomic operations have a well-defined total order across all goroutines, and any write visible at one atomic operation is visible at all subsequent atomic operations in other goroutines. You do not need to reason about relaxed, acquire, release, or consume orderings as in C++.

This simplicity is intentional: Go prioritises correctness over raw performance. If you need fine-grained memory ordering for extreme performance, Go is not the right language. Go's atomics are uniformly "strong enough" and the performance penalty versus relaxed atomics is small on modern hardware.

### Atomics vs Mutexes: The Real Tradeoff

On uncontended single-word state, atomics are 3-5x faster than mutexes. On contended state, both serialise, but the atomic version avoids the scheduler overhead of blocking goroutines. The rule:

- **Simple counter or flag:** atomic.
- **Complex state (multi-field coherent update):** mutex.
- **Read-mostly shared state pointer:** atomic.Pointer.
- **Anything else with multiple invariants:** mutex.

Do not reach for atomics to avoid mutex contention if the state requires coherent multi-field updates. CAS loops around multiple fields are a subtle correctness trap and usually slower than a well-placed mutex.

### Staff Lens: Atomics Are Lock-Free, Not Wait-Free

A goroutine executing a \`CompareAndSwap\` loop can retry indefinitely under heavy contention. Lock-free does not mean fast-under-contention. For high-contention counters, consider sharded atomics (one per CPU core) summed on read. For shared pointers updated rarely and read often, \`atomic.Pointer\` wins. For everything in between, measure.

### Principal Lens: Atomics as a Red Flag for Design

A codebase that reaches for atomics frequently is often designing around synchronization problems rather than solving them. The principal-level instinct: when a review shows complex atomic usage, ask whether the underlying design is right. Usually the correct response is "this shared state should not exist, or should be a single-ownership goroutine-owned value with message passing". Atomics are a micro-optimisation. Good design eliminates the need for them.

---
`;
