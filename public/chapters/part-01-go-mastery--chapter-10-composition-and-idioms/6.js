export default `## 10.5 Go Proverbs

Rob Pike's Go Proverbs distill years of production experience into short guidelines. Each one addresses a specific design tension that Go programmers encounter repeatedly.

### "Don't communicate by sharing memory. Share memory by communicating."

This proverb encapsulates Go's approach to concurrency: pass data ownership between goroutines via channels rather than protecting shared data with mutexes. The following example contrasts both approaches.

\`\`\`go
// Anti-pattern: shared state with locks
type Counter struct {
    mu    sync.Mutex
    value int
}

func (c *Counter) Inc() {
    c.mu.Lock()
    c.value++
    c.mu.Unlock()
}

// Better: communicate via channels
type Counter struct {
    inc chan struct{}
    get chan int
}

func NewCounter() *Counter {
    c := &Counter{
        inc: make(chan struct{}),
        get: make(chan int),
    }

    go func() {
        value := 0
        for {
            select {
            case <-c.inc:
                value++
            case c.get <- value:
            }
        }
    }()

    return c
}

func (c *Counter) Inc() { c.inc <- struct{}{} }
func (c *Counter) Get() int { return <-c.get }
\`\`\`

### "Concurrency is not parallelism."

Concurrency is about structure. Parallelism is about execution.

\`\`\`go
// Concurrent (structure): two goroutines can interleave
go handleRequest(req1)
go handleRequest(req2)

// Parallel (execution): actually running simultaneously
// Enabled by GOMAXPROCS > 1 and multiple CPU cores

// You can have concurrency without parallelism:
// - Single core with goroutines (interleaved execution)
// You can have parallelism without concurrency:
// - SIMD operations (same instruction, multiple data)
\`\`\`

### "The bigger the interface, the weaker the abstraction."

Large interfaces with many methods are hard to implement and mock, creating tight coupling. Small, focused interfaces of one or two methods are easier to satisfy, compose, and test.

\`\`\`go
// Weak abstraction - too many methods
type DataStore interface {
    Get(key string) ([]byte, error)
    Set(key string, value []byte) error
    Delete(key string) error
    List(prefix string) ([]string, error)
    Watch(key string) <-chan Event
    Transaction(fn func(Tx) error) error
    Backup() ([]byte, error)
    Restore(data []byte) error
}

// Strong abstraction - minimal interface
type Getter interface {
    Get(key string) ([]byte, error)
}

type Setter interface {
    Set(key string, value []byte) error
}

// Function accepts only what it needs
func copyValue(src Getter, dst Setter, key string) error {
    data, err := src.Get(key)
    if err != nil {
        return err
    }
    return dst.Set(key, data)
}

// Works with Redis, S3, in-memory, file system, etc.
\`\`\`

### "Make the zero value useful."

Designing types so their zero value is immediately usable avoids requiring explicit initialization. \`sync.Mutex\`, \`bytes.Buffer\`, and \`sync.WaitGroup\` exemplify this principle from the standard library.

\`\`\`go
// sync.Mutex is useful with zero value
var mu sync.Mutex
mu.Lock()
mu.Unlock()

// bytes.Buffer is useful with zero value
var buf bytes.Buffer
buf.WriteString("hello")

// Your types should be too
type Config struct {
    Timeout   time.Duration // Zero means "use default"
    MaxRetries int          // Zero means "no retries"
    Debug      bool         // Zero means "disabled"
}

func (c Config) TimeoutOrDefault() time.Duration {
    if c.Timeout == 0 {
        return 30 * time.Second
    }
    return c.Timeout
}

// Now zero value is immediately useful
var cfg Config
client := NewClient(cfg) // Works fine
\`\`\`

### "any says nothing."

A parameter or return type of \`any\` conveys no information about what the caller should pass or expect. Concrete types and narrow interfaces produce self-documenting APIs the type checker can verify.

\`\`\`go
// Says nothing about what's expected
func Process(data any) { ... }

// Says exactly what's needed
func Process(data io.Reader) { ... }

// With generics (Go 1.18+), be specific
func Sum[T int | float64](values []T) T { ... }

// Even better with type constraints
type Numeric interface {
    int | int64 | float64
}

func Sum[T Numeric](values []T) T { ... }
\`\`\`

### "Gofmt's style is no one's favorite, yet gofmt is everyone's favorite."

A single, enforced formatting standard eliminates all style debates. \`gofmt\` (and its superset \`goimports\`) produce canonical formatting that every Go project shares. Run them automatically on save or in CI:

\`\`\`bash
# Format all Go files
gofmt -w .

# Or use goimports (also manages imports)
goimports -w .

# In CI/CD
if [ "\$(gofmt -s -l . | wc -l)" -gt 0 ]; then
    echo "Code not formatted"
    exit 1
fi
\`\`\`

### "A little copying is better than a little dependency."

Adding a dependency for a small amount of functionality introduces transitive dependencies and upgrade costs. Copying a few lines of well-understood code is often the more pragmatic choice.

\`\`\`go
// Note: min() and max() are builtin functions since Go 1.21

// Copy small utilities rather than importing packages
// Benefits:
// - No dependency management
// - No version conflicts
// - No security vulnerabilities from dependencies
// - Faster compilation
\`\`\`

### "Clear is better than clever."

Clever code optimizes for the author. Clear code optimizes for the reader. Go's culture strongly favors explicit, readable code over terse or tricky constructs that require mental decoding.

\`\`\`go
// Clever (don't do this)
func isPowerOfTwo(n int) bool {
    return n > 0 && n&(n-1) == 0
}

// Clear
func isPowerOfTwo(n int) bool {
    if n <= 0 {
        return false
    }

    for n > 1 {
        if n%2 != 0 {
            return false
        }
        n /= 2
    }

    return true
}

// Even better: document the clever solution if you use it
// isPowerOfTwo checks if n is a power of two.
// Uses bit manipulation: powers of two have exactly one bit set,
// so n & (n-1) clears that bit, leaving zero.
func isPowerOfTwo(n int) bool {
    return n > 0 && n&(n-1) == 0
}
\`\`\`

### "Errors are values."

Because \`error\` is an interface, errors are regular values that can be stored in slices, compared, wrapped, and passed around like any other data. This means you can program with errors, accumulate them, defer checking, or embed them in state machines, rather than treating every error as an immediate control-flow interrupt:

\`\`\`go
// Collect errors
var errs []error
for _, item := range items {
    if err := process(item); err != nil {
        errs = append(errs, err)
    }
}
if len(errs) > 0 {
    return errors.Join(errs...)
}

// Error as state
type Scanner struct {
    err error
    // ...
}

func (s *Scanner) Scan() bool {
    if s.err != nil {
        return false
    }
    // scanning logic...
    return true
}

func (s *Scanner) Err() error {
    return s.err
}

// Usage
scanner := NewScanner(reader)
for scanner.Scan() {
    // process
}
if err := scanner.Err(); err != nil {
    // handle
}
\`\`\`

### Using Proverbs in Code Review

The Go proverbs are at their most useful when applied in review. "A little copying is better than a little dependency" resolves the "should we import this library for one function?" question. "Clear is better than clever" resolves the "should we use this clever generic trick?" question. Internalise the proverbs and cite them by name in review. The team learns the framing faster when the language is shared.

### Proverbs That Need Modern Context

Two proverbs from the original set deserve a 2026 update:

**"Don't communicate by sharing memory. Share memory by communicating."** The counter-with-channels example above is rhetorically useful but operationally wrong. A production counter uses \`sync/atomic\` or \`sync.Mutex\`. The channel version allocates, context-switches, and is several orders of magnitude slower than the mutex version. The proverb is right about the overall preference (channels for coordination, not for every shared variable) but wrong when read literally. Teach the proverb with the caveat: channels for ownership transfer and goroutine coordination, mutexes or atomics for bounded shared state.

**"A little copying is better than a little dependency."** Sound advice in 2013 when Go had no module system. In 2026, with Go modules, \`go mod tidy\`, and \`govulncheck\`, the cost of a well-maintained dependency is lower than the original proverb suggests. The updated version: "a little copying is better than a speculative dependency". Copy from a stdlib source or a well-maintained library if you need five lines and do not want to take on the maintenance burden. Take the dependency when the library provides sustained value, has a healthy release cadence, and passes \`govulncheck\`.

### Staff Lens: The Proverbs as Review Shorthand

On a large Go team, "cite the proverb by name" is a conflict-resolution tool. A reviewer who writes "this violates 'clear is better than clever'" has made an objective claim grounded in a shared principle, not a personal preference. The author can accept it, argue that the code is clear enough, or propose a refactor. None of those paths require the reviewer to win a stylistic argument from scratch. Train the team to use the proverbs this way. Pin the list in the team wiki. Resolve review disputes by reference to the shared list, not by reference to who has more tenure. This moves the culture from "senior engineers have taste" to "the team has an agreed standard", which scales where taste does not.

### Principal Lens: Adding to the Proverbs

A large enough Go org accumulates its own proverbs beyond the canonical list. "Context first, error last" for function signatures. "Errors.Is for sentinels, errors.As for types". "Prefer sync.Mutex to sync.RWMutex until the profile shows contention". These are useful when written down. Principal engineers periodically audit the team's internal idioms, compare them against the canonical proverbs, and publish the delta. The delta is the org-specific wisdom that did not exist when Pike wrote the original list. Treat it as a live document. The canonical Go proverbs cover the language. The team's proverbs cover the codebase.

---
`;
