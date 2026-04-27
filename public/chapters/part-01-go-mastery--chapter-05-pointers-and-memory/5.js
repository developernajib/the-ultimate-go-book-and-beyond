export default `## 5.4 Escape Analysis

The compiler decides whether to allocate on the stack or heap through escape analysis.

### Viewing Escape Analysis

The Go compiler's escape analysis can be inspected with the \`-gcflags="-m"\` flag, which reveals exactly which variables escape to the heap and why, providing actionable insight for reducing GC pressure.

\`\`\`bash
go build -gcflags="-m" main.go
go build -gcflags="-m -m" main.go  # More verbose
\`\`\`

### Common Escape Scenarios

The compiler reports escapes for several distinct reasons. Each scenario below shows a pattern that forces a heap allocation, along with the compiler's reasoning.

**1. Returning a pointer to a local variable:**

\`\`\`go
func escape() *int {
    x := 42
    return &x  // x escapes: pointer outlives function
}
\`\`\`

**2. Storing in an interface:**

\`\`\`go
func escapeInterface() any {
    x := 42
    return x  // x escapes: stored in interface
}
\`\`\`

**3. Captured by closure:**

\`\`\`go
func escapeClosure() func() int {
    x := 42
    return func() int {
        return x  // x escapes: captured by closure
    }
}
\`\`\`

**4. Appending to slice:**

\`\`\`go
func escapeSlice() {
    s := []int{}
    for i := 0; i < 100; i++ {
        s = append(s, i)  // Backing array escapes
    }
}
\`\`\`

**5. Sending to channel:**

\`\`\`go
func escapeChannel(ch chan *int) {
    x := 42
    ch <- &x  // x escapes: sent to channel
}
\`\`\`

### Preventing Escapes

Most escapes can be avoided by changing function signatures or allocation patterns. The compiler is conservative: it will heap-allocate anything it cannot prove stays local, so small structural changes often eliminate escapes entirely.

**Use value types when possible:**

\`\`\`go
// Escapes
func bad() *Point {
    return &Point{X: 1, Y: 2}
}

// Doesn't escape (if caller doesn't escape it)
func good() Point {
    return Point{X: 1, Y: 2}
}
\`\`\`

**Preallocate slices:**

\`\`\`go
// Multiple allocations (slice grows)
func bad() []int {
    s := []int{}
    for i := 0; i < 1000; i++ {
        s = append(s, i)
    }
    return s
}

// Single allocation
func good() []int {
    s := make([]int, 1000)
    for i := 0; i < 1000; i++ {
        s[i] = i
    }
    return s
}
\`\`\`

**Pass pointers instead of returning them:**

\`\`\`go
// Allocates on heap
func getData() *Data {
    return &Data{...}
}

// Caller controls allocation
func getData(d *Data) {
    *d = Data{...}  // Can be stack if caller is stack
}
\`\`\`

### Uber's Escape Analysis Patterns

Uber's performance team uses these patterns to minimize allocations:

\`\`\`go
// Pattern 1: Reuse buffers
type Encoder struct {
    buf bytes.Buffer  // Embedded, not pointer
}

func (e *Encoder) Encode(v any) ([]byte, error) {
    e.buf.Reset()  // Reuse instead of allocating
    // ... encode into e.buf
    return e.buf.Bytes(), nil
}

// Pattern 2: Accept pointers for output
func ParseConfig(data []byte, cfg *Config) error {
    // Caller provides memory - no heap allocation
    return json.Unmarshal(data, cfg)
}

// Pattern 3: Avoid any in hot paths
// Bad: allocates for interface conversion
func Process(items []any) {
    for _, item := range items {
        // item escapes
    }
}

// Good: use concrete types or generics
func Process[T any](items []T) {
    for _, item := range items {
        // item doesn't escape
    }
}
\`\`\`

### Reading the \`-gcflags=-m -m\` Output

Junior engineers look at escape output and bounce off because the compiler emits a tree of reasons, not a single verdict. Here is the reading order that matters.

\`\`\`
./main.go:12:13: &User{...} escapes to heap:
./main.go:12:13:   flow: ~r0 = &{storage for &User{...}}:
./main.go:12:13:     from &User{...} (spill) at ./main.go:12:13
./main.go:12:13:     from return &User{...} (return) at ./main.go:12:2
\`\`\`

Read bottom-up. The innermost \`from ... (return)\` line is the *reason* (returning a pointer). The flow lines above it are the *path* the pointer takes through the function. The topmost \`escapes to heap\` line is the *verdict*. On a 2000-line analysis dump, \`grep "escapes to heap"\` finds every verdict, and for each you walk the flow backwards to find the primitive cause.

Common primitive causes, in descending order of frequency on real FAANG Go services:

1. \`(return)\`: returning a pointer or a value wider than a register
2. \`(interface-conversion)\`: boxing a concrete type into \`any\` or a named interface
3. \`(captured by func literal)\`: closures over loop variables and goroutine arguments
4. \`(sent to chan)\`: channels of pointers or large values
5. \`(assigned to ... .field)\`: stashing a local into a struct that outlives the function
6. \`(too large for stack)\`: typically > 64KB stack slots, or variable-size via \`make\`
7. \`(called via interface)\`: the method target itself escapes because the receiver flows through a dynamic call

### A Complete Catalog of Escape Triggers

The following are every escape trigger the 2026 compiler can report. Memorizing them turns escape reading from detective work into lookup.

| Trigger | Pattern | Fix Pattern |
|---------|---------|-------------|
| Return pointer to local | \`func() *T { x := T{}; return &x }\` | Return by value if the callee also doesn't escape |
| Interface boxing | \`var i any = x\` for \`x\` larger than a pointer | Use generics or narrow interfaces with pointer receivers |
| Closure capture | \`go func() { use(x) }()\` | Pass \`x\` as an argument to the closure |
| Channel send of pointer | \`ch <- &x\` | Send the value if copying is cheaper than GC cost |
| Field assignment to heap-object | \`parent.child = &child\` where parent is on heap | Embed \`child\` by value in parent |
| Method call via interface | \`var r io.Reader = &s; r.Read(...)\` | Call the concrete method when the type is known |
| Append to unknown-capacity slice | \`s = append(s, item)\` with unknown cap | \`make([]T, 0, hint)\` or prealloc to exact size |
| Slice of local passed to variadic | \`fmt.Println(x, y, z)\` | Use \`fmt.Fprintln(w, x, y, z)\` with a non-escaping writer |
| \`map[K]*V\` insert | \`m[k] = &v\` | \`map[K]V\` if the value is small |
| \`defer\` capture of large value | \`defer cleanup(bigStruct)\` | Move the work out of defer if the struct escapes only because of it |
| \`reflect.ValueOf(x)\` | Reflection of a stack-local value | Avoid reflection on hot paths |
| Conversion to \`uintptr\` | \`uintptr(unsafe.Pointer(&x))\` across a safe-point | Only use within a single instruction sequence |

### How Generics Interact With Escape Analysis

Generics (Go 1.18+) use GC shape stenciling. The compiler generates one instantiation per GC shape (roughly, one per distinct pointer layout). This has three consequences seniors need to remember:

1. **Generic functions inline less aggressively than monomorphized equivalents.** If a generic helper on a hot path is allocating a value you expect to stay on the stack, check \`-gcflags=-m=3\` for the instantiation. Sometimes adding \`//go:inline\` or restructuring into a concrete helper wins back the stack allocation.
2. **Type parameters of interface-type constraints still force boxing.** \`func F[T any](x T) { use(any(x)) }\` still heap-allocates \`x\` at the \`any(x)\` site, because the boxing is independent of the type parameter.
3. **Pointer-taking operations on type parameters are pessimistic.** The compiler cannot prove that a pointer to a type-parameter-typed local does not escape, because it does not know the final type. Return value, not pointer, from generic accessors when you can.

Example of the trap:

\`\`\`go
// Allocates. T is taken as *T somewhere down the call chain.
func First[T any](xs []T) *T {
    return &xs[0]
}

// Does not allocate. Callers copy the value.
func FirstValue[T any](xs []T) T {
    return xs[0]
}
\`\`\`

### Escape Patterns That Fooled Us in Production

**The \`error\` wrap escape.** \`fmt.Errorf("boom: %w", err)\` heap-allocates the resulting \`*fmt.wrapError\`. On a hot path that returns wrapped errors only in the exceptional case, that is fine. On a hot path that wraps on the success case (some retry/circuit-breaker code does this), each call allocates. The fix is to wrap only at decision boundaries, not at every layer.

**The \`time.Now()\` struct.** \`time.Now()\` returns a 24-byte \`time.Time\`. Assigning to a \`time.Time\` struct field does not escape. Passing \`time.Now()\` to a function that takes \`any\` (e.g., \`slog.Info("x", "t", time.Now())\`) does escape, because \`any\` boxes it. Prefer \`slog.Info("x", slog.Time("t", time.Now()))\`, which uses a typed attribute and avoids the box.

**The deferred closure escape.** A deferred closure that captures a local by pointer promotes that local to the heap. The fix is to capture by value or pass explicit arguments:

\`\`\`go
// Escapes cfg to the heap.
func run() {
    cfg := loadConfig()
    defer func() { saveConfig(&cfg) }()
    // ...
}

// Does not escape cfg.
func run() {
    cfg := loadConfig()
    defer saveConfig(&cfg)  // direct call, no closure
    // ...
}
\`\`\`

**The slice-of-interfaces spill.** \`[]any{userA, userB}\` heap-allocates the backing array *and* boxes each element. If you need to pass heterogeneous values to \`fmt.Sprintf\`, acknowledge the allocation on the slow path and keep it out of your hot loop.

**The hidden \`runtime.convTstring\` path.** Converting between \`string\` and \`[]byte\` allocates unless the compiler can prove no mutation (\`string(b)\` in a \`map\` lookup is zero-copy under an optimization added in 1.18; \`string(b)\` assigned to a local is not). Benchmark before and after, the optimization is fragile and rearranging code can silently lose it.

### What Green Tea GC (Go 1.26) Changes

It changes nothing about which variables escape. Escape analysis runs at compile time. The GC runs at runtime. Green Tea reduces the CPU cost of marking heap objects, so the penalty for any given escape is lower. But heap allocation is still a slow path, a CPU cache miss, a lock acquire in the allocator on contention, and a contribution to GC trigger. The advice "prevent unnecessary escapes" is unchanged.

What Green Tea *does* change is the relative cost of large numbers of tiny allocations versus fewer larger ones. Pre-1.26, a million 32-byte short-lived allocations dominated mark-phase CPU on allocation-heavy services. Post-1.26, the SIMD group-mark step processes those in parallel, so the marginal cost of the next small allocation is lower than it was. This weakens (but does not erase) the case for \`sync.Pool\` on medium-sized objects. Measure.

### Complete Escape Analysis Example

This example combines the escape patterns from above into a single file you can analyze with \`go build -gcflags="-m -m"\`. Each function demonstrates a different allocation outcome.

\`\`\`go
package main

import "fmt"

// Analyze with: go build -gcflags="-m -m" main.go

type User struct {
    ID   int
    Name string
}

// Case 1: No escape
func noEscape() User {
    u := User{ID: 1, Name: "Alice"}
    return u  // Copied to caller - no escape
}

// Case 2: Pointer escapes
func pointerEscapes() *User {
    u := User{ID: 1, Name: "Alice"}
    return &u  // u escapes to heap
}

// Case 3: Interface escapes
func interfaceEscapes() any {
    u := User{ID: 1, Name: "Alice"}
    return u  // u escapes (interface box)
}

// Case 4: Closure escapes
func closureEscapes() func() string {
    u := User{ID: 1, Name: "Alice"}
    return func() string {
        return u.Name  // u escapes (captured)
    }
}

// Case 5: Output parameter - caller controls
func noEscapeWithParam(u *User) {
    u.ID = 1
    u.Name = "Alice"
}

func main() {
    // Stack allocated
    u1 := noEscape()

    // Heap allocated
    u2 := pointerEscapes()

    // Heap allocated
    u3 := interfaceEscapes().(User)

    // Heap allocated (captured in closure)
    getName := closureEscapes()

    // Caller controls - can be stack
    var u4 User
    noEscapeWithParam(&u4)

    fmt.Println(u1, u2, u3, getName(), u4)
}
\`\`\`

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in escape-analysis-related PRs:

1. **Premature escape-analysis micro-optimisation.** Restructuring code to avoid an escape on a cold path is wasted effort and often hurts readability. The discipline is "profile first, then optimise". The exception is when the pattern is in a clearly-hot path identified by pprof.
2. **A change that adds an \`any\` parameter to a function called from a hot path.** The interface boxing is invisible to the caller but allocates per call. Either type the parameter concretely or use a generic.
3. **A return that switches from value to pointer "for clarity".** If the caller does not need pointer semantics (mutation, optional, large size), the change forces an escape that the value return avoided. Reverse the change.

### Migration Lens

Coming from Java, escape analysis exists in HotSpot but is opaque. You cannot ask the JVM "did this escape?" the way you can ask \`gc -m\`. Coming from C++, you make the stack-vs-heap decision yourself with \`T x\` vs \`T* x = new T()\`. Go's escape analysis is the compiler making the decision for you, with \`-gcflags=-m\` letting you see the result. Coming from Rust, the closest analogue is the borrow checker's lifetime inference, but Rust forces the decision into the type system at compile time. Go infers it and the result is whichever is cheaper.

---
`;
