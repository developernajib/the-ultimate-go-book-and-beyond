## Complete Reference: 100 Go Mistakes (Teiva Harsanyi)

The following is a complete catalog of all 100 Go mistakes from Teiva Harsanyi's book *"100 Go Mistakes and How to Avoid Them"* (Manning, 2022), organized by category. This book is widely considered essential reading for any Go developer because it covers mistakes that affect every level of experience, from project organization to low-level CPU cache optimization. Use this reference to quickly look up a specific mistake number or to browse categories where you want to strengthen your knowledge.

### Code and Project Organization (#1-16)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 1 | Unintended variable shadowing | Using `:=` in inner scope shadows outer variable | Logic bugs, hard to debug |
| 2 | Unnecessary nested code | Deep nesting reduces readability | Maintenance burden |
| 3 | Misusing init functions | Overusing init() for complex setup | Testing difficulties, hidden dependencies |
| 4 | Overusing getters and setters | Java-style accessors are non-idiomatic in Go | Code bloat |
| 5 | Interface pollution | Creating interfaces prematurely | Unnecessary abstraction |
| 6 | Interface on the producer side | Defining interfaces where they're implemented | Reduced flexibility |
| 7 | Returning interfaces | Returning interfaces instead of concrete types | Loss of type information |
| 8 | `any` says nothing | Using `interface{}` or `any` without constraints | Type safety loss |
| 9 | Confused about generics | Misusing generics when not needed | Overcomplicated code |
| 10 | Type embedding problems | Not understanding embedded field promotion | Unexpected method exposure |
| 11 | Not using functional options | Using config structs with many fields | Poor API ergonomics |
| 12 | Project misorganization | Poor package structure | Navigation difficulties |
| 13 | Creating utility packages | Generic "util" or "common" packages | Unclear responsibility |
| 14 | Package name collisions | Naming packages same as standard library | Import confusion |
| 15 | Missing code documentation | No godoc comments on exported items | Usability issues |
| 16 | Not using linters | Skipping static analysis tools | Missed bugs |

### Data Types (#17-29)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 17 | Octal literal confusion | `0644` interpreted as octal (420 decimal) | Wrong values |
| 18 | Neglecting integer overflows | No overflow checking on arithmetic | Silent corruption |
| 19 | Not understanding floating points | Precision issues with float32/float64 | Calculation errors |
| 20 | Slice length vs capacity | Confusing len() and cap() | Performance issues |
| 21 | Inefficient slice initialization | Not pre-allocating known sizes | Excessive allocations |
| 22 | nil vs empty slices | `var s []int` vs `s := []int{}` semantics | JSON encoding differences |
| 23 | Not checking slice emptiness | Using `s == nil` instead of `len(s) == 0` | Logic errors |
| 24 | Incorrect slice copies | Using `copy()` without proper sizing | Partial copies |
| 25 | Slice append side effects | Append may modify underlying array | Data corruption |
| 26 | Slice memory leaks | Holding references to large backing arrays | Memory bloat |
| 27 | Inefficient map initialization | Not providing initial capacity | Excessive rehashing |
| 28 | Map memory leaks | Maps never shrink after deletions | Memory growth |
| 29 | Comparing values incorrectly | Using `==` on slices, maps, or floats | Logic errors |

### Control Structures (#30-35)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 30 | Range loop element copies | Range copies values, not references | Unintended behavior |
| 31 | Range argument evaluation | Array/slice evaluated once at start | Stale data iteration |
| 32 | Pointer elements in range | Taking address of range variable | All pointers same address (pre-Go 1.22) |
| 33 | Wrong map iteration assumptions | Expecting ordered iteration | Non-deterministic behavior |
| 34 | Break statement misunderstanding | Break only exits innermost for/switch/select | Incomplete loop exit |
| 35 | Defer inside a loop | Deferred calls accumulate until function returns | Resource exhaustion |

### Strings (#36-41)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 36 | Not understanding runes | Confusing bytes with runes in strings | Unicode bugs |
| 37 | Inaccurate string iteration | Iterating by byte instead of rune | Character corruption |
| 38 | Misusing trim functions | `TrimRight` vs `TrimSuffix` confusion | Wrong trimming |
| 39 | Under-optimized concatenation | Using `+` in loops instead of Builder | O(n²) allocations |
| 40 | Useless string conversions | Converting to/from []byte unnecessarily | Wasted allocations |
| 41 | Substring memory leaks | Substring holds reference to full string | Memory retention |

### Functions and Methods (#42-47)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 42 | Wrong receiver type choice | Value vs pointer receiver confusion | Inefficiency or bugs |
| 43 | Never using named results | Missing named return parameters opportunity | Reduced clarity |
| 44 | Named result side effects | Shadowing or unintended nil returns | Subtle bugs |
| 45 | Returning nil receiver | Returning nil concrete type as interface | Non-nil interface with nil value |
| 46 | Filename as function input | Accepting filename instead of io.Reader | Untestable code |
| 47 | Defer argument evaluation | Defer captures values at defer time, not call time | Wrong values used |

### Error Management (#48-54)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 48 | Panicking inappropriately | Using panic for recoverable errors | Application crashes |
| 49 | Wrong error wrapping | Not using %w or wrapping incorrectly | Lost error chain |
| 50 | Inaccurate error type checking | Using `==` instead of `errors.Is` | Missed error matches |
| 51 | Inaccurate error value checking | Direct comparison with sentinel errors | Breaking on wrapping |
| 52 | Handling errors twice | Logging and returning same error | Duplicate log entries |
| 53 | Not handling errors | Ignoring returned errors with `_` | Silent failures |
| 54 | Not handling defer errors | Ignoring Close() errors in defer | Data loss, leaks |

### Concurrency Foundations (#55-60)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 55 | Mixing concurrency and parallelism | Confusion about concurrent vs parallel execution | Wrong design choices |
| 56 | Thinking concurrency is always faster | Adding goroutines without measuring | Worse performance |
| 57 | Channels vs mutexes confusion | Wrong synchronization primitive choice | Inefficiency or deadlock |
| 58 | Not understanding race problems | Data race vs race condition confusion | Undetected bugs |
| 59 | Workload type ignorance | Not distinguishing CPU-bound vs I/O-bound | Poor resource utilization |
| 60 | Misunderstanding contexts | Wrong context usage patterns | Leak or premature cancellation |

### Concurrency Practice (#61-74)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 61 | Propagating inappropriate context | Passing wrong context to goroutines | Premature cancellation |
| 62 | Starting goroutine without stop | No way to signal goroutine to exit | Goroutine leaks |
| 63 | Goroutine loop variable capture | Closure captures same variable | Wrong values (pre-Go 1.22) |
| 64 | Non-deterministic select | Expecting order in select cases | Race conditions |
| 65 | Not using notification channels | Using bool channel instead of struct{} | Wasted memory |
| 66 | Not using nil channels | Missing nil channel as select disable | Complex logic |
| 67 | Confusion about channel size | Wrong buffered channel capacity | Deadlock or waste |
| 68 | String formatting side effects | fmt.Sprintf calling methods that lock | Deadlock |
| 69 | Data races with append | Concurrent append to same slice | Data corruption |
| 70 | Mutexes with slices and maps | Only protecting reference, not contents | Partial protection |
| 71 | Misusing sync.WaitGroup | Calling Add inside goroutine | Race condition |
| 72 | Forgetting sync.Cond | Not knowing when to use condition variables | Inefficient polling |
| 73 | Not using errgroup | Missing golang.org/x/sync/errgroup | Complex error handling |
| 74 | Copying sync types | Copying mutex or WaitGroup | Broken synchronization |

### Standard Library (#75-81)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 75 | Wrong time duration | `time.Sleep(1)` sleeps 1 nanosecond | Logic errors |
| 76 | time.After memory leaks | Using time.After in loops | Timer accumulation |
| 77 | Common JSON mistakes | Type embedding, monotonic clock, any maps | Serialization bugs |
| 78 | Common SQL mistakes | Pool settings, prepared statements, nulls | Database issues |
| 79 | Not closing transient resources | HTTP body, sql.Rows, os.File | Resource leaks |
| 80 | Forgetting return after HTTP reply | Writing response but continuing execution | Double writes |
| 81 | Default HTTP client/server | Missing timeouts, connection limits | Resource exhaustion |

### Testing (#82-90)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 82 | Not categorizing tests | No build tags, short mode, or test types | Slow CI, test confusion |
| 83 | Not enabling -race flag | Missing race detector in tests | Undetected races |
| 84 | Not using test execution modes | Missing -parallel, -shuffle flags | Flaky tests |
| 85 | Not using table-driven tests | Repetitive test code | Maintenance burden |
| 86 | Sleeping in unit tests | Using time.Sleep for synchronization | Slow, flaky tests |
| 87 | Not dealing with time API | Testing time-dependent code poorly | Non-deterministic tests |
| 88 | Not using testing utilities | Missing httptest, iotest packages | Complex test code |
| 89 | Inaccurate benchmarks | Wrong timer usage, compiler optimizations | Misleading results |
| 90 | Not exploring Go testing features | Missing coverage, utility functions | Incomplete testing |

### Optimizations (#91-100)

| # | Mistake | Description | Impact |
|---|---------|-------------|--------|
| 91 | Not understanding CPU caches | Cache-unfriendly data layouts | Poor performance |
| 92 | False sharing in concurrent code | Sharing cache lines between goroutines | Hidden contention |
| 93 | Ignoring instruction-level parallelism | Missing ILP optimization opportunities | CPU underutilization |
| 94 | Not being aware of data alignment | Misaligned struct fields | Memory waste, slower access |
| 95 | Not understanding stack vs heap | Unnecessary heap allocations | GC pressure |
| 96 | Not knowing how to reduce allocations | Missing sync.Pool, API redesign options | Allocation overhead |
| 97 | Not relying on inlining | Writing code that defeats inlining | Missed optimizations |
| 98 | Not using Go diagnostics | Missing pprof, trace usage | Blind optimization |
| 99 | Not understanding GC | Not knowing when/how GC runs | Latency spikes |
| 100 | Docker/Kubernetes Go issues | GOMAXPROCS, memory limits misconfigured | Container problems |

---
