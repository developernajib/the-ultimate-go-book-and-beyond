export default `## 16.1 Race Conditions

Race conditions are the most common and dangerous concurrency bugs. They occur when multiple goroutines access shared data without proper synchronization, and at least one access is a write. Race conditions are particularly insidious because they may not manifest in development or testing but cause data corruption or crashes in production under load.

### Understanding Race Conditions

The classic illustration of a race condition is a simple counter increment, which looks atomic but compiles to three distinct CPU instructions: read, add, and write. When two goroutines interleave these steps on the same memory location, one goroutine's write silently overwrites the other's, producing a final value smaller than expected, an error that worsens as core count and concurrency increase.

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│                    Race Condition Anatomy                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  counter++  is actually three operations:                           │
│                                                                      │
│  Goroutine 1              Goroutine 2                               │
│  ─────────────            ─────────────                             │
│  1. READ counter (0)      1. READ counter (0)    ← Same value!     │
│  2. ADD 1       (1)       2. ADD 1       (1)                        │
│  3. WRITE counter (1)     3. WRITE counter (1)   ← Lost update!    │
│                                                                      │
│  Expected: 2              Actual: 1                                  │
│                                                                      │
│  This is called a "Read-Modify-Write" race condition                │
│  The second write overwrites the first, losing an increment         │
│                                                                      │
│  How often does this happen?                                        │
│  - Single-threaded: NEVER                                           │
│  - 2 goroutines on 1 core: SOMETIMES (context switches)            │
│  - N goroutines on N cores: FREQUENTLY (true parallelism)          │
│                                                                      │
│  The race detector finds this by tracking memory access             │
│  from each goroutine and detecting conflicting accesses            │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

### Types of Race Conditions

**1. Read-Modify-Write Race (Most Common)**

\`\`\`go
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
\`\`\`

**2. Check-Then-Act Race**

\`\`\`go
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
\`\`\`

**3. Compound Operation Race**

\`\`\`go
// RACE CONDITION: Compound operations
type Account struct {
    mu      sync.Mutex
    balance int
}

// WRONG: Balance can change between check and debit
func (a *Account) TransferWrong(to *Account, amount int) error {
    a.mu.Lock()
    if a.balance < amount {
        a.mu.Unlock()
        return errors.New("insufficient funds")
    }
    a.balance -= amount
    a.mu.Unlock()  // Released lock!

    to.mu.Lock()
    to.balance += amount  // What if a.balance was modified?
    to.mu.Unlock()
    return nil
}

// CORRECT: Lock both accounts atomically
func (a *Account) Transfer(to *Account, amount int) error {
    // Always lock in consistent order to prevent deadlock
    first, second := a, to
    if uintptr(unsafe.Pointer(a)) > uintptr(unsafe.Pointer(to)) {
        first, second = to, a
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
\`\`\`

### Classic Data Race

The stripped-down example below removes all of the earlier nuance to show the race in its most recognizable form: two goroutines incrementing a bare integer variable while a \`time.Sleep\` masks the problem just enough to make it seem intermittent. Running this with \`-race\` immediately surfaces the conflicting memory accesses that the naked eye cannot reliably detect.

\`\`\`go
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
\`\`\`

The mutex fix wraps the increment in a lock/unlock pair, serializing access so only one goroutine modifies the counter at a time.

**Fix with Mutex:**
\`\`\`go
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
\`\`\`

For simple numeric operations, \`sync/atomic\` provides lock-free alternatives that avoid the overhead of mutex acquisition entirely.

**Fix with Atomic:**
\`\`\`go
var counter int64

func increment() {
    for i := 0; i < 1000; i++ {
        atomic.AddInt64(&counter, 1)
    }
}
\`\`\`

### Race on Slice/Map Access

Go's built-in \`map\` type is explicitly not safe for concurrent use: simultaneous writes from two goroutines can corrupt internal hash-table state and trigger a fatal runtime panic. Slices are similarly vulnerable because \`append\` may reallocate the underlying array, causing one goroutine to write to memory another goroutine has already received a stale pointer to.

\`\`\`go
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
\`\`\`

### Using the Race Detector

Go ships a built-in race detector based on the ThreadSanitizer library. Enabling it requires only the \`-race\` flag at build, run, or test time. The detector instruments every memory access at compile time and reports the exact goroutine stack traces of conflicting reads and writes, making it far more precise than code review alone.

\`\`\`bash
go run -race main.go
go test -race ./...
go build -race -o myapp
\`\`\`

Output:
\`\`\`
==================
WARNING: DATA RACE
Read at 0x00c000014080 by goroutine 7:
  main.increment()
      /path/main.go:10 +0x38

Previous write at 0x00c000014080 by goroutine 6:
  main.increment()
      /path/main.go:10 +0x50
==================
\`\`\`

**Always run tests with -race in CI/CD.**

### Race Detector Is Not a Proof

A race detector passing does not prove race freedom. It only catches races that execute during the test run. If a race only fires in specific production scheduling conditions or code paths not exercised in tests, the race detector will not catch it.

Mitigations:

1. **Exercise concurrent paths in tests.** A race in a function called only once sequentially in tests will not be detected. Add tests that invoke concurrent paths with multiple goroutines.
2. **Run tests with \`-count=100\` or similar.** Some races are scheduling-dependent and fire intermittently.
3. **Run race detector in production canary instances periodically.** Race detector costs 2-20x CPU and 5-10x memory; not feasible 24/7, but a canary with race detection catches races that only appear under production traffic.

### Staff Lens: Race-Free as a Review Invariant

Every concurrent PR must pass \`-race\`. This is non-negotiable. The CI gate should be automatic. A reviewer should ask "have you run this with -race and exercised the concurrent paths?" as a matter of course. Teams that maintain this discipline have fewer race-related incidents than teams that run \`-race\` only occasionally.

---
`;
