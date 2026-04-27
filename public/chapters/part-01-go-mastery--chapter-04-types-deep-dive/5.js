export default `## 4.4 Slices

Slices are Go's workhorse data structure for sequences. They're variable-length views into arrays.

### Slice Internals

A slice is a three-word data structure:

\`\`\`go
// Internal representation (runtime/slice.go)
type slice struct {
    array unsafe.Pointer  // Pointer to underlying array
    len   int             // Number of elements
    cap   int             // Capacity (elements from array to end)
}
\`\`\`

When you slice an array, the resulting slice header points into the array's memory. Changes through the slice modify the original array, and the capacity tracks how far the slice can grow before a new allocation is needed:

\`\`\`go
arr := [5]int{1, 2, 3, 4, 5}
s := arr[1:4]  // Slice pointing to arr

// s.array points to arr[1]
// s.len = 3 (elements 2, 3, 4)
// s.cap = 4 (can grow to include 5)

fmt.Printf("len=%d cap=%d %v\\n", len(s), cap(s), s)
// len=3 cap=4 [2 3 4]
\`\`\`

### Creating Slices

Slices can be created with a literal, with \`make\` to specify length and capacity, or by slicing an existing array or slice. Pre-allocating with \`make\` prevents repeated reallocations during \`append\`.

\`\`\`go
// From array
arr := [5]int{1, 2, 3, 4, 5}
s := arr[1:4]  // [2, 3, 4]

// Literal
s := []int{1, 2, 3}

// make (length, capacity)
s := make([]int, 5)      // len=5, cap=5, [0,0,0,0,0]
s := make([]int, 0, 10)  // len=0, cap=10, []

// nil slice
var s []int  // nil, len=0, cap=0

// nil vs empty slice
var nilSlice []int          // nil
emptySlice := []int{}       // Not nil, but empty
emptyMake := make([]int, 0) // Not nil, but empty

// Behavior differs for JSON encoding:
json.Marshal(nilSlice)     // "null"
json.Marshal(emptySlice)   // "[]"
\`\`\`

### Slice Expressions

Slice expressions extract a sub-slice by specifying low and high bounds. The optional third index also sets the capacity, preventing the sub-slice from sharing the original's backing array beyond the specified range.

\`\`\`go
s := []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}

s[2:5]   // [2, 3, 4] - index 2 to 4 (5 excluded)
s[:5]    // [0, 1, 2, 3, 4] - first 5
s[5:]    // [5, 6, 7, 8, 9] - from index 5
s[:]     // [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] - copy of slice header
\`\`\`

### Full Slice Expression

The three-index slice expression \`s[low:high:max]\` sets both the length (\`high, low\`) and the capacity (\`max, low\`) of the resulting slice. By limiting capacity to match length, you force the next \`append\` to allocate a new backing array instead of overwriting elements in the original. This prevents a common class of aliasing bugs.

\`\`\`go
s := []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}

s2 := s[2:5]    // len=3, cap=8 (can grow into original)
s3 := s[2:5:5]  // len=3, cap=3 (limited capacity)

// s3 cannot accidentally overwrite s[5:]
s3 = append(s3, 99)  // Allocates new array!
fmt.Println(s)       // Original unchanged
\`\`\`

### Append

\`append\` adds elements, possibly allocating a new array:

\`\`\`go
s := []int{1, 2, 3}
s = append(s, 4)         // [1, 2, 3, 4]
s = append(s, 5, 6, 7)   // [1, 2, 3, 4, 5, 6, 7]

// Append slice
other := []int{8, 9}
s = append(s, other...)  // [1, 2, 3, 4, 5, 6, 7, 8, 9]
\`\`\`

**Critical**: Always use the return value of append:

\`\`\`go
// Wrong - might not update s
append(s, 4)

// Correct
s = append(s, 4)
\`\`\`

### Growth Strategy

When capacity is exceeded, Go allocates a new array:

\`\`\`go
s := []int{}
for i := 0; i < 17; i++ {
    s = append(s, i)
    fmt.Printf("len=%2d cap=%2d\\n", len(s), cap(s))
}
// len= 1 cap= 1
// len= 2 cap= 2
// len= 3 cap= 4
// len= 4 cap= 4
// len= 5 cap= 8
// len= 6 cap= 8
// len= 7 cap= 8
// len= 8 cap= 8
// len= 9 cap=16
// ...
\`\`\`

Growth formula (simplified, Go 1.18+):
- For small slices (cap < ~512): approximately doubles
- For larger slices: gradually transitions from 2x to ~1.25x growth
- The transition is smooth, not a sharp cutoff at any single threshold

### Preallocating for Performance

If you know the final size, preallocate:

\`\`\`go
// Slow: multiple reallocations
func slow(n int) []int {
    var s []int
    for i := 0; i < n; i++ {
        s = append(s, i)
    }
    return s
}

// Fast: single allocation
func fast(n int) []int {
    s := make([]int, 0, n)
    for i := 0; i < n; i++ {
        s = append(s, i)
    }
    return s
}

// Fastest: direct assignment
func fastest(n int) []int {
    s := make([]int, n)
    for i := 0; i < n; i++ {
        s[i] = i
    }
    return s
}

// Benchmark results (n=10000):
// BenchmarkSlow-8      2000   750000 ns/op   386000 B/op  20 allocs/op
// BenchmarkFast-8     50000    30000 ns/op    81920 B/op   1 allocs/op
// BenchmarkFastest-8  50000    25000 ns/op    81920 B/op   1 allocs/op
\`\`\`

### Copy

The built-in \`copy\` function copies elements from a source slice into a destination slice. It copies \`min(len(dst), len(src))\` elements and returns the number copied. Unlike assignment, \`copy\` creates independent data, modifying the destination does not affect the source.

\`\`\`go
src := []int{1, 2, 3}
dst := make([]int, len(src))
n := copy(dst, src)  // n = 3, dst = [1, 2, 3]

// Copy copies min(len(dst), len(src)) elements
dst := make([]int, 2)
copy(dst, src)  // dst = [1, 2]

// Copy also works on strings
src := []byte("hello")
dst := make([]byte, 3)
copy(dst, src)  // dst = "hel"
\`\`\`

### Common Slice Operations

The \`slices\` package (Go 1.21+) provides type-safe generic functions for common slice operations: sorting, searching, filtering, and deduplication. These replace hand-written loop patterns with well-tested alternatives.

\`\`\`go
s := []int{1, 2, 3, 4, 5}

// Delete element at index i (preserves order)
i := 2
s = append(s[:i], s[i+1:]...)  // [1, 2, 4, 5]

// Delete element at index i (doesn't preserve order - faster)
i := 2
s[i] = s[len(s)-1]
s = s[:len(s)-1]  // [1, 2, 5, 4]

// Insert element at index i
i := 2
val := 99
s = append(s[:i], append([]int{val}, s[i:]...)...)  // [1, 2, 99, 3, 4, 5]

// Or more efficiently (Go 1.21+)
s = slices.Insert(s, i, val)

// Reverse in place
for i, j := 0, len(s)-1; i < j; i, j = i+1, j-1 {
    s[i], s[j] = s[j], s[i]
}

// Remove duplicates from sorted slice
s = slices.Compact(s)
\`\`\`

### Memory Leaks with Slices

A sub-slice shares the backing array of the original. If you return a small sub-slice from a function, the garbage collector cannot reclaim the original large array because the sub-slice still references it. The fix is to copy the needed elements into a fresh slice, releasing the reference to the original.

\`\`\`go
// Leaky: keeps entire backing array alive
func getFirst100(data []byte) []byte {
    return data[:100]  // Keeps entire data array alive!
}

// Fixed: copy to new slice
func getFirst100(data []byte) []byte {
    result := make([]byte, 100)
    copy(result, data[:100])
    return result
}

// Also leaky: slices of pointers
type BigStruct struct {
    data [1000000]byte
}

var cache []*BigStruct

func process(items []*BigStruct) {
    // Keeping just one item keeps the entire slice's backing array
    cache = items[:1]  // LEAK: keeps all items' memory alive

    // Fixed:
    cache = make([]*BigStruct, 1)
    cache[0] = items[0]
}
\`\`\`

### How Uber Handles High-Performance Slices

Uber's Ring Buffer implementation for high-throughput logging:

\`\`\`go
// Uber's pattern for lock-free ring buffer
type RingBuffer struct {
    data     []any
    size     uint64
    mask     uint64
    writePos uint64
    readPos  uint64
}

func NewRingBuffer(size int) *RingBuffer {
    // Size must be power of 2 for fast modulo
    if size&(size-1) != 0 {
        panic("size must be power of 2")
    }
    return &RingBuffer{
        data: make([]any, size),
        size: uint64(size),
        mask: uint64(size - 1),
    }
}

func (r *RingBuffer) Write(item any) bool {
    pos := atomic.AddUint64(&r.writePos, 1) - 1
    idx := pos & r.mask  // Fast modulo for power of 2
    r.data[idx] = item
    return true
}
\`\`\`

### slices Package (Go 1.21+)

Go 1.21 added a \`slices\` package with common operations:

\`\`\`go
import "slices"

s := []int{3, 1, 4, 1, 5, 9}

slices.Sort(s)                    // [1, 1, 3, 4, 5, 9]
slices.Contains(s, 4)             // true
slices.Index(s, 4)                // 3
slices.Equal(s, other)            // comparison
slices.Clone(s)                   // copy
slices.Reverse(s)                 // in-place reverse
slices.Compact(s)                 // remove consecutive duplicates
slices.Min(s)                     // 1
slices.Max(s)                     // 9
slices.BinarySearch(s, 4)         // index, found

// With custom comparison
slices.SortFunc(s, func(a, b int) int {
    return b - a  // Descending order
})

// Insert and Delete
s = slices.Insert(s, 2, 99)       // Insert 99 at index 2
s = slices.Delete(s, 2, 3)        // Delete elements [2:3)
\`\`\`

### sort.Slice vs slices.Sort (Go 1.21+)

Go 1.21 introduced the \`slices\` package which provides generic, type-safe sorting. Prefer it over the older \`sort\` package.

**Why slices.Sort is better:**

- **Type-safe** - no \`interface{}\` boxing/unboxing, compiler catches type errors
- **Faster** - ~15-30% faster due to no interface dispatch overhead
- **Cleaner API** - no need to define \`Less\` function with index parameters

\`\`\`go
// OLD: sort.Slice (pre-Go 1.21)
import "sort"

users := []User{{Name: "Charlie", Age: 30}, {Name: "Alice", Age: 25}}
sort.Slice(users, func(i, j int) bool {
    return users[i].Age < users[j].Age  // accesses slice by index
})

// NEW: slices.SortFunc (Go 1.21+)
import "slices"

slices.SortFunc(users, func(a, b User) int {
    return cmp.Compare(a.Age, b.Age)  // direct value access, type-safe
})

// For basic types - even simpler
nums := []int{3, 1, 4, 1, 5}
slices.Sort(nums)  // no comparator needed for ordered types
\`\`\`

**Migration guide:**

| Old (sort) | New (slices) | Notes |
|-----------|-------------|-------|
| \`sort.Slice(s, less)\` | \`slices.SortFunc(s, cmp)\` | \`cmp\` takes values, not indices |
| \`sort.SliceStable(s, less)\` | \`slices.SortStableFunc(s, cmp)\` | Preserves equal element order |
| \`sort.Ints(s)\` | \`slices.Sort(s)\` | Generic, works for any ordered type |
| \`sort.Search(n, f)\` | \`slices.BinarySearch(s, v)\` | Returns \`(index, found)\` |
| \`sort.Float64s(s)\` | \`slices.Sort(s)\` | Same function for all numeric types |

**When to still use the sort package:**

- When implementing \`sort.Interface\` for complex custom types
- When you need \`sort.Reverse\` wrapper behavior
- Legacy code that has not migrated yet

### Slice Aliasing: The Senior-Track Discipline

Slice aliasing is the source of more "why did this happen?" production bugs in Go than any other language feature. The underlying model in one sentence: a slice is a three-word header \`(pointer, length, capacity)\` that points into a backing array, and multiple slices can point into the same array. The rules you must internalise:

1. **\`s[a:b]\` shares storage with \`s\`.** Writes through either are visible through the other.
2. **\`append(s, x)\` may or may not share storage with \`s\`.** It shares when the result fits in capacity. It does not when the result requires allocation.
3. **The answer to (2) depends on the state of \`s\` at the call site**, which is often invisible at the appending function's boundary.

The defensive patterns:

\`\`\`go
// 1. Clone to break aliasing explicitly
func Safe(s []int) []int {
    return slices.Clone(s) // Go 1.21+
}

// 2. Three-index slice to bound capacity
sub := s[a:b:b] // capacity == length, so next append allocates

// 3. Copy when returning a subset from a larger buffer
result := make([]byte, n)
copy(result, buf[:n])
return result
\`\`\`

The senior-track rule is: document, per-function, whether a returned slice is independent of internal state or shares it. The language does not enforce the contract, so the team has to. Tools like \`staticcheck\`'s \`SA4010\` (result of append not used) catch a narrow class of errors. The broader discipline is per-PR code review attention.

### Slice of Values vs Slice of Pointers

A \`[]T\` packs the elements contiguously in memory. A \`[]*T\` stores pointers contiguously, with each element living separately on the heap. The choice matters:

1. **Cache locality.** \`[]T\` is faster to iterate over when \`T\` is small, because each element is next to the previous one in memory and the CPU prefetcher can stream through efficiently. \`[]*T\` requires a pointer indirection per element.
2. **Allocation cost.** \`[]T\` is one allocation (plus growth). \`[]*T\` is one allocation for the header and N allocations for the elements, unless they are pooled.
3. **Mutation semantics.** Iterating \`for _, v := range []T { v.Field = 1 }\` modifies a copy of \`v\`, not the slice element. Iterating \`for _, v := range []*T { v.Field = 1 }\` modifies the pointed-to value through the pointer. The first is a common bug for engineers arriving from Java.
4. **Size.** \`[]T\` with \`T\` being a large struct is wasteful if many slice operations copy the elements. \`[]*T\` lets you move pointers instead of values.

The default is \`[]T\` for small value-semantic types (\`Point\`, \`Currency\`, \`Timestamp\`) and \`[]*T\` for large or mutable types. Benchmark when the choice is ambiguous.

### \`runtime.growslice\` in the Profile

When a pprof flame graph is dominated by \`runtime.growslice\`, the service is reallocating slices in hot paths. The fixes, in order of preference:

1. Preallocate with \`make([]T, 0, knownSize)\` when the final size is known.
2. Preallocate with an estimate and let \`append\` grow from there. A 50% over-estimate usually beats a 50% under-estimate.
3. Reuse slices from a \`sync.Pool\` if the slice is a scratch buffer that is discarded after each use.
4. Redesign the data flow to avoid the slice entirely, for example by processing in-place or by streaming.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in slice-heavy PRs:

1. **A function that takes a slice and appends to it.** Document whether the function mutates. The safest contract is to return the new slice and require the caller to assign the result.
2. **A returned slice whose independence is not documented.** "Does \`cache.Get\` return a slice I can write to?" should have a documented answer, not a guess based on the implementation.
3. **\`append\` results assigned to a new variable while the original is still used.** \`s2 := append(s, x)\` then using both \`s\` and \`s2\` is a recipe for "one of them gets updated when I expected the other" bugs. If you need independence, clone explicitly.

### Migration Lens

Coming from Python, Go slices are close to Python lists but with aliasing exposed rather than copy-on-write. Python's \`list[a:b]\` returns an independent copy. Go's \`s[a:b]\` returns a view. The Python engineer's reflex to "take a slice and modify it" will silently mutate the original in Go. Coming from Java, \`ArrayList\` is the closest analogue but it never shares storage. The shared-storage model in Go is the price of avoiding the wrapper-object overhead that Java's \`ArrayList\` carries. Coming from Rust, Go slices are like \`&mut [T]\` without the borrow checker. You get the performance without the compile-time guarantees, and the defensive patterns above are how you compensate.

---
`;
