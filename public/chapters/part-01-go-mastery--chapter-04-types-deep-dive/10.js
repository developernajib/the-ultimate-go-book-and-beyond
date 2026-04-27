export default `## 4.9 Interview Questions

These questions test the type system knowledge that interviewers at Go-heavy companies (Google, Uber, Cloudflare, HashiCorp, Datadog, Stripe) ask most frequently. Each answer includes code you can run to verify the behavior yourself.

> **What FAANG actually tests here**: whether you have an operational mental model of slices, maps, structs, and interfaces, not just textbook definitions. Interviewers want to see that you have debugged these in production, know the gotchas, and can predict allocation and aliasing behavior from reading code.

### Q1: What's the difference between a nil slice and an empty slice?

**What FAANG expects**: the observable differences (equality to nil, JSON output), the identical behavior for indexing, len, and append, and a real production reason to pick one over the other.

**Answer:**

\`\`\`go
var nilSlice []int      // nil slice: nil, len=0, cap=0
emptySlice := []int{}   // empty slice: not nil, len=0, cap=0

// Both have zero length
len(nilSlice) == len(emptySlice)  // true (both 0)

// But nil check differs
nilSlice == nil   // true
emptySlice == nil // false

// JSON encoding differs
json.Marshal(nilSlice)    // "null"
json.Marshal(emptySlice)  // "[]"

// Behavior is identical for most operations
nilSlice = append(nilSlice, 1)  // Works
emptySlice = append(emptySlice, 1)  // Works

// Best practice: return empty slice when you need "[]" in JSON
// Best practice: use nil slice for optional/unset fields
\`\`\`

**Follow-ups**:
- What does \`reflect.DeepEqual(nilSlice, emptySlice)\` return, and why?
- If an API contract says "the field is always an array," which should the handler return?

### Q2: Why does Go use value semantics for small structs but pointer semantics for large ones?

**What FAANG expects**: you can quantify the copy cost, name escape-analysis consequences, and know the convention that receiver type must be consistent across a type's method set.

Value semantics (copying) benefits:
- No aliasing bugs
- Better cache locality
- Simpler reasoning about mutations
- Safe for concurrent access (no shared state)

Pointer semantics benefits:
- No copy overhead for large structs
- Mutation is obvious (pointer receiver)
- Can represent "no value" with nil

\`\`\`go
// Small struct: use value semantics
type Point struct {
    X, Y int  // 16 bytes
}

func (p Point) Distance() float64 {
    return math.Sqrt(float64(p.X*p.X + p.Y*p.Y))
}

// Large struct: use pointer semantics
type User struct {
    ID        int64
    Name      string
    Email     string
    Addresses []Address
    History   []Event
    // ... many more fields
}

func (u *User) UpdateEmail(email string) {
    u.Email = email
}
\`\`\`

Rule of thumb: Use pointers for structs larger than 64-128 bytes, or when mutation is needed. Also keep receivers consistent across a type's method set. Mixing \`(c Counter)\` and \`(c *Counter)\` receivers is a classic code-review flag because it silently disqualifies the value type from satisfying interfaces that require pointer methods.

**Follow-ups**:
- How does escape analysis decide between stack and heap, and how do you read \`go build -gcflags=-m\` output?
- Why does \`sync.Mutex\` require a pointer receiver on methods that lock it?

### Q3: How would you implement a thread-safe counter in Go?

**What FAANG expects**: you know both the mutex and atomic forms, can pick between them with numbers, and are aware of the newer \`sync/atomic\` typed wrappers (\`atomic.Int64\`, etc.) added in Go 1.19 that reduce misuse.

\`\`\`go
// Using mutex
type Counter struct {
    mu    sync.Mutex
    count int64
}

func (c *Counter) Increment() {
    c.mu.Lock()
    c.count++
    c.mu.Unlock()
}

func (c *Counter) Value() int64 {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.count
}

// Using atomic (preferred for simple counters)
type AtomicCounter struct {
    count int64
}

func (c *AtomicCounter) Increment() {
    atomic.AddInt64(&c.count, 1)
}

func (c *AtomicCounter) Value() int64 {
    return atomic.LoadInt64(&c.count)
}

// Benchmark: atomic is roughly 3x faster than mutex for the uncontended
// increment path. Under high contention the gap narrows and can reverse
// because atomics on the same cache line cause cross-CPU invalidations.

// Go 1.19+ preferred form (typed, misuse-resistant):
type TypedCounter struct {
    count atomic.Int64
}
func (c *TypedCounter) Increment() { c.count.Add(1) }
func (c *TypedCounter) Value() int64 { return c.count.Load() }
\`\`\`

**Follow-ups**:
- When would a \`sync.RWMutex\` beat both a \`sync.Mutex\` and an atomic?
- What is false sharing, and how do padding patterns like \`_ [56]byte\` mitigate it for hot counters?

### Q4: Explain struct embedding and when to use it.

**What FAANG expects**: you can contrast embedding with inheritance accurately (no virtual dispatch, no upcasting), walk through method promotion and ambiguity rules, and cite a real pattern (middleware chaining, derived loggers).

Embedding promotes fields and methods from the embedded type:

\`\`\`go
type Logger struct{}
func (l Logger) Log(msg string) { fmt.Println(msg) }

type Server struct {
    Logger  // Embedded - Server gets Log() method
    addr string
}

s := Server{addr: ":8080"}
s.Log("Starting server")  // Works! Promoted from Logger

// When to use:
// 1. Composition ("has-a" relationship)
// 2. Adding behavior to existing types
// 3. Satisfying interfaces through embedded types

// When NOT to use:
// 1. When you need "is-a" relationship (Go doesn't have inheritance)
// 2. When embedding would expose unwanted methods
// 3. When relationship is coincidental, not meaningful
\`\`\`

**Follow-ups**:
- What happens if two embedded types both define a method with the same name?
- How would you "override" a promoted method in the outer type?

### Q5: What happens when you append to a slice beyond its capacity?

**What FAANG expects**: correct growth formula, awareness that the pointer changes, and the full three-index slice expression \`s[low:high:max]\` for preventing accidental backing-array aliasing. Getting the growth factor wrong (saying "always 2x") is a common junior miss.

\`\`\`go
s := make([]int, 3, 5)  // len=3, cap=5
fmt.Printf("ptr=%p\\n", &s[0])

// Append within capacity - no allocation
s = append(s, 4, 5)  // len=5, cap=5
fmt.Printf("ptr=%p\\n", &s[0])  // Same pointer

// Append beyond capacity - new array allocated
s = append(s, 6)  // len=6, cap=10 (doubled)
fmt.Printf("ptr=%p\\n", &s[0])  // Different pointer!
\`\`\`

Growth strategy (Go 1.18+):
- For small slices (cap under roughly 256): new capacity is approximately 2x the old capacity.
- For larger slices: the growth factor gradually transitions from 2x toward 1.25x, so multi-GB slices do not double aggressively.
- The exact thresholds live in \`runtime.growslice\` and have shifted slightly across Go versions, so do not memorize exact numbers for interviews. Name the shape: "doubles when small, tapers toward 1.25x when large."

This can cause subtle bugs if you hold references to the old backing array:

\`\`\`go
original := []int{1, 2, 3}
slice := original[:2]
slice = append(slice, 99)  // Might modify original[2]!

// Fix: use full slice expression to cap the new slice's capacity
slice := original[:2:2]  // cap limited to 2
slice = append(slice, 99)  // Forces new allocation, original untouched
\`\`\`

**Follow-ups**:
- Given \`a := []int{1,2,3,4,5}; b := a[1:3]\`, what do \`len(b)\` and \`cap(b)\` equal?
- Why does \`slices.Clone\` exist in the standard library, and when should you reach for it over \`append([]T{}, src...)\`?

### Q6: Why does Go randomise map iteration order, and how do you get deterministic iteration when you need it?

**What FAANG expects**: the reason (preventing callers from depending on order), the mechanism (random starting bucket), and the idiomatic fix (sort the keys).

**Answer**: Go deliberately starts each map iteration at a random bucket so that code cannot develop an implicit dependency on iteration order. The randomisation is per iteration, not per map, so two \`range\` loops over the same map produce different orders. The fix when you need determinism is to collect the keys into a slice, sort the slice, and iterate in that order:

\`\`\`go
keys := slices.Sorted(maps.Keys(m)) // Go 1.23+
for _, k := range keys {
    use(k, m[k])
}
\`\`\`

The underlying reason is a lesson the Go team learned from other languages where implementation-defined iteration order was "stable in practice" for long enough that callers came to depend on it, and then broke when the map implementation changed. By randomising explicitly, Go makes the dependency impossible.

**Follow-ups**:
- What would happen if you wrote a test that asserted on map-iteration output without sorting?
- Does the randomisation have a performance cost?

### Q7: When should you promote a primitive to a named type?

**What FAANG expects**: a clear heuristic, not "always" or "never". The bar is that you can defend the rule in code review.

**Answer**: Promote when the primitive carries domain meaning. \`UserID\`, \`OrderID\`, \`Email\`, \`Currency\` are named types because their domain semantics distinguish them from raw \`int64\` or \`string\`. Loop indices, array sizes, counts, and generic helper parameters stay as raw types because they have no domain semantics.

The test question: "could this value be confused with a different value of the same underlying type in a way that would produce a wrong result?". If yes, name it. If no, keep it primitive. A \`UserID\` confused with an \`OrderID\` produces wrong refunds. A loop index confused with a slice length produces off-by-one bugs that unit tests catch quickly.

**Follow-ups**:
- What is the cost of naming a type? (conversions at boundaries, method attachment)
- Would you name \`Timestamp\` or just use \`time.Time\`?

### Q8: Walk me through the layout of a struct with three fields of different sizes.

**What FAANG expects**: an accurate picture of alignment, padding, and how reordering affects total size. This is the memory-layout question that distinguishes mid-level from senior Go engineers.

**Answer**: Go structs follow alignment rules. Each field must start at a multiple of its alignment (the alignment is usually equal to the type's size for primitives). The struct's total size is rounded up to a multiple of its largest field's alignment. This is why \`struct { bool; int64; bool }\` is 24 bytes (1 + 7 padding + 8 + 1 + 7 padding), while \`struct { int64; bool; bool }\` is 16 bytes (8 + 1 + 1 + 6 padding).

The discipline is to order fields from largest to smallest alignment. Tools like \`fieldalignment\` automate this. The payoff is reduced memory pressure, better cache-line utilisation, and measurable RSS savings on services that allocate the struct heavily.

**Follow-ups**:
- What is \`unsafe.Alignof\` and when would you use it?
- How do you align a struct to a cache-line boundary to avoid false sharing?

### Q9 (Senior track): Design the type system for a multi-currency payment service.

**What FAANG expects**: a complete answer covering named types, validation, serialisation, and rounding rules. This is a design round question that tests both Go knowledge and domain modelling.

**Answer**: Three core types. First, \`Currency\`, an enum-shaped named type that wraps a string ISO code (\`USD\`, \`EUR\`, \`JPY\`) with a constructor that validates against a known list. Second, \`Amount\`, a named type over \`int64\` that represents the smallest unit of a currency (cents for USD, yen for JPY). Third, \`Money\`, a struct that pairs an \`Amount\` with a \`Currency\` and has arithmetic operations that reject currency mismatches at runtime (or, if you want compile-time safety, a generic \`Money[C Currency]\` type where \`C\` is a phantom type parameter).

The discipline of the type system is that monetary arithmetic outside the \`Money\` type is forbidden. You cannot add two \`int64\` dollar amounts directly. You have to wrap in \`Money\` first, which forces the currency check. This is the primary safety guarantee the type system buys you.

The serialisation discipline is that \`Money\` serialises as \`{"amount": 1999, "currency": "USD"}\` and not as \`"19.99"\` or \`19.99\`. The float representation is lossy and the currency is implicit; both are bugs in real payment systems.

The rounding discipline is that \`Money.Divide(n)\` must return an \`Amount\` plus a remainder, not two \`Amount\`s. You cannot divide \$1.00 into three equal parts without losing a cent. The type system forces the caller to decide where the cent goes.

**Follow-ups**:
- How do you handle currency conversion with live exchange rates?
- How do you serialise a JPY amount that has no fractional subunit?
- What does the type system look like if you need to support crypto currencies with more than two decimal places of precision?

### Q10 (Senior track): How do you reason about Go's memory layout to reduce allocations in a hot path?

**What FAANG expects**: a systematic answer with pprof, escape analysis, and type-design levers. This is the performance-investigation question for staff-plus candidates.

**Answer**: Start with pprof's allocation profile to identify the hot symbols. The common culprits are \`runtime.growslice\` (slices growing), \`runtime.mapassign\` (map operations), \`runtime.mallocgc\` (general allocation), and \`runtime.convT\` (interface conversion causing boxing).

For each, the type-level fix is different. For \`growslice\`, preallocate with a size hint. For \`mapassign\`, preallocate with a size hint or consider whether a struct would replace the map. For \`mallocgc\` on specific types, inspect whether the type escapes to the heap (\`go build -gcflags=-m\`) and restructure to keep it on the stack. For \`convT\`, look for unnecessary conversions to \`any\` and replace with direct typed calls where possible.

The type-design levers available to you include: using a value receiver instead of a pointer receiver when the type is small (to keep it on the stack), packing structs tightly for cache locality, replacing a slice of pointers with a slice of values when mutation is not needed, using \`sync.Pool\` for short-lived allocations that can be recycled, and replacing \`interface{}\` with a concrete type or a generic type parameter.

The discipline is to measure before and after each change. Intuition about Go performance is wrong often enough that profile-driven optimisation is the only reliable approach.

**Follow-ups**:
- How does \`sync.Pool\` interact with the garbage collector?
- When does escape analysis fail to keep a value on the stack?
- What does "zero-allocation code" mean in Go and when is it worth pursuing?

---
`;
