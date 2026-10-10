## 19.7 Escape Analysis

### Viewing Escape Analysis

The `-gcflags="-m"` flag instructs the Go compiler to print its escape analysis decisions, showing for each allocation whether the value stays on the stack or must be promoted to the heap. Running the more verbose `-m -m` form reveals the full reasoning chain behind each decision, which is essential when trying to eliminate unexpected heap allocations in hot paths.

```bash
go build -gcflags="-m" main.go
go build -gcflags="-m -m" main.go  # More verbose
```

### Preventing Escapes

When a function returns a pointer to a locally declared variable, the compiler must allocate that variable on the heap because the stack frame will be reclaimed after the function returns. A common technique to keep allocations on the stack is to have the caller own the memory and pass it in as a slice or pointer argument, the function then writes into caller-owned storage that the compiler can prove does not outlive the current frame.

```go
// Escapes: returned pointer
func newInt() *int {
    x := 42
    return &x  // Escapes to heap
}

// Doesn't escape: caller provides the buffer, callee only writes into it
func fillBuffer(buf []byte) int {
    n := copy(buf, "hello")
    return n  // compiler reports: "buf does not escape"
}
```

The second form is the workhorse pattern, and it is why so much of the standard library is shaped like `func (r *Reader) Read(p []byte) (n int, err error)` rather than `func Read() []byte`. Returning a fresh slice forces an allocation the callee cannot avoid. Writing into a caller-supplied buffer lets the caller decide, and the caller is often in a position to reuse one buffer across many calls.

### Common Escape Triggers

1. **Returning a pointer.** The value must live past the function.
2. **Storing a value in an interface that itself escapes.** Boxing a concrete value into an `any` or an interface parameter that outlives the frame generally allocates. The qualifier matters, see below.
3. **Large values.** Beyond a size threshold the compiler refuses to use stack space.
4. **Slice capacity unknown at compile time.** `make([]int, n)` where `n` is a variable.
5. **Closures capturing pointers.** The closure may outlive the stack frame.

Understanding these triggers lets you redesign hot paths to keep values on the stack. A common pattern: accept a buffer parameter instead of returning a new slice, so the caller controls allocation.

### Interface Boxing Does Not Always Allocate

It is widely repeated that putting a value in an interface allocates. That is a useful default instinct and it is not a rule, and the exceptions matter enough on a hot path to be worth knowing. Measured with `-gcflags=-m` and `-benchmem` on the machine used for this book (linux/amd64, Go 1.27.1):

**If the interface does not escape, nothing is allocated.** Escape analysis runs on the interface value like anything else:

```go
var x any = 42
return x.(int)   // compiler reports: "42 does not escape"
```

**Pointers in interfaces do not allocate.** An interface is two words, one of which is a data pointer. Storing a pointer means that word simply *is* the pointer, so there is nothing to box. Storing a `*T` costs 0 allocs/op.

**Small integers do not allocate.** The runtime keeps a static array of the values 0 through 255 (`runtime.staticuint64s`) and points the interface at the right element instead of calling into the allocator. Boxing values below 256 measures 0 allocs/op. Boxing 1000 measures 8 B/op and 1 allocs/op. Same code, same types, different value.

The reliable takeaway is not a table of special cases to memorize, since these are compiler and runtime implementation details that change between releases. It is the method: when you want to know whether something allocates, ask the toolchain rather than a rule of thumb. `-gcflags=-m` tells you what the compiler decided, and `b.ReportAllocs()` tells you what actually happened at runtime. When those two disagree, the benchmark wins, and the small-integer case above is exactly such a disagreement: the compiler says "escapes to heap", the allocator is never called.

### The Size Thresholds

"Larger than a certain threshold" is two different thresholds in the current gc compiler, both defined in `cmd/compile/internal/ir/cfg.go`:

| Constant | Value | Applies to |
|---|---|---|
| `MaxStackVarSize` | 128KB | Explicitly declared local variables (`var buf [N]byte`) |
| `MaxImplicitStackVarSize` | 64KB | Implicit allocations (`make`, `new`, composite literals) |

So a `var a [100*1024]byte` stays on the stack, while `var a [200*1024]byte` reports `moved to heap`. A `make([]byte, 32*1024)` with a constant size stays on the stack, while `make([]byte, 100*1024)` escapes. Treat these as current implementation values worth knowing when a hot-path buffer sits near the boundary, not as language guarantees.

### Staff Lens: Escape Analysis in Hot Paths

For hot-path code, run `go build -gcflags='-m'` and read the output. Every line that escapes is a potential heap allocation. For the functions on the critical path, redesign until they escape less. This is not premature optimization when the function is measurably on the critical path.

---
