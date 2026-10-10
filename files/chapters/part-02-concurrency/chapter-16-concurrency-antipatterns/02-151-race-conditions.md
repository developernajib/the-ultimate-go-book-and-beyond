## 16.1 Race Conditions

Race conditions are the most common and dangerous concurrency bugs. They occur when multiple goroutines access shared data without proper synchronization, and at least one access is a write. Race conditions are particularly insidious because they may not manifest in development or testing but cause data corruption or crashes in production under load.

### Understanding Race Conditions

The classic illustration of a race condition is a simple counter increment, which looks atomic but compiles to three distinct CPU instructions: read, add, and write. When two goroutines interleave these steps on the same memory location, one goroutine's write silently overwrites the other's, producing a final value smaller than expected, an error that worsens as core count and concurrency increase.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Race Condition Anatomy                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  counter++  is actually three operations:                            │
│                                                                      │
│  Goroutine 1              Goroutine 2                                │
│  ─────────────            ─────────────                              │
│  1. READ counter (0)      1. READ counter (0)    ← Same value!       │
│  2. ADD 1       (1)       2. ADD 1       (1)                         │
│  3. WRITE counter (1)     3. WRITE counter (1)   ← Lost update!      │
│                                                                      │
│  Expected: 2              Actual: 1                                  │
│                                                                      │
│  This is called a "Read-Modify-Write" race condition                 │
│  The second write overwrites the first, losing an increment          │
│                                                                      │
│  How often does this happen?                                         │
│  - Single-threaded: NEVER                                            │
│  - 2 goroutines on 1 core: SOMETIMES (context switches)              │
│  - N goroutines on N cores: FREQUENTLY (true parallelism)            │
│                                                                      │
│  The race detector finds this by tracking memory access              │
│  from each goroutine and detecting conflicting accesses              │
└──────────────────────────────────────────────────────────────────────┘
```

### Types of Race Conditions

**1. Read-Modify-Write Race (Most Common)**

```go
// RACE CONDITION: Read-Modify-Write
var counter int

func increment() {
    for i := 0; i < 1000; i++ {
        counter++  // This is: read counter, add 1, write counter
    }
}

func main() {
    var wg sync.WaitGroup
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            increment()
        }()
    }
    wg.Wait()
    fmt.Println(counter)  // Expected: 10000, Actual: varies (7234, 8912, etc.)
}
```

**2. Check-Then-Act Race**

```go
// RACE CONDITION: Check-Then-Act
type SafeMap struct {
    mu sync.Mutex
    m  map[string]int
}

// WRONG: Gap between check and act
func (s *SafeMap) SetIfAbsentWrong(key string, value int) {
    s.mu.Lock()
    _, exists := s.m[key]
    s.mu.Unlock()  // Released lock!

    if !exists {
        s.mu.Lock()
        s.m[key] = value  // Another goroutine might have set it!
        s.mu.Unlock()
    }
}

// CORRECT: Atomic check-and-set
func (s *SafeMap) SetIfAbsent(key string, value int) bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    if _, exists := s.m[key]; exists {
        return false
    }
    s.m[key] = value
    return true
}
```

**3. Compound Operation Race**

```go
// RACE CONDITION: Compound operations
//
// WRONG: the transfer is not atomic across the two accounts.
// Each individual account is perfectly locked, which is exactly why
// this passes -race. The bug is that the PAIR of updates is not one
// operation.
func (a *Account) TransferWrong(to *Account, amount int) error {
    a.mu.Lock()
    if a.balance < amount {
        a.mu.Unlock()
        return errors.New("insufficient funds")
    }
    a.balance -= amount
    a.mu.Unlock()  // Released lock!

    // Money now exists in NEITHER account. Any goroutine auditing
    // total balance in this window sees it short. If the process dies
    // here, or if the credit below panics, the money is simply gone.
    to.mu.Lock()
    to.balance += amount
    to.mu.Unlock()
    return nil
}

// CORRECT: Lock both accounts atomically, in a consistent order
type Account struct {
    id      uint64 // Stable, unique, assigned at creation
    mu      sync.Mutex
    balance int
}

func (a *Account) Transfer(to *Account, amount int) error {
    // Self-transfer must be handled BEFORE locking. Without this,
    // first and second are the same Account, and the second Lock
    // blocks forever on a mutex this goroutine already holds.
    // sync.Mutex is not reentrant.
    if a == to {
        return errors.New("cannot transfer to self")
    }

    // Order by a stable id to prevent AB-BA deadlock.
    first, second := a, to
    if first.id > second.id {
        first, second = second, first
    }

    first.mu.Lock()
    defer first.mu.Unlock()
    second.mu.Lock()
    defer second.mu.Unlock()

    if a.balance < amount {
        return errors.New("insufficient funds")
    }
    a.balance -= amount
    to.balance += amount
    return nil
}
```

Two traps are buried in that ordering code, and both are worth stating outright.

**`sync.Mutex` is not reentrant, and a self-transfer is not a hypothetical.** `acct.Transfer(acct, 10)` is easy to reach from a retry, a UI that lets a user pick the same account twice, or a batch job iterating a pair list. With `a == to`, `first` and `second` are the same `Account`, the first `Lock` succeeds, the second blocks on a mutex this very goroutine holds, and the goroutine parks permanently. There is no error, no panic, and no deadlock message, because the runtime detector needs *every* goroutine asleep and a real server always has others running. Guard the self case before you lock.

**Do not order locks by pointer address.** `uintptr(unsafe.Pointer(a))` is the version you will see in the wild, and it works only by accident: it depends on Go's collector not moving heap objects, which is an implementation detail rather than a language guarantee. Order by a stable identity that belongs to your domain, such as an account id, which is also far more obvious to the next reader. If no natural identity exists, assign one at construction from a counter.

### Classic Data Race

The stripped-down example below removes all of the earlier nuance to show the race in its most recognizable form: two goroutines incrementing a bare integer variable while a `time.Sleep` masks the problem just enough to make it seem intermittent. Running this with `-race` immediately surfaces the conflicting memory accesses that the naked eye cannot reliably detect.

```go
// RACE CONDITION
var counter int

func increment() {
    for i := 0; i < 1000; i++ {
        counter++  // Read-modify-write is not atomic
    }
}

func main() {
    go increment()
    go increment()
    time.Sleep(time.Second)
    fmt.Println(counter)  // Not always 2000!
}
```

The mutex fix wraps the increment in a lock/unlock pair, serializing access so only one goroutine modifies the counter at a time.

**Fix with Mutex:**
```go
var (
    counter int
    mu      sync.Mutex
)

func increment() {
    for i := 0; i < 1000; i++ {
        mu.Lock()
        counter++
        mu.Unlock()
    }
}
```

For simple numeric operations, `sync/atomic` provides lock-free alternatives that avoid the overhead of mutex acquisition entirely.

**Fix with Atomic:**
```go
var counter int64

func increment() {
    for i := 0; i < 1000; i++ {
        atomic.AddInt64(&counter, 1)
    }
}
```

### Race on Slice/Map Access

Go's built-in `map` type is explicitly not safe for concurrent use: simultaneous writes from two goroutines can corrupt internal hash-table state and trigger a fatal runtime panic. Slices are similarly vulnerable because `append` may reallocate the underlying array, causing one goroutine to write to memory another goroutine has already received a stale pointer to.

```go
// RACE: concurrent map write
func badMap() {
    m := make(map[string]int)
    go func() { m["a"] = 1 }()
    go func() { m["b"] = 2 }()  // Panic or corruption!
}

// RACE: concurrent slice modification
func badSlice() {
    s := []int{1, 2, 3}
    go func() { s[0] = 10 }()
    go func() { s = append(s, 4) }()  // Race!
}
```

### Using the Race Detector

Go ships a built-in race detector based on the ThreadSanitizer library. Enabling it requires only the `-race` flag at build, run, or test time. The compiler instruments memory accesses, and at runtime the detector reports the goroutine stack traces of conflicting reads and writes, making it far more precise than code review alone.

```bash
go run -race main.go
go test -race ./...
go build -race -o myapp
```

Output:
```
==================
WARNING: DATA RACE
Read at 0x00c000014080 by goroutine 7:
  main.increment()
      /path/main.go:10 +0x38

Previous write at 0x00c000014080 by goroutine 6:
  main.increment()
      /path/main.go:10 +0x50
==================
```

**Always run tests with -race in CI/CD.**

### Race Detector Is Not a Proof

A clean `-race` run does not prove race freedom, and it fails in two distinct ways that get conflated.

**It only sees what executes.** The detector reports races it actually observes at runtime. A race on a code path your test never runs is a race it never sees, so a clean run is evidence, not proof.

**It finds data races, not race conditions.** This limit is the more dangerous one, because it is structural rather than statistical: no amount of extra test runs helps. A *data race* is unsynchronized access to the same memory. A *race condition* is any timing-dependent incorrect behaviour. `-race` detects only the first, and the two are not the same thing.

Look back at `SetIfAbsentWrong` and `TransferWrong` in this section. Every single memory access in both is protected by a mutex, so there is no data race anywhere, and **`-race` reports nothing at all**. Run the two-goroutine test against `SetIfAbsentWrong` and both goroutines write the key that was supposed to be set once, while the detector stays silent throughout. The bug is in the gap *between* correctly synchronized operations, and the detector has no concept of the invariant you intended.

The same blind spot covers code built from atomics. Atomics never data-race by construction, so `check-then-act` over two atomic variables passes `-race` forever while being just as broken as the mutex version.

Mitigations:

1. **Exercise concurrent paths in tests.** A race in a function called only once sequentially will not be detected. Invoke concurrent paths with multiple goroutines.
2. **Run tests with `-count=100` or similar.** Some races are scheduling-dependent and fire intermittently.
3. **Assert invariants, not just the absence of race reports.** This is what catches the class `-race` cannot see. After a concurrent test, assert that the counter equals the expected total, that the key was set exactly once, that total balance across accounts is unchanged. A test that only checks "no race reported" cannot fail on a check-then-act bug.
4. **Consider `synctest` (stable in Go 1.25)** for deterministic scheduling of concurrent tests, which makes interleaving-dependent bugs reproducible instead of occasional.
5. **Run the race detector on canary instances periodically.** It costs roughly 2-20x CPU and 5-10x memory, so it is not feasible everywhere, but a canary catches races that only appear under production traffic.

### Staff Lens: Race-Free as a Review Invariant

Every concurrent PR must pass `-race`, the CI gate should be automatic, and this is non-negotiable. Teams that maintain the discipline have fewer race-related incidents than teams that run `-race` occasionally.

Make sure the bar is set at the right height, though, because "it passes `-race`" is where too many reviews stop. `-race` proves the absence of unsynchronized access on the paths the tests happened to run. It says nothing about whether the code is *correct*. The two review questions worth asking are "does the test actually exercise this concurrently, with enough goroutines to interleave?" and "does the test assert the invariant, or only that no race was reported?". The second question catches the bugs the tool cannot, and those are the ones that reach production, precisely because they survive the gate everyone trusts.

---
