## 90K.1 The Power of 10: NASA's Sacred Coding Rules

In 2006, Gerard Holzmann - a researcher at NASA's Jet Propulsion Laboratory and the
creator of the SPIN model checker - published a set of 10 coding rules designed to make
C code amenable to static analysis and formal verification. These rules were not
suggestions. They were mandatory for all safety-critical flight software at JPL. Holzmann
argued that the existing C coding standards (MISRA-C, CERT-C) were too voluminous  - 
hundreds of rules that no one could remember - and that a small set of strict,
verifiable rules would be more effective.

The Power of 10 rules are deliberately restrictive. They ban language features that are
widely used in general-purpose programming: recursion, dynamic memory allocation (after
initialization), unbounded loops, and complex preprocessor macros. Each ban exists
because the feature makes the code harder to analyze statically or introduces failure
modes that cannot be bounded at compile time.

Let us examine each rule in detail, understand its rationale, and translate it into Go.

### Rule 1: Avoid Complex Flow Constructs - Especially Recursion

**The NASA Rule:** *Restrict all code to very simple control flow constructs. Do not use
goto statements, setjmp or longjmp constructs, or direct or indirect recursion.*

**Rationale:** Recursion creates call stacks of unbounded depth. In a system with 256 MB
of RAM - or less - a deep recursion can overflow the stack and crash the process. More
importantly, recursive code is harder to analyze with static tools. Proving termination
of a recursive function requires finding a variant (a quantity that decreases on every
recursive call), which is often non-trivial. Iterative code with explicit loop bounds is
trivially verifiable: the loop runs at most N times, therefore it terminates.

**Go Translation:**

Go does not ban recursion - it is a general-purpose language. But Go's goroutine stacks
start small (a few KB) and grow dynamically, which means deep recursion does not cause
immediate stack overflow but does create unpredictable memory usage. In NASA-inspired Go
code, prefer iterative solutions with explicit bounds.

```go
package nasa

import "errors"

// BAD: Recursive tree traversal - unbounded depth, unpredictable stack usage.
func findNodeRecursive(node *TreeNode, target string) *TreeNode {
    if node == nil {
        return nil
    }
    if node.Name == target {
        return node
    }
    for _, child := range node.Children {
        if result := findNodeRecursive(child, target); result != nil {
            return result
        }
    }
    return nil
}

// TreeNode represents a node in a bounded tree structure.
type TreeNode struct {
    Name     string
    Children []*TreeNode
}

// MaxTreeDepth is the absolute maximum tree depth we support.
// NASA requires all bounds to be statically determinable.
const MaxTreeDepth = 64

// ErrMaxDepthExceeded indicates the tree exceeds the allowed depth.
var ErrMaxDepthExceeded = errors.New("tree depth exceeds maximum allowed depth")

// FindNodeIterative performs a bounded breadth-first search.
// The queue has a fixed maximum capacity. If the tree exceeds this,
// the function returns an error rather than consuming unbounded memory.
func FindNodeIterative(root *TreeNode, target string) (*TreeNode, error) {
    if root == nil {
        return nil, nil
    }

    const maxQueueSize = 4096
    queue := make([]*TreeNode, 0, maxQueueSize)
    queue = append(queue, root)

    visited := 0
    for len(queue) > 0 {
        visited++
        if visited > maxQueueSize {
            return nil, ErrMaxDepthExceeded
        }

        current := queue[0]
        queue = queue[1:]

        if current.Name == target {
            return current, nil
        }

        for _, child := range current.Children {
            if child != nil {
                if len(queue) >= maxQueueSize {
                    return nil, ErrMaxDepthExceeded
                }
                queue = append(queue, child)
            }
        }
    }

    return nil, nil
}

// IterativeFactorial computes factorial without recursion.
// Bounded by the maximum value representable in uint64.
func IterativeFactorial(n uint64) (uint64, error) {
    if n > 20 {
        return 0, errors.New("factorial overflow: n must be <= 20 for uint64")
    }
    result := uint64(1)
    for i := uint64(2); i <= n; i++ {
        result *= i
    }
    return result, nil
}
```

### Rule 2: All Loops Must Have Fixed Upper Bounds

**The NASA Rule:** *All loops must have a fixed upper bound. It must be trivially possible
for a checking tool to prove statically that a preset upper bound on the number of
iterations of a loop cannot be exceeded.*

**Rationale:** An unbounded loop is a potential infinite loop. In flight software, an
infinite loop means the processor hangs, the spacecraft stops responding, and the mission
is lost. Even in non-flight software, unbounded loops are a common source of production
outages (see Chapter 90G on Cloudflare's regex backtracking incident).

**Go Translation:**

Go's `for` loop without a condition (`for { ... }`) is an unbounded loop. Go's
`range` over a slice is naturally bounded. NASA-inspired Go code always uses bounded
iterations with explicit maximums.

```go
package nasa

import (
    "context"
    "errors"
    "time"
)

// MaxRetries bounds the number of retry attempts. NASA requires
// all loop bounds to be compile-time constants or statically
// determinable values.
const MaxRetries = 5

// MaxPollIterations prevents infinite polling loops.
const MaxPollIterations = 1000

// ErrMaxRetriesExceeded indicates all retry attempts have been exhausted.
var ErrMaxRetriesExceeded = errors.New("maximum retry attempts exceeded")

// ErrPollTimeout indicates the polling loop reached its iteration bound.
var ErrPollTimeout = errors.New("poll iteration limit exceeded")

// RetryWithBound attempts an operation with a fixed upper bound on retries.
// This follows NASA Rule 2: every loop has a provable upper bound.
func RetryWithBound(ctx context.Context, operation func() error) error {
    var lastErr error

    for attempt := 0; attempt < MaxRetries; attempt++ {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        lastErr = operation()
        if lastErr == nil {
            return nil
        }

        // Bounded backoff: 2^attempt * 100ms, capped at 5s.
        backoff := time.Duration(1<<uint(attempt)) * 100 * time.Millisecond
        if backoff > 5*time.Second {
            backoff = 5 * time.Second
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(backoff):
        }
    }

    return ErrMaxRetriesExceeded
}

// PollUntilReady polls a condition with a fixed iteration limit.
// BAD pattern: for { if ready() { break } } - no upper bound.
// GOOD pattern: bounded iteration with explicit limit.
func PollUntilReady(ctx context.Context, ready func() bool) error {
    for i := 0; i < MaxPollIterations; i++ {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        if ready() {
            return nil
        }

        time.Sleep(10 * time.Millisecond)
    }

    return ErrPollTimeout
}

// ProcessBatch processes items from a channel with a bounded iteration count.
// Even channel reads must be bounded to prevent hanging goroutines.
func ProcessBatch(ctx context.Context, items <-chan Item, maxItems int) ([]Result, error) {
    if maxItems <= 0 {
        return nil, errors.New("maxItems must be positive")
    }

    results := make([]Result, 0, maxItems)

    for i := 0; i < maxItems; i++ {
        select {
        case <-ctx.Done():
            return results, ctx.Err()
        case item, ok := <-items:
            if !ok {
                return results, nil // Channel closed - normal termination.
            }
            result, err := processItem(item)
            if err != nil {
                return results, err
            }
            results = append(results, result)
        }
    }

    return results, nil
}

// Item represents a work unit.
type Item struct {
    ID   int
    Data []byte
}

// Result represents a processed work unit.
type Result struct {
    ItemID int
    Output []byte
}

func processItem(item Item) (Result, error) {
    return Result{ItemID: item.ID, Output: item.Data}, nil
}
```

### Rule 3: No Dynamic Memory Allocation After Initialization

**The NASA Rule:** *Do not use dynamic memory allocation after initialization.*

**Rationale:** `malloc` can fail (return NULL). `malloc` fragments the heap over time.
`malloc` introduces non-deterministic timing - the allocator may take microseconds or
milliseconds depending on heap state. In a real-time system with hard deadlines, this
non-determinism is unacceptable. NASA flight software allocates all memory at startup,
partitions it into fixed-size pools, and never calls `malloc` again.

**Go Translation:**

This is the hardest NASA rule to apply in Go because Go's garbage collector and runtime
allocate memory constantly. Slice appends, map insertions, goroutine creation - they all
allocate. However, for performance-critical and reliability-critical Go services, you can
pre-allocate resources during initialization and avoid allocations in the hot path.

```go
package nasa

import (
    "errors"
    "sync"
)

// FixedPool is a pre-allocated pool of fixed-size byte buffers.
// All memory is allocated at construction time. No allocations
// occur during Get/Put operations.
type FixedPool struct {
    mu      sync.Mutex
    buffers [][]byte
    free    []int // Stack of free buffer indices.
    bufSize int
}

// ErrPoolExhausted indicates no buffers are available.
var ErrPoolExhausted = errors.New("buffer pool exhausted: no free buffers")

// NewFixedPool allocates all buffers upfront. After this call,
// no further heap allocations occur for pool operations.
func NewFixedPool(count, bufSize int) *FixedPool {
    p := &FixedPool{
        buffers: make([][]byte, count),
        free:    make([]int, count),
        bufSize: bufSize,
    }

    // Allocate a single contiguous block and slice it.
    // This reduces heap fragmentation and improves cache locality.
    block := make([]byte, count*bufSize)
    for i := 0; i < count; i++ {
        start := i * bufSize
        p.buffers[i] = block[start : start+bufSize : start+bufSize]
        p.free[i] = i
    }

    return p
}

// Get retrieves a buffer from the pool without allocating.
func (p *FixedPool) Get() ([]byte, int, error) {
    p.mu.Lock()
    defer p.mu.Unlock()

    if len(p.free) == 0 {
        return nil, -1, ErrPoolExhausted
    }

    // Pop from free stack.
    idx := p.free[len(p.free)-1]
    p.free = p.free[:len(p.free)-1]

    // Zero the buffer before returning (defense in depth).
    buf := p.buffers[idx]
    for i := range buf {
        buf[i] = 0
    }

    return buf, idx, nil
}

// Put returns a buffer to the pool.
func (p *FixedPool) Put(idx int) error {
    if idx < 0 || idx >= len(p.buffers) {
        return errors.New("invalid buffer index")
    }

    p.mu.Lock()
    defer p.mu.Unlock()

    // Check for double-free.
    for _, freeIdx := range p.free {
        if freeIdx == idx {
            return errors.New("double free detected: buffer already in pool")
        }
    }

    p.free = append(p.free, idx)
    return nil
}

// Available returns the number of free buffers.
func (p *FixedPool) Available() int {
    p.mu.Lock()
    defer p.mu.Unlock()
    return len(p.free)
}

// Capacity returns the total number of buffers in the pool.
func (p *FixedPool) Capacity() int {
    return len(p.buffers)
}

// PreAllocatedRingBuffer is a fixed-capacity ring buffer that never allocates
// after construction. Overwrites oldest entries when full.
type PreAllocatedRingBuffer[T any] struct {
    mu    sync.Mutex
    items []T
    head  int
    tail  int
    count int
    cap   int
}

// NewPreAllocatedRingBuffer creates a ring buffer with fixed capacity.
func NewPreAllocatedRingBuffer[T any](capacity int) *PreAllocatedRingBuffer[T] {
    return &PreAllocatedRingBuffer[T]{
        items: make([]T, capacity),
        cap:   capacity,
    }
}

// Push adds an item. If full, overwrites the oldest item.
// Never allocates. Always O(1). Always succeeds.
func (rb *PreAllocatedRingBuffer[T]) Push(item T) (overwritten bool) {
    rb.mu.Lock()
    defer rb.mu.Unlock()

    rb.items[rb.tail] = item
    rb.tail = (rb.tail + 1) % rb.cap

    if rb.count == rb.cap {
        rb.head = (rb.head + 1) % rb.cap
        return true
    }

    rb.count++
    return false
}

// Pop removes and returns the oldest item.
func (rb *PreAllocatedRingBuffer[T]) Pop() (T, bool) {
    rb.mu.Lock()
    defer rb.mu.Unlock()

    var zero T
    if rb.count == 0 {
        return zero, false
    }

    item := rb.items[rb.head]
    rb.items[rb.head] = zero // Clear reference for GC.
    rb.head = (rb.head + 1) % rb.cap
    rb.count--

    return item, true
}

// Len returns the current number of items.
func (rb *PreAllocatedRingBuffer[T]) Len() int {
    rb.mu.Lock()
    defer rb.mu.Unlock()
    return rb.count
}
```

### Rule 4: No Function Should Be Longer Than a Single Printed Page

**The NASA Rule:** *No function should be longer than what can be printed on a single
sheet of paper in a standard reference format with one line per statement and one line per
declaration. Typically, this means no more than about 60 lines of code per function.*

**Rationale:** Long functions are hard to understand, hard to test, and hard to verify.
A 60-line limit forces decomposition into small, focused functions that each do one thing.
This aligns perfectly with the Single Responsibility Principle from SOLID.

**Go Translation:**

Go culture already favors short functions, but does not enforce a hard limit. NASA-
inspired Go code enforces a 60-line limit per function through linting. Here is an
example of decomposing a long function.

```go
package nasa

import (
    "context"
    "errors"
    "fmt"
    "time"
)

// BAD: A monolithic function that handles too many concerns.
// In real code, this might be 200+ lines of validation, transformation,
// persistence, and notification logic all in one function.

// TelemetryReading represents a single sensor reading from a spacecraft.
type TelemetryReading struct {
    SensorID    string
    Timestamp   time.Time
    Value       float64
    Unit        string
    StatusFlags uint32
}

// ProcessedReading is the validated, normalized telemetry data.
type ProcessedReading struct {
    SensorID       string
    Timestamp      time.Time
    NormalizedValue float64
    Unit           string
    QualityScore   float64
    Anomalous      bool
}

// TelemetryProcessor handles incoming telemetry with NASA-style
// function decomposition. Each method is under 60 lines.
type TelemetryProcessor struct {
    store      TelemetryStore
    alerter    AnomalyAlerter
    thresholds map[string]Threshold
}

// Threshold defines acceptable ranges for a sensor.
type Threshold struct {
    Min      float64
    Max      float64
    Critical float64
}

// TelemetryStore persists processed readings.
type TelemetryStore interface {
    Save(ctx context.Context, reading ProcessedReading) error
}

// AnomalyAlerter sends anomaly notifications.
type AnomalyAlerter interface {
    Alert(ctx context.Context, reading ProcessedReading, reason string) error
}

// Process is the top-level function. It coordinates the pipeline
// but delegates each step to a focused sub-function.
func (tp *TelemetryProcessor) Process(ctx context.Context, raw TelemetryReading) error {
    if err := tp.validate(raw); err != nil {
        return fmt.Errorf("validation failed for sensor %s: %w", raw.SensorID, err)
    }

    processed := tp.normalize(raw)
    processed.QualityScore = tp.assessQuality(raw)
    processed.Anomalous = tp.detectAnomaly(processed)

    if err := tp.store.Save(ctx, processed); err != nil {
        return fmt.Errorf("failed to persist reading: %w", err)
    }

    if processed.Anomalous {
        reason := tp.anomalyReason(processed)
        if err := tp.alerter.Alert(ctx, processed, reason); err != nil {
            return fmt.Errorf("failed to send anomaly alert: %w", err)
        }
    }

    return nil
}

// validate checks that the raw reading is well-formed.
// Each check is explicit and produces a clear error message.
func (tp *TelemetryProcessor) validate(raw TelemetryReading) error {
    if raw.SensorID == "" {
        return errors.New("sensor ID is empty")
    }
    if raw.Timestamp.IsZero() {
        return errors.New("timestamp is zero")
    }
    if raw.Timestamp.After(time.Now().Add(1 * time.Minute)) {
        return errors.New("timestamp is in the future")
    }
    if raw.Unit == "" {
        return errors.New("unit is empty")
    }
    if _, ok := tp.thresholds[raw.SensorID]; !ok {
        return fmt.Errorf("unknown sensor: %s", raw.SensorID)
    }
    return nil
}

// normalize converts raw readings to a standard form.
func (tp *TelemetryProcessor) normalize(raw TelemetryReading) ProcessedReading {
    return ProcessedReading{
        SensorID:       raw.SensorID,
        Timestamp:      raw.Timestamp.UTC(),
        NormalizedValue: raw.Value,
        Unit:           raw.Unit,
    }
}

// assessQuality scores the reading quality from 0.0 to 1.0.
func (tp *TelemetryProcessor) assessQuality(raw TelemetryReading) float64 {
    score := 1.0

    // Degrade quality for stale readings.
    age := time.Since(raw.Timestamp)
    if age > 30*time.Second {
        score -= 0.3
    }

    // Degrade quality for flagged status.
    if raw.StatusFlags != 0 {
        score -= 0.2
    }

    if score < 0 {
        score = 0
    }
    return score
}

// detectAnomaly checks if the reading is outside expected bounds.
func (tp *TelemetryProcessor) detectAnomaly(p ProcessedReading) bool {
    threshold, ok := tp.thresholds[p.SensorID]
    if !ok {
        return true // Unknown sensor is always anomalous.
    }
    if p.NormalizedValue < threshold.Min || p.NormalizedValue > threshold.Max {
        return true
    }
    if p.QualityScore < 0.5 {
        return true
    }
    return false
}

// anomalyReason produces a human-readable explanation.
func (tp *TelemetryProcessor) anomalyReason(p ProcessedReading) string {
    threshold := tp.thresholds[p.SensorID]
    if p.NormalizedValue < threshold.Min {
        return fmt.Sprintf("value %.2f below minimum %.2f", p.NormalizedValue, threshold.Min)
    }
    if p.NormalizedValue > threshold.Max {
        return fmt.Sprintf("value %.2f above maximum %.2f", p.NormalizedValue, threshold.Max)
    }
    if p.QualityScore < 0.5 {
        return fmt.Sprintf("low quality score: %.2f", p.QualityScore)
    }
    return "unknown anomaly"
}
```

### Rule 5: Use a Minimum of Two Runtime Assertions Per Function

**The NASA Rule:** *The assertion density of the code should average to a minimum of two
assertions per function. Assertions must always be side-effect free and should be defined
as Boolean tests.*

**Rationale:** Assertions catch bugs at the point of occurrence rather than letting
corrupted state propagate. They serve as executable documentation - they declare what
must be true at a given point in the code. NASA found that high assertion density
correlates strongly with low defect density.

**Go Translation:**

Go does not have a built-in `assert` keyword. The idiomatic approach is to check
conditions and return errors or panic for invariant violations. For NASA-level rigor,
we create an assertion helper.

```go
package nasa

import (
    "fmt"
    "runtime"
    "strings"
)

// Assertion represents an invariant check result.
type Assertion struct {
    Condition bool
    Message   string
    File      string
    Line      int
}

// Assert checks a boolean condition. If false, it panics with
// file and line information. Use this for invariants that must
// never be violated - conditions where continued execution would
// produce corrupt results.
func Assert(condition bool, format string, args ...any) {
    if condition {
        return
    }

    _, file, line, ok := runtime.Caller(1)
    if !ok {
        file = "unknown"
        line = 0
    }

    msg := fmt.Sprintf(format, args...)
    panic(fmt.Sprintf("ASSERTION FAILED at %s:%d: %s", file, line, msg))
}

// AssertNotNil panics if the pointer is nil.
func AssertNotNil(ptr any, name string) {
    if ptr == nil {
        _, file, line, _ := runtime.Caller(1)
        panic(fmt.Sprintf("ASSERTION FAILED at %s:%d: %s must not be nil", file, line, name))
    }
}

// AssertInRange panics if value is outside [min, max].
func AssertInRange(value, min, max float64, name string) {
    if value < min || value > max {
        _, file, line, _ := runtime.Caller(1)
        panic(fmt.Sprintf(
            "ASSERTION FAILED at %s:%d: %s = %.6f outside range [%.6f, %.6f]",
            file, line, name, value, min, max,
        ))
    }
}

// AssertPositive panics if value is not positive.
func AssertPositive(value int, name string) {
    if value <= 0 {
        _, file, line, _ := runtime.Caller(1)
        panic(fmt.Sprintf(
            "ASSERTION FAILED at %s:%d: %s = %d must be positive",
            file, line, name, value,
        ))
    }
}

// Example usage following NASA Rule 5: minimum 2 assertions per function.

// NavigationVector represents a 3D vector for spacecraft navigation.
type NavigationVector struct {
    X, Y, Z float64
}

// Magnitude returns the length of the vector.
func (v NavigationVector) Magnitude() float64 {
    // Assertion 1: Input bounds check.
    AssertInRange(v.X, -1e15, 1e15, "X component")
    AssertInRange(v.Y, -1e15, 1e15, "Y component")
    AssertInRange(v.Z, -1e15, 1e15, "Z component")

    mag := sqrt(v.X*v.X + v.Y*v.Y + v.Z*v.Z)

    // Assertion 2: Output validity check.
    Assert(mag >= 0, "magnitude must be non-negative, got %f", mag)

    return mag
}

// Normalize returns a unit vector in the same direction.
func (v NavigationVector) Normalize() NavigationVector {
    mag := v.Magnitude()

    // Assertion 1: Cannot normalize a zero vector.
    Assert(mag > 1e-10, "cannot normalize near-zero vector (magnitude=%e)", mag)

    result := NavigationVector{
        X: v.X / mag,
        Y: v.Y / mag,
        Z: v.Z / mag,
    }

    // Assertion 2: Result must be approximately unit length.
    resultMag := result.Magnitude()
    Assert(
        resultMag > 0.999 && resultMag < 1.001,
        "normalized vector magnitude should be ~1.0, got %f", resultMag,
    )

    return result
}

// sqrt is a simple Newton's method square root to avoid importing math.
func sqrt(x float64) float64 {
    if x < 0 {
        panic("sqrt of negative number")
    }
    if x == 0 {
        return 0
    }
    z := x / 2
    for i := 0; i < 100; i++ {
        z = z - (z*z-x)/(2*z)
    }
    return z
}

// ValidateSensorID checks that a sensor ID follows the expected format.
func ValidateSensorID(id string) error {
    // Assertion 1: Non-empty.
    Assert(id != "", "sensor ID must not be empty")

    // Assertion 2: Bounded length.
    Assert(len(id) <= 64, "sensor ID length %d exceeds maximum 64", len(id))

    // Business logic validation.
    if !strings.HasPrefix(id, "SNS-") {
        return fmt.Errorf("sensor ID must start with 'SNS-': got %q", id)
    }

    return nil
}
```

### Rule 6: Restrict the Scope of Data to the Smallest Possible

**The NASA Rule:** *All data objects must be declared at the smallest possible level of
scope.*

**Rationale:** Global variables create hidden dependencies between functions. When a
function modifies a global, every other function that reads that global is implicitly
coupled. This makes the code harder to analyze, test, and reason about. Minimizing scope
reduces the blast radius of bugs and makes it possible for static analyzers to prove
properties about data flow.

**Go Translation:**

Go already encourages this through package-level encapsulation (unexported names) and
short-lived variables. NASA-inspired Go avoids package-level mutable state entirely.

```go
package nasa

import (
    "fmt"
    "sync"
    "time"
)

// Assert checks an invariant and panics if false.
func Assert(condition bool, message string) {
    if !condition {
        panic("assertion failed: " + message)
    }
}

// BAD: Package-level mutable global state.
// var globalConfig *Config
// var globalMetrics map[string]int64
// var mu sync.Mutex

// GOOD: All mutable state is encapsulated in structs with controlled access.

// SensorRegistry holds sensor configurations. All state is
// instance-scoped, not package-scoped.
type SensorRegistry struct {
    mu       sync.RWMutex
    sensors  map[string]*SensorConfig
    maxCount int
}

// SensorConfig holds configuration for a single sensor.
type SensorConfig struct {
    ID           string
    Name         string
    MinValue     float64
    MaxValue     float64
    SampleRateHz int
    CreatedAt    time.Time
    UpdatedAt    time.Time
}

// NewSensorRegistry creates a new registry with a bounded maximum.
func NewSensorRegistry(maxSensors int) *SensorRegistry {
    Assert(maxSensors > 0, "maxSensors must be positive")
    Assert(maxSensors <= 10000, "maxSensors must be <= 10000")

    return &SensorRegistry{
        sensors:  make(map[string]*SensorConfig, maxSensors),
        maxCount: maxSensors,
    }
}

// Register adds a sensor. Fails if capacity is reached.
func (r *SensorRegistry) Register(cfg SensorConfig) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if len(r.sensors) >= r.maxCount {
        return fmt.Errorf("sensor registry full: %d/%d", len(r.sensors), r.maxCount)
    }

    if _, exists := r.sensors[cfg.ID]; exists {
        return fmt.Errorf("sensor %s already registered", cfg.ID)
    }

    now := time.Now().UTC()
    cfg.CreatedAt = now
    cfg.UpdatedAt = now
    r.sensors[cfg.ID] = &cfg

    return nil
}

// Lookup retrieves a sensor config by ID.
func (r *SensorRegistry) Lookup(id string) (*SensorConfig, bool) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    cfg, ok := r.sensors[id]
    if !ok {
        return nil, false
    }

    // Return a copy to prevent mutation of internal state.
    copy := *cfg
    return &copy, true
}

// Count returns the number of registered sensors.
func (r *SensorRegistry) Count() int {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return len(r.sensors)
}
```

### Rule 7: Check the Return Value of All Non-Void Functions

**The NASA Rule:** *The return value of non-void functions must be checked by each calling
function, and the validity of parameters must be checked inside each function.*

**Rationale:** Ignoring an error return is how bugs propagate silently. A failed `write()`
that nobody checks means data was silently lost. A failed `malloc()` that nobody checks
means a null pointer dereference is coming.

**Go Translation:**

This is where Go shines. Go's explicit error returns and the community norm of checking
every error make this rule nearly automatic. The `errcheck` linter enforces it.

```go
package nasa

import (
    "context"
    "errors"
    "fmt"
    "io"
    "os"
)

// Assert checks an invariant and panics if false.
func Assert(condition bool, message string) {
    if !condition {
        panic("assertion failed: " + message)
    }
}

// BAD: Ignoring errors.
// f, _ := os.Open("data.bin")
// f.Write(data) // Error ignored
// f.Close()     // Error ignored

// GOOD: Every error checked, every return value used.

// SafeWriteFile writes data to a file with NASA-level error checking.
// Every operation that can fail is checked. The function either
// succeeds completely or fails with a clear error.
func SafeWriteFile(path string, data []byte) (retErr error) {
    Assert(path != "", "file path must not be empty")
    Assert(len(data) > 0, "data must not be empty")
    Assert(len(data) <= 100*1024*1024, "data exceeds 100MB limit")

    f, err := os.CreateTemp("", "nasa-write-*.tmp")
    if err != nil {
        return fmt.Errorf("failed to create temp file: %w", err)
    }

    tmpPath := f.Name()

    // Ensure cleanup on any error path.
    defer func() {
        if retErr != nil {
            // Attempt cleanup but don't mask the original error.
            _ = f.Close()
            _ = os.Remove(tmpPath)
        }
    }()

    // Write with explicit byte count verification.
    n, err := f.Write(data)
    if err != nil {
        return fmt.Errorf("write failed: %w", err)
    }
    if n != len(data) {
        return fmt.Errorf("short write: wrote %d of %d bytes", n, len(data))
    }

    // Sync to disk - data must survive power loss.
    if err := f.Sync(); err != nil {
        return fmt.Errorf("fsync failed: %w", err)
    }

    // Close before rename.
    if err := f.Close(); err != nil {
        return fmt.Errorf("close failed: %w", err)
    }

    // Atomic rename.
    if err := os.Rename(tmpPath, path); err != nil {
        return fmt.Errorf("rename failed: %w", err)
    }

    return nil
}

// SafeCopy copies from reader to writer with bounded reads and full
// error checking on every operation.
func SafeCopy(ctx context.Context, dst io.Writer, src io.Reader, maxBytes int64) (int64, error) {
    Assert(maxBytes > 0, "maxBytes must be positive")

    const bufSize = 32 * 1024 // 32KB read buffer - fixed size.
    buf := make([]byte, bufSize)

    var totalWritten int64

    for i := 0; i < int(maxBytes/int64(bufSize))+1; i++ {
        select {
        case <-ctx.Done():
            return totalWritten, ctx.Err()
        default:
        }

        remaining := maxBytes - totalWritten
        if remaining <= 0 {
            break
        }

        readSize := int64(bufSize)
        if remaining < readSize {
            readSize = remaining
        }

        nr, readErr := src.Read(buf[:readSize])
        if nr > 0 {
            nw, writeErr := dst.Write(buf[:nr])
            if writeErr != nil {
                return totalWritten, fmt.Errorf("write error at byte %d: %w", totalWritten, writeErr)
            }
            if nw != nr {
                return totalWritten, fmt.Errorf("short write: wrote %d of %d bytes", nw, nr)
            }
            totalWritten += int64(nw)
        }

        if readErr != nil {
            if errors.Is(readErr, io.EOF) {
                return totalWritten, nil
            }
            return totalWritten, fmt.Errorf("read error at byte %d: %w", totalWritten, readErr)
        }
    }

    return totalWritten, nil
}
```

### Rule 8: Restrict the Use of the Preprocessor

**The NASA Rule:** *The use of the preprocessor must be limited to the inclusion of header
files and simple macro definitions. Token pasting, variable-length argument lists
(in macro definitions), and recursive macro calls are not allowed.*

**Rationale:** The C preprocessor is a text-substitution engine that operates before the
compiler sees the code. Complex macros produce code that looks like one thing but compiles
as another. This makes static analysis unreliable and debugging nearly impossible.

**Go Translation:**

Go has no preprocessor. This rule is automatically satisfied. However, the spirit of
the rule - "the code you read should be the code that runs" - applies to Go's code
generation tools (`go generate`, `//go:embed`, `//go:linkname`). NASA-inspired Go
minimizes hidden code generation and avoids reflect-heavy patterns that obscure behavior.

```go
package nasa

import (
    "errors"
    "time"
)

// Go satisfies Rule 8 by design: no preprocessor, no macros,
// no token pasting. The code you read is the code that compiles.
//
// The spirit of the rule extends to:
// 1. Avoid reflect-heavy patterns that obscure types at compile time.
// 2. Avoid code generation that produces unreadable output.
// 3. Avoid //go:linkname to call unexported functions.
// 4. Use //go:embed only for static assets, not logic.
//
// BAD: Using reflect to decode configuration.
//   reflect.ValueOf(cfg).Elem().FieldByName(key).Set(reflect.ValueOf(value))
//
// GOOD: Explicit, type-safe configuration.

// MissionConfig holds mission parameters with explicit types.
// No reflection, no any, no dynamic field access.
type MissionConfig struct {
    MissionID     string
    LaunchWindowStart time.Time
    LaunchWindowEnd   time.Time
    MaxVelocityMPS    float64
    MaxAltitudeM      float64
    FuelCapacityKG    float64
    CrewSize          int
    AutoAbortEnabled  bool
}

// Validate checks all fields explicitly. No reflection-based
// "validate" struct tags that hide logic in tag strings.
func (c MissionConfig) Validate() error {
    if c.MissionID == "" {
        return errors.New("mission ID is required")
    }
    if c.LaunchWindowStart.IsZero() {
        return errors.New("launch window start is required")
    }
    if c.LaunchWindowEnd.IsZero() {
        return errors.New("launch window end is required")
    }
    if !c.LaunchWindowEnd.After(c.LaunchWindowStart) {
        return errors.New("launch window end must be after start")
    }
    if c.MaxVelocityMPS <= 0 {
        return errors.New("max velocity must be positive")
    }
    if c.MaxAltitudeM <= 0 {
        return errors.New("max altitude must be positive")
    }
    if c.FuelCapacityKG <= 0 {
        return errors.New("fuel capacity must be positive")
    }
    if c.CrewSize < 0 {
        return errors.New("crew size must be non-negative")
    }
    if c.CrewSize > 12 {
        return errors.New("crew size exceeds maximum of 12")
    }
    return nil
}
```

### Rule 9: Restrict the Use of Pointers

**The NASA Rule:** *The use of pointers should be restricted. Specifically, no more than
one level of dereferencing is allowed. Pointer dereference operations may not be hidden
in macro definitions or inside typedef declarations. Function pointers are not permitted.*

**Rationale:** Pointer arithmetic is the single largest source of bugs in C code: buffer
overflows, dangling pointers, null dereferences, and use-after-free. Restricting pointers
to a single level of indirection makes the code analyzable by tools and prevents the most
dangerous classes of memory corruption.

**Go Translation:**

Go already eliminates pointer arithmetic (no `ptr + offset` in safe code). Go's garbage
collector prevents use-after-free and dangling pointers. The remaining concern in Go is
nil pointer dereferences, which can be mitigated with nil checks and value types.

```go
package nasa

import "fmt"

// BAD: Nested pointers that create nil-dereference chains.
// type BadConfig struct {
//     Server **ServerConfig  // Double pointer - banned by Rule 9.
//     DB     *struct {
//         Pool *struct {
//             Max *int       // Triple indirection - hard to reason about.
//         }
//     }
// }

// GOOD: Flat structures with at most one level of pointer indirection.

// FlightParameters uses value types wherever possible.
// Pointers are used only when nil semantics are needed.
type FlightParameters struct {
    VelocityMPS float64
    AltitudeM   float64
    HeadingDeg  float64
    PitchDeg    float64
    RollDeg     float64
}

// BoundedFlightEnvelope defines the safe operating range.
type BoundedFlightEnvelope struct {
    MaxVelocityMPS float64
    MaxAltitudeM   float64
    MinAltitudeM   float64
    MaxGForce      float64
}

// CheckEnvelope verifies flight parameters are within safe bounds.
// Uses value receivers - no pointer indirection needed.
func (env BoundedFlightEnvelope) CheckEnvelope(params FlightParameters) error {
    if params.VelocityMPS > env.MaxVelocityMPS {
        return fmt.Errorf("velocity %.1f exceeds max %.1f m/s",
            params.VelocityMPS, env.MaxVelocityMPS)
    }
    if params.AltitudeM > env.MaxAltitudeM {
        return fmt.Errorf("altitude %.1f exceeds max %.1f m",
            params.AltitudeM, env.MaxAltitudeM)
    }
    if params.AltitudeM < env.MinAltitudeM {
        return fmt.Errorf("altitude %.1f below min %.1f m",
            params.AltitudeM, env.MinAltitudeM)
    }
    return nil
}

// NilSafeGet extracts a value from a pointer with a default.
// This pattern avoids nil dereference panics.
func NilSafeGet[T any](ptr *T, defaultVal T) T {
    if ptr == nil {
        return defaultVal
    }
    return *ptr
}

// NilSafeAccess wraps a potentially-nil pointer access with an error.
func NilSafeAccess[T any](ptr *T, name string) (T, error) {
    if ptr == nil {
        var zero T
        return zero, fmt.Errorf("%s is nil", name)
    }
    return *ptr, nil
}
```

### Rule 10: Compile with All Warnings Enabled and Fix Every Warning

**The NASA Rule:** *All code must be compiled, from the first day of development, with all
compiler warnings enabled at the compiler's most pedantic setting. All code must compile
with these settings without any warnings. All code must be checked daily with at least one,
but preferably more than one, rigorous static source code analyzer and should pass
the analyses with zero warnings.*

**Rationale:** Compiler warnings exist because the compiler detected something suspicious.
Ignoring warnings means ignoring the most qualified reviewer of your code. Static
analyzers catch entire classes of bugs that testing misses: data races, resource leaks,
unreachable code, and more.

**Go Translation:**

Go's compiler produces zero warnings - it treats everything as either an error or
acceptable. This means you need external tools to achieve NASA-level static analysis.

```go
package nasa

// NASA Rule 10 in Go: Run ALL of these on every commit.
//
// Required tools (minimum):
//   go vet ./...           - Official Go static analyzer.
//   staticcheck ./...      - Advanced static analysis (SA, S, ST, QF checks).
//   golangci-lint run      - Meta-linter running 50+ analyzers.
//   go test -race ./...    - Race detector (dynamic analysis).
//   govulncheck ./...      - Known vulnerability scanner.
//
// NASA-equivalent CI pipeline configuration:
//
// .github/workflows/nasa-checks.yml:
// ```yaml
// name: NASA-Level Code Analysis
// on: [push, pull_request]
// jobs:
//   analyze:
//     runs-on: ubuntu-latest
//     steps:
//       - uses: actions/checkout@v4
//       - uses: actions/setup-go@v5
//         with:
//           go-version: '1.27'
//       - name: go vet
//         run: go vet ./...
//       - name: staticcheck
//         run: |
//           go install honnef.co/go/tools/cmd/staticcheck@latest
//           staticcheck ./...
//       - name: golangci-lint
//         uses: golangci/golangci-lint-action@v4
//         with:
//           args: --enable-all
//       - name: race detector
//         run: go test -race -count=1 ./...
//       - name: govulncheck
//         run: |
//           go install golang.org/x/vuln/cmd/govulncheck@latest
//           govulncheck ./...
//       - name: deadcode
//         run: |
//           go install golang.org/x/tools/cmd/deadcode@latest
//           deadcode ./...
// ```
//
// All checks must pass with ZERO warnings before merge.
// This is non-negotiable, just like at NASA.
```

### Power of 10 Summary Table

| # | NASA Rule | Go Equivalent | Enforced By |
|---|-----------|---------------|-------------|
| 1 | No recursion | Iterative algorithms with explicit bounds | Discipline + linter |
| 2 | Bounded loops | `for i := 0; i < max; i++` with const max | Discipline |
| 3 | No dynamic alloc after init | Pre-allocate, sync.Pool, fixed buffers | Discipline |
| 4 | Functions ≤ 60 lines | Short functions | `funlen` linter |
| 5 | ≥ 2 assertions/function | Assert() helpers, explicit checks | Discipline |
| 6 | Minimal scope | Unexported fields, local variables | Go visibility rules |
| 7 | Check all returns | `if err != nil { return err }` | `errcheck` linter |
| 8 | No preprocessor | Go has no preprocessor | Language design |
| 9 | Restrict pointers | Value types, nil-safe patterns | `nilaway` analyzer |
| 10 | All warnings fixed | go vet + staticcheck + golangci-lint | CI pipeline |

---
