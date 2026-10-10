## 19.6 Common Optimizations

### Reduce Allocations

Every heap allocation in Go incurs GC pressure, so reducing unnecessary allocations is often the single most effective optimization you can make. The most common culprit is growing a slice without a known capacity, which forces repeated reallocations as the backing array is copied. Pre-allocating with `make` when the final length is known eliminates these intermediate copies entirely.

```go
// Bad: reallocates and copies repeatedly as the slice grows
func processItems(items []Item) []Result {
    var results []Result
    for _, item := range items {
        results = append(results, process(item))
    }
    return results
}

// Good: preallocate
func processItems(items []Item) []Result {
    results := make([]Result, 0, len(items))
    for _, item := range items {
        results = append(results, process(item))
    }
    return results
}
```

### Use sync.Pool

When your code repeatedly allocates and discards short-lived objects of the same type, such as byte buffers or scratch structs, `sync.Pool` lets you recycle those objects across goroutines instead of returning them to the GC. The pool maintains a per-P free list, so `Get` is typically a cheap local operation with no locking contention. Always reset the object's state before returning it to the pool to prevent stale data from leaking between callers.

```go
var bufPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

func process(data []byte) []byte {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufPool.Put(buf)
    }()

    buf.Write(data)

    // Must copy: the caller cannot own memory the pool is about to reuse.
    return slices.Clone(buf.Bytes())
}
```

### The Pool Rule: Never Return Memory You Just Gave Back

That `slices.Clone` is the whole ballgame, and getting it wrong produces one of the nastiest bugs in Go. The tempting version ends with `return buf.Bytes()`, which looks harmless and passes every casual test.

It is a data leak between callers. `buf.Bytes()` does not copy anything. It returns a slice pointing straight into the buffer's internal array. The deferred `Put` then hands that same array to the pool, which hands it to the next goroutine that calls `Get`, which writes its own data over it. The caller is still holding a slice pointing at that memory. Their value changes underneath them, with no error and no panic.

Run the broken version with two callers and this is what it does:

```
first result right after call: "AAAA-secret-alice"
second result:                 "BBBB-secret-bob"
first result NOW (corrupted):  "BBBB-secret-bobce"
```

Alice's data became Bob's data, with the tail of `alice` still visible where Bob's shorter string did not cover it. In a request handler, that is one user receiving another user's response body. It is a security incident, not just a correctness bug, and it will not reproduce under light load because the corruption only appears once something else actually reuses the buffer. It reproduces in production, at peak traffic, and reads like a haunting.

The race detector will not save you here. Sequential reuse of a pooled buffer involves no concurrent access, so there is no race to detect. Nothing is technically racing. The ownership is simply wrong.

The rule is mechanical: **anything you return to a caller after putting an object back in the pool must be a copy.** If you cannot copy it, do not `Put` the object until the caller is finished with it. This makes `sync.Pool` a poor fit for objects whose contents outlive the function that borrowed them.

One more caution before you reach for a pool at all: `sync.Pool` is not a general-purpose cache and not a free win. The GC clears pools, entries do not survive collection, and `Get`/`Put` are not free. Pooling small, cheap objects frequently makes code slower as well as more dangerous. Reach for it when a profile shows a specific large or expensive object dominating your allocation profile, and measure that the pool actually helped.

### Avoid String Concatenation in Loops

Because Go strings are immutable, the `+=` operator must allocate a brand-new string and copy all existing bytes on every iteration, producing O(n²) total copying as the string grows. `strings.Builder` solves this by maintaining an internal byte slice that grows amortized, reducing the number of allocations to O(log n).

The final `String()` call adds none of its own. This is the specific reason `strings.Builder` exists rather than just using `bytes.Buffer`: `Builder.String()` is implemented with `unsafe.String` over the bytes it has already accumulated, handing back the existing array as a string with no copy and no allocation. `Builder` can do this safely because it forbids copying itself, so it knows nothing else holds a reference to that array.

Measured on the machine used for this book (linux/amd64, Go 1.27.1), building a 200-byte string from 100 pieces:

| Approach | allocs/op | B/op |
|---|---|---|
| `s += item` in a loop | 99 | 10736 |
| `strings.Builder` | 6 | 504 |

The 6 allocations are the buffer growing, not `String()`. The 99 are one doomed string per iteration, each one copying everything written before it.

```go
// Bad: O(n²) allocations
var s string
for _, item := range items {
    s += item.String()
}

// Good: O(n)
var b strings.Builder
for _, item := range items {
    b.WriteString(item.String())
}
s := b.String()
```

### Use Correct Data Structures

Choosing the right data structure for a lookup has a larger impact on performance than almost any micro-optimization. A map provides O(1) average-case lookup via hashing, while a linear scan through a slice is O(n), a difference that becomes critical at even modest sizes. However, maps carry a constant overhead from hashing and pointer chasing, so for very small collections (typically fewer than 8-16 elements) a slice scan may be faster in practice due to CPU cache locality.

```go
// Map vs slice lookup
// Map: O(1) average
m := make(map[string]bool)
if m[key] { }

// Slice: O(n)
for _, v := range slice {
    if v == target { }
}

// But for small n, slice might be faster due to cache efficiency
```

### The Optimization Priority Order

Not all optimizations are equal. In descending order of typical impact:

1. **Algorithm.** O(n²) to O(n log n) dominates everything else.
2. **Allocation reduction.** GC pressure is a major latency contributor.
3. **Data structure choice.** Map vs slice, pre-allocation, cache-friendly layout.
4. **Concurrency.** Parallel execution when work is independent.
5. **Micro-optimization.** Loop unrolling, inlining, assembly.

Most teams jump to 4 and 5 first. The wins are in 1, 2, 3. Apply them in order.

### Staff Lens: Optimization Without Measurement Is Guessing

Every optimization claim should be backed by measurement: before and after, on a realistic workload, with `benchstat` for statistical rigor. Optimizations that "should be faster" but were not measured are not optimizations, they are changes. Many are regressions.

---
