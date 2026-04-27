export default `## 5.12 Interview Questions

Memory questions are a staple of FAANG Go interviews. Interviewers use them to separate candidates who know the language surface from candidates who can reason about allocation cost, escape behavior, and GC interactions in a running system.

> **What FAANG actually tests here**: whether you can predict allocation behavior from reading code, identify unnecessary heap pressure, and trace a latency spike to GC pauses or bad escape choices. Memorized definitions fail. Operational thinking passes.

### Question 1: What's the difference between new() and make()?

**What FAANG expects**: you can explain why slices, maps, and channels need runtime initialization and why \`new\` alone is insufficient. Bonus: you know that idiomatic Go prefers \`&T{}\` over \`new(T)\` whenever any field needs initialization.

**Answer:**

\`new(T)\` allocates zeroed memory for type T and returns a pointer (*T). It works with any type.

\`make(T, args)\` creates and initializes slices, maps, and channels only. It returns T (not *T) because these types are already reference types internally.

\`\`\`go
// new - allocates zeroed memory, returns pointer
p := new(int)     // *int pointing to 0
s := new([]int)   // *[]int pointing to nil slice

// make - creates initialized reference types
slice := make([]int, 10)        // []int with len=10, cap=10
m := make(map[string]int)       // Initialized map
ch := make(chan int, 5)         // Buffered channel

// You can't use make for regular types
// x := make(int)  // Compile error
\`\`\`

**Follow-ups**:
- Why does \`new([]int)\` produce a pointer to a nil slice rather than an empty one?
- When would you prefer \`new(T)\` over \`&T{}\` in real code?

### Question 2: Explain escape analysis and how to prevent allocations

**What FAANG expects**: you can name the five canonical escape triggers, read \`-gcflags="-m"\` output, and give a production example where you eliminated an escape. Hand-wavy "the compiler decides" fails senior bar.

**Answer:**

Escape analysis is the compiler's decision process for stack vs heap allocation. A value "escapes" when:

1. Its address is returned from a function
2. It's stored in a global variable
3. It's sent on a channel
4. It's stored in an interface
5. It's captured by a closure that outlives the current scope

Prevention strategies:

\`\`\`go
// 1. Return values instead of pointers (for small types)
func good() Point { return Point{1, 2} }  // Stack
func bad() *Point { return &Point{1, 2} } // Heap

// 2. Accept pointers for output (caller controls allocation)
func ParseGood(data []byte, out *Config) error {
    // out may be stack-allocated by caller
}

// 3. Preallocate slices
s := make([]int, 0, 100)  // Single allocation

// 4. Avoid any in hot paths
func Process[T any](items []T)  // Generics don't escape

// View escape analysis:
// go build -gcflags="-m" ./...
\`\`\`

**Follow-ups**:
- Why does storing a value in an \`any\` (\`interface{}\`) typically force it to escape?
- Do Go generics avoid the interface-escape cost? Explain the GC-shape stenciling model.

### Question 3: When should you use pointer vs value receivers?

**What FAANG expects**: the consistency rule (do not mix receiver kinds on one type), the method-set consequences for interface satisfaction, and the 64-to-128-byte rule of thumb for size-based choice.

**Answer:**

**Use pointer receivers when:**
- The method modifies the receiver
- The receiver is large (>64 bytes)
- For consistency (if any method is pointer, all should be)
- The type contains sync.Mutex or similar (must not be copied)

**Use value receivers when:**
- The receiver is small and immutable
- You want value semantics (copies prevent side effects)
- The type represents a "value" conceptually (time.Time, complex numbers)

\`\`\`go
// Value receiver - immutable, small
type Color struct{ R, G, B uint8 }
func (c Color) Hex() string { return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B) }

// Pointer receiver - mutable, contains mutex
type Counter struct {
    mu    sync.Mutex
    value int
}
func (c *Counter) Increment() { c.mu.Lock(); c.value++; c.mu.Unlock() }
\`\`\`

**Follow-ups**:
- If \`Counter\` has one pointer-receiver method and one value-receiver method, which method set does the value type have?
- Why does \`sync.Mutex\` embedded by value in a struct break the moment the struct is copied?

### Question 4: Explain the nil interface gotcha

**What FAANG expects**: the (type, value) model of interface values, the exact reason \`err != nil\` passes, and the coding rule that prevents the bug. Strong candidates mention \`go vet\`'s nilness analyzer.

**Answer:**

An interface value contains (type, value). It's nil only when both are nil:

\`\`\`go
type MyError struct{}
func (e *MyError) Error() string { return "error" }

func example() error {
    var err *MyError = nil    // Typed nil
    return err                // Interface: (*MyError, nil) - NOT nil!
}

func main() {
    err := example()
    fmt.Println(err == nil)   // false!
    fmt.Println(err)          // <nil>  (prints nil but isn't!)
}
\`\`\`

**Fix: Return untyped nil explicitly:**

\`\`\`go
func example() error {
    if shouldError {
        return &MyError{}
    }
    return nil  // Untyped nil = (nil, nil)
}
\`\`\`

**Follow-ups**:
- How does \`errors.Is\` behave on a typed-nil error pointer?
- Can the same bug happen with a non-error interface like \`io.Reader\`?

### Question 5: How does sync.Pool work and when should you use it?

**What FAANG expects**: correct pool semantics (unbounded, GC-clearable, per-P local caches), the rule that pooled state must be reset on Put, and a real workload where pooling paid off (usually per-request buffers).

**Answer:**

\`sync.Pool\` maintains a set of temporary objects that can be reused. Key characteristics:

- Objects may be garbage collected at any time
- Pool size is not bounded
- Get() returns an item or calls New() if empty
- Thread-safe for concurrent access

**Use when:**
- Allocating many short-lived objects
- Objects are expensive to create
- High request volume (pooling reduces GC pressure)

\`\`\`go
var bufPool = sync.Pool{
    New: func() any { return make([]byte, 4096) },
}

func HandleRequest(data []byte) {
    buf := bufPool.Get().([]byte)
    defer bufPool.Put(buf)

    // Use buf...
    copy(buf, data)
}
\`\`\`

**Caveats:** The garbage collector may clear the pool at any GC cycle, so pooled objects should never hold persistent state. Always clear sensitive data before calling \`Put()\`, and do not assume that a \`Get()\` call will return a previously pooled object rather than creating a new one.

**Follow-ups**:
- How does \`sync.Pool\`'s per-P local cache avoid contention, and what happened when Go 1.13 introduced the victim cache?
- When does pooling hurt performance? (hint: small objects below a threshold, low churn)

### Question 6: What changed in Go 1.26's Green Tea garbage collector, and does it affect how you write code?

**What FAANG expects**: you know Green Tea became the default in 1.26 (was an experiment in 1.25), that it restructures marking for SIMD scanning of small objects, and that it is transparent to user code. The correct answer includes the numbers (10 to 40 percent GC overhead reduction on allocation-heavy workloads) and the meta-point that this does not change how you reason about escapes.

**Answer:**

The Green Tea collector reorganizes the mark phase around groups of small objects with a shared scan pass, so the mark worker can process many objects with tight cache locality and, on amd64 and arm64, a handful of SIMD instructions per group instead of one mark per object. Most of the wins come from reducing memory stalls during marking, which used to dominate GC CPU on services with millions of short-lived objects per second. Users see two things after upgrading to 1.26: lower steady-state GC CPU (typically 10 to 40 percent), and slightly shorter p99 pauses because the mark phase finishes faster. Datadog publicly reported saving hundreds of gigabytes of RSS across their fleet after the upgrade.

Nothing about the language-level contract changed. The tri-color invariant still holds. Escape analysis still runs at compile time. Write barriers still fire on pointer stores during the concurrent mark phase. The rules in this chapter about avoiding unnecessary allocations and keeping hot-path work on the stack are unchanged: the collector just runs faster when those rules are broken.

\`\`\`go
// Before and after Go 1.26, this still allocates on the heap:
func leak() *int {
    x := 42
    return &x  // escapes
}

// The Green Tea collector cleans this up more efficiently, but the
// allocation itself is unchanged. Removing the escape is still cheaper
// than relying on a faster GC to cope with it.
\`\`\`

**Follow-ups**:
- How do write barriers interact with the tri-color invariant, and why does the mutator need them?
- What is \`GOMEMLIMIT\` and how did it change the GC tuning story when it landed in Go 1.19?

### Question 7: Walk me through how you would diagnose a Go service that started leaking memory after a deploy.

**What FAANG expects**: a structured workflow with pprof, the discipline of "capture before, capture after, diff", and the ability to articulate which kinds of leaks the heap profile catches versus which need other tools (goroutine profile, file descriptor count). This is the senior on-call question.

**Answer**: Three phases. Phase one is reproducing the leak with profiles. Capture a heap profile from the leaking instance (\`curl /debug/pprof/heap > heap.post\`), and ideally a baseline from a healthy instance or from before the deploy (\`heap.pre\`). Diff with \`go tool pprof -base heap.pre heap.post\`. The top growing functions point at the leak source.

Phase two is classifying. The heap profile catches retained-object leaks (a cache that grows without bound, a slice appended to without limit). It does not catch goroutine leaks (use \`/debug/pprof/goroutine\`), file-descriptor leaks (use \`lsof\` or the OS-level \`procfs\`), or off-heap leaks via cgo (use the OS allocator's debugging tools).

Phase three is fixing. The fix is usually one of: bound the retained data with an LRU or TTL, fix the goroutine that does not exit (almost always missing a \`ctx.Done()\` check), or add a \`Close()\` discipline for file descriptors. The deploy that introduced the leak is the diff to inspect for context.

**Follow-ups**:
- How does \`runtime.MemStats.HeapAlloc\` differ from RSS, and why might one grow while the other stays flat?
- What does the \`live=true\` parameter on the heap profile do, and when do you use it?

### Question 8 (Senior track): How would you reduce GC pressure on a hot path that allocates 100,000 small structs per second?

**What FAANG expects**: a sequence of escalating interventions, with the pre-conditions for each. The candidate should not jump straight to \`sync.Pool\`; the right first move is escape analysis.

**Answer**: First, run \`go build -gcflags="-m"\` and look at the allocations to confirm they are happening. Often the "obvious" hot allocation is not actually escaping, and the bottleneck is elsewhere.

Second, restructure the data flow to reduce allocations. Pass values instead of pointers where possible. Pre-allocate slices to known sizes. Replace interface parameters with concrete types or generics. These changes have no runtime cost and remove the allocation entirely.

Third, if allocations cannot be removed, pool them with \`sync.Pool\`. Verify with benchmarks that the pool is faster than direct allocation for the specific size and rate. For very small allocations the pool overhead can exceed the savings.

Fourth, if the workload is truly allocation-bound and pooling does not help, consider redesigning the algorithm. A workload that allocates 100,000 small structs per second often has a buffer-or-arena design that avoids allocation entirely (for example, parsing into a pre-allocated arena and discarding the whole arena at the end).

The discipline at every step is to measure with \`benchstat\`. Intuition about Go performance is wrong often enough that profile-driven optimisation is the only reliable approach.

**Follow-ups**:
- When does \`sync.Pool\` lose to direct allocation, and how do you tell?
- What is an arena allocator, and why was the proposal for arenas in the standard library declined?

### Question 9 (Senior track): Explain the role of \`weak.Pointer[T]\` (Go 1.24) and when you would use it.

**What FAANG expects**: an accurate explanation of weak references, the cache use case, and the limits.

**Answer**: A \`weak.Pointer[T]\` holds a reference to a value without preventing the GC from collecting it. If the GC determines the value is otherwise unreachable, it collects it, and the weak pointer's \`Value()\` returns nil. This is the missing piece for caches and observer patterns that should not retain their referents past usefulness.

The canonical use case is a cache where entries should be evictable under memory pressure. Pre-1.24, the workaround was an explicit eviction policy (LRU, TTL) plus manual reference counting. With \`weak.Pointer[T]\`, the GC handles eviction implicitly: when memory is tight, the cache shrinks. When memory is plentiful, the cache grows.

The limits: weak references add complexity to reasoning about lifetimes, they have a small but non-zero overhead, and they do not solve every cache problem (a cache that needs deterministic capacity bounds still wants explicit eviction). The discipline is "use weak references when memory-pressure-driven eviction is the right semantic, use explicit eviction when bounded capacity is the right semantic".

**Follow-ups**:
- How does \`weak.Pointer[T]\` interact with \`runtime.AddCleanup\`?
- What is the difference between a weak reference and a finalizer?

---
`;
