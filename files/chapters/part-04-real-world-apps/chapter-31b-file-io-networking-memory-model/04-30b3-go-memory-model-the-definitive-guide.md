## 31B.3 Go Memory Model - The Definitive Guide

The Go Memory Model defines when a write to a variable by one goroutine is **guaranteed to be visible** to a read of that same variable by another goroutine. Without understanding this, your concurrent code may work on your laptop (single-core, or lucky scheduling) and fail on multi-core production servers.

### The Happens-Before Relationship

The happens-before relation is the formal tool for reasoning about visibility between goroutines. If event A happens-before event B, then B is guaranteed to observe all memory writes that A performed. Within a single goroutine, statement order provides this guarantee trivially. Across goroutines, only specific synchronization operations create happens-before edges, goroutine creation, channel sends/receives, mutex lock/unlock, `sync.Once`, and atomic operations. The diagram below lists each rule.

```
┌─────────────────────────────────────────────────────────────────────────┐
│              Go Memory Model: happens-before rules                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  A HAPPENS BEFORE B means: when B executes, it is guaranteed to see     │
│  all memory writes that A performed (and A's transitive dependencies)   │
│                                                                         │
│  WITHIN a single goroutine:                                             │
│  All statements happen-before subsequent statements (trivially true)    │
│                                                                         │
│  GOROUTINE CREATION:                                                    │
│  go f() happens-before f() starts                                       │
│  → Writes before "go" are visible to the new goroutine                  │
│                                                                         │
│  GOROUTINE JOIN (wg.Wait() / channel receive after close):              │
│  goroutine completion happens-before wg.Wait() returns                  │
│  → All goroutine writes are visible after wg.Wait()                     │
│                                                                         │
│  CHANNEL SEND/RECEIVE:                                                  │
│  A send on channel ch happens-before the corresponding receive          │
│  The nth receive on a buffered channel of cap C happens-before          │
│  the (n+C)th send on that channel completes                             │
│  Closing ch happens-before a receive of the zero value from ch          │
│                                                                         │
│  MUTEX:                                                                 │
│  For any sync.Mutex or RWMutex m:                                       │
│  The nth call to m.Unlock happens-before the (n+1)th call to m.Lock     │
│  → Writes inside a lock are visible to all subsequent lock holders      │
│                                                                         │
│  ONCE:                                                                  │
│  The return of f() called from once.Do(f) happens-before                │
│  the return of any once.Do(f) call                                      │
│  → Writes in once.Do are visible to all callers after Do returns        │
│                                                                         │
│  ATOMIC (Go 1.19+ formalised in the spec):                              │
│  All sync/atomic operations behave as if executed in some               │
│  sequentially consistent total order. If a Load observes the value      │
│  written by a Store, then the Store happens-before the Load.            │
│  Prefer the typed API (atomic.Int64, atomic.Bool, atomic.Pointer[T])    │
│  over the legacy atomic.StoreInt64/LoadInt64 functions, the typed       │
│  forms guarantee alignment and are harder to misuse.                    │
└─────────────────────────────────────────────────────────────────────────┘

Go chose sequential consistency rather than the weaker acquire/release model used by C++ or Rust. In practice this means you do not need to reason about memory fences, if an atomic read sees a value written by an atomic write, every write that happened-before the atomic write is visible. The trade-off is a minor performance cost on ARM64, but it removes an entire class of subtle bugs.
```

### The Data Race Problem

A data race occurs when two goroutines access the same variable concurrently and at least one access is a write, with no synchronization between them. In Go, a data race is undefined behavior, the program may produce any result, crash, or corrupt memory. The subtle part is that code with a data race can appear correct on a developer's laptop (where scheduling happens to be favorable) and fail on a multi-core production machine. The examples below contrast correct and incorrect synchronization patterns.

```go
package main

import (
    "fmt"
    "sync"
)

var x int // shared variable

// QUESTION: Is this correct?
func buggy() {
    done := make(chan bool)

    go func() {
        x = 1 // write by goroutine
        done <- true
    }()

    <-done // wait for goroutine to finish
    fmt.Println(x) // read by main goroutine
}

// ANSWER: YES - this is correct.
// The memory model guarantees:
// x = 1 (write) happens-before done <- true (send)
// done <- true (send) happens-before <-done (receive)
// Therefore: x = 1 happens-before fmt.Println(x)
// So fmt.Println will always see x = 1. ✓

// INCORRECT version:
func buggyVersion() {
    var wg sync.WaitGroup
    wg.Add(1)
    go func() {
        x = 1 // write
        wg.Done()
    }()
    // NO synchronization between go statement and reading x here
    // Reading x here is a DATA RACE - undefined behavior!
    fmt.Println(x) // may see 0 or 1 - RACE!
    wg.Wait()      // too late: x was already read above without sync
}

// CORRECT version:
func correctVersion() {
    var wg sync.WaitGroup
    wg.Add(1)
    go func() {
        x = 1
        wg.Done() // wg.Done() happens-before wg.Wait() returns
    }()
    wg.Wait()      // wait here
    fmt.Println(x) // read here - correct! x=1 is visible
}
```

### Synchronization Primitives and Memory Visibility

Each synchronization primitive in the `sync` and `sync/atomic` packages provides specific memory visibility guarantees. A mutex ensures that writes made under one `Lock`/`Unlock` are visible to the next goroutine that acquires the same lock. `sync.Once` guarantees that all goroutines see the initialized state after `Do` returns. Atomic operations provide sequentially consistent access to individual variables, but atomics on separate variables do not form a single atomic transaction, so updating two related values still requires a mutex.

```go
package main

import (
    "fmt"
    "sync"
    "sync/atomic"
)

// =========================================================
// MUTEX: memory model guarantees
// =========================================================
var (
    mu     sync.Mutex
    shared int
)

func writer() {
    mu.Lock()
    shared = 42 // write while holding lock
    mu.Unlock() // Unlock() happens-before next Lock() in any goroutine
}

func reader() {
    mu.Lock()
    // Guaranteed to see shared = 42 if this Lock() followed writer's Unlock()
    fmt.Println(shared)
    mu.Unlock()
}

// =========================================================
// ONCE: guaranteed exactly-once initialization with visibility
// =========================================================
var (
    once    sync.Once
    config  *Config
)

type Config struct{ MaxConns int }

func getConfig() *Config {
    // once.Do guarantees: the initialization function runs exactly once,
    // AND all goroutines calling getConfig after Do returns see the initialized config
    once.Do(func() {
        config = &Config{MaxConns: 100} // write in once.Do
    })
    return config // always safe to read after once.Do
}

// =========================================================
// ATOMIC: memory model guarantees (Go 1.19+ typed API)
// =========================================================
// Prefer the typed atomic.* wrappers over the legacy Store/LoadInt32
// functions. The typed forms:
//   - Guarantee correct alignment on 32-bit platforms (no panics)
//   - Can't be accidentally accessed non-atomically (no exposed field)
//   - Read more naturally at the call site
var flag atomic.Bool

func setFlag() {
    flag.Store(true)
}

func checkFlag() bool {
    return flag.Load()
}

// atomic.Pointer[T] enables lock-free configuration reloads
// (Config is declared above):
var liveConfig atomic.Pointer[Config]

func reloadConfig(newCfg *Config) {
    liveConfig.Store(newCfg) // readers see the new pointer atomically
}

func readConfig() *Config {
    return liveConfig.Load() // never torn, never nil after first Store
}

// WARNING: Atomic on one variable is safe, but atomics across multiple
// variables do not form a single atomic transaction. Use a mutex.
var count1, count2 atomic.Int64

func badAtomicPattern() {
    // RACE: each store is individually atomic, but the two stores together
    // are not. Another goroutine can observe count1==1 with count2==0.
    count1.Store(1)
    count2.Store(1)
}

func correctPattern() {
    var mu sync.Mutex
    var a, b int64
    mu.Lock()
    a = 1 // both updates happen under the same lock
    b = 1 // no goroutine can observe a partial update
    mu.Unlock()
    _, _ = a, b
}
```

### Channel Operations and Memory Visibility

Channels are Go's primary synchronization mechanism, and their memory model rules differ between unbuffered and buffered variants. For an unbuffered channel, the send happens-before the corresponding receive completes, this is the strongest guarantee. For a buffered channel of capacity C, the receive of the Nth element happens-before the (N+C)th send completes, because the sender blocks until space opens. Closing a channel also creates a happens-before edge: writes before `close` are visible to any goroutine that receives the zero value.

```go
package main

import "fmt"

// UNBUFFERED CHANNEL: send happens-before receive
func unbufferedExample() {
    ch := make(chan int)
    x := 0

    go func() {
        x = 42    // write x
        ch <- 1   // send HAPPENS AFTER write x
                  // and send HAPPENS BEFORE receive
    }()

    <-ch          // receive HAPPENS BEFORE fmt.Println
    fmt.Println(x) // guaranteed to see x = 42
}

// BUFFERED CHANNEL: receive of the nth item happens-before send of the (n+cap)th item
func bufferedExample() {
    ch := make(chan int, 2) // capacity 2
    x := 0

    go func() {
        ch <- 1   // 1st send (non-blocking, fits in buffer)
        ch <- 2   // 2nd send (non-blocking)
        // send of 3rd item (n+cap = 1+2 = 3rd) happens-before:
        // receive of 1st item (n=1)
        x = 42
        ch <- 3   // 3rd send BLOCKS until 1st is received
    }()

    <-ch          // 1st receive: HAPPENS BEFORE 3rd send completes
    <-ch          // 2nd receive
    <-ch          // 3rd receive
    fmt.Println(x) // guaranteed? YES: 3rd send happens-before its completion,
                   // and 3rd completion happens-before this receive,
                   // and receive happens-before fmt.Println
}

// CHANNEL CLOSE: close happens-before receive of zero value
func closeExample() {
    ch := make(chan int)
    x := 0

    go func() {
        x = 99
        close(ch) // close happens-before any receive of zero value
    }()

    <-ch          // receives zero value (0) because channel is closed
    fmt.Println(x) // guaranteed to see x = 99
}
```

### Junior to FAANG: Happens-Before Without the Jargon

The memory model sounds abstract. It is not. It is a set of rules that tell you when a write in one goroutine becomes visible to a read in another. If there is no rule that connects them, the read can see stale data forever, or inconsistent data, or garbage.

Simplest mental model for juniors: a read is guaranteed to see a write only if there is a chain of "communication events" between them. Communication events are:

1. A channel send/receive pair.
2. A `sync.Mutex.Lock`/`Unlock` pair on the same mutex.
3. A `sync.WaitGroup.Done` followed by `Wait`.
4. A `sync.Once.Do` (the first call's body happens-before any observation of the done state).
5. An atomic operation on the same memory location.
6. The `go` statement that starts a goroutine (the setup happens-before the goroutine's first instruction).

If your code depends on one goroutine seeing another goroutine's writes, you must have one of these events on the communication path. Otherwise the race detector will find the bug, or worse, it will not find it and you will ship it.

Worked example. This is broken:

```go
var ready bool
var data int

func producer() {
    data = 42
    ready = true
}

func consumer() {
    for !ready {
    }
    fmt.Println(data)
}
```

There is no happens-before between `data = 42` and the read of `data` in the consumer. The consumer may spin forever because `ready` is cached in a register. Even if it sees `ready = true`, it may see `data = 0` because the writes can be reordered. Fix with `atomic.Bool` and atomic loads, or with a channel:

```go
done := make(chan struct{})
go func() { data = 42; close(done) }()
<-done
fmt.Println(data) // 42, guaranteed
```

First-job context: at code review an experienced engineer will flag any shared variable that is read and written without a synchronization primitive. The race detector catches most of these. Always run `go test -race` in CI. Anthropic, Google, and Stripe make it a merge gate.

Interview entry-point framing: expect questions like "what does `sync.Mutex.Unlock` guarantee about memory visibility?" Answer: every read and write before the `Unlock` is visible to any goroutine that subsequently `Lock`s the same mutex. That is a release/acquire pair in hardware terms, but you do not need to know that for the L3 interview.

### Senior at FAANG: The 2022 Memory Model, atomic Semantics, and Race Hunting at Fleet Scale

Go's memory model was formally revised in 2022 (https://go.dev/ref/mem) to specify the semantics of `sync/atomic` operations. Before that revision, atomic operations had a fuzzy "synchronizing" guarantee. The new model states explicitly: atomic operations behave as if executed in some total sequentially consistent order. That is SC-DRF (sequential consistency for data-race-free programs) with SC on atomics, which is stronger than C++'s default (which is release-acquire on atomics and requires `memory_order_seq_cst` for SC). This is deliberate. Russ Cox argued for the stronger model because Go's target is application programmers, not lock-free library authors.

**What SC on atomics buys you.** If you use only `atomic.Load` and `atomic.Store` for communication, you do not need to reason about release/acquire pairings. Every atomic operation is totally ordered with every other atomic operation. This is expensive on ARM and POWER (full memory barriers on every atomic) but cheap on x86 (where loads are already acquire and stores are release). The Go team took the performance hit to simplify the user's mental model.

**`sync.Once` semantics.** `Once.Do(f)` guarantees that:

1. `f` is called exactly once.
2. All calls to `Do` return only after `f` has returned.
3. Memory writes inside `f` happen-before any read of the singleton by any caller that observed `Do` completing.

Implementation uses `atomic.Uint32` for the done flag plus a `Mutex` for the slow path. The fast path is a single atomic load. Common misuse: calling `Do` from inside `f` itself, which deadlocks. The less common misuse is assuming `Do` provides sequential consistency with non-atomic reads of the singleton. If the singleton is a pointer and you read it without going through `Do` or an atomic load, you lose the happens-before edge.

**Peterson's algorithm in Go.** A classic test of a memory model is whether Peterson's mutual-exclusion algorithm works with plain variables. In Go, it does not, because the compiler and CPU can reorder the flag writes and the turn write. It works only if all accesses are via `atomic` operations. This is a good whiteboard exercise: ask a candidate to implement Peterson's in Go, and watch whether they reach for `atomic.Int32` immediately. If they do not, they have not read the memory model.

**Race detector at fleet scale.** `go build -race` adds ThreadSanitizer instrumentation. Overhead is roughly 5-10x CPU and 5-10x memory. You cannot run the whole production fleet with `-race`. The pattern used at Google and Meta is canary fleets: 0.1% of production traffic runs race-instrumented binaries, race reports are streamed to a central collector, deduped by stack, and filed as tickets. The rate of real bugs found this way is non-trivial. Uber published a paper ("Dynamic Race Detection for Go," 2022) describing a sampling race detector with 5% overhead, enabling always-on instrumentation.

Reports must be triaged carefully. The race detector reports goroutine IDs at the time of the race, and those goroutines may have exited. Always capture the full stack trace, both read and write sides, and grep for recent git blame. Most races cluster around a handful of shared-state patterns: global maps, cached pointers, "lazy init" without `sync.Once`, and mutating config at runtime without an atomic pointer swap.

**ThreadSanitizer vs Go race detector.** Both are derived from the same LLVM TSan runtime. Differences: the Go detector tracks goroutines, not threads, so it handles the M:N scheduler. C++ TSan tracks pthreads. Both use vector clocks to detect happens-before violations. Both have false negatives on very long traces because the vector clock history is truncated. Neither catches stale reads, only simultaneous reads and writes.

**Memory ordering pitfalls.**

1. **Double-checked locking without atomics.** Classic bug: `if instance == nil { mu.Lock(); if instance == nil { instance = new(T) }; mu.Unlock() }`. The outer `if` races with the initialization. Use `sync.Once` or `atomic.Pointer[T]`.

2. **Publishing a slice via a pointer without atomics.** Swapping a shared `*[]T` pointer with `=` is a race. Use `atomic.Pointer[[]T]`. The 1.19+ generic atomic types make this ergonomic.

3. **`sync.Map` false confidence.** `sync.Map` is atomic per-operation, but a `Load` followed by a `Store` is not atomic as a pair. Use `LoadOrStore` or `CompareAndSwap` for read-modify-write.

4. **Writer tail latency on `sync.RWMutex`.** Go's `RWMutex` blocks new readers once a writer is waiting, so a writer does not starve indefinitely, but it still has to wait for every currently-active reader to finish, which under continuous heavy read load is a long tail. Prefer `atomic.Pointer` with copy-on-write for read-heavy config structures.

**Formal verification: TLA+ for protocols.** For any distributed protocol you design (leader election, two-phase commit, custom consensus), write a TLA+ spec. AWS uses TLA+ for S3, DynamoDB, and EBS. MongoDB used it to find a long-standing bug in their replication protocol. Go code cannot be directly verified, but the protocol can, and the Go implementation should be a translation of the spec. The PlusCal dialect is more approachable than raw TLA+.

**Linearizability testing: Porcupine, Elle, Jepsen.**

- **Porcupine** (https://github.com/anishathalye/porcupine): Go library that takes a history of operations and a sequential model, and checks linearizability via a brute-force search with memoization. Useful in unit tests for custom concurrent data structures.
- **Elle** (Jepsen's checker): checks transactional isolation levels (serializable, snapshot isolation, read committed). Used to find bugs in YugabyteDB, CockroachDB, FaunaDB.
- **Jepsen**: a harness for running distributed systems under fault injection (network partitions, clock skew, process pauses) and feeding histories to Elle. Every claimed strong-consistency system should be Jepsen-tested.

**Staff-level code review questions:**

1. Is every shared variable either immutable after initialization, guarded by a mutex, or accessed via `sync/atomic`?
2. Is `sync.Once` used for lazy init, never double-checked locking by hand?
3. Does the code pass `go test -race -count=100` and `go test -race -cpu=1,4,16`?
4. Are atomic operations on the same variable consistent in size (no mixing `atomic.Int32` and direct int32 writes)?
5. Are happens-before edges documented in comments for non-obvious synchronization?
6. For any custom concurrent data structure, is there a Porcupine test or a TLA+ spec?

---
