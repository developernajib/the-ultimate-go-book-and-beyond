export default `## 2.6 Arrays, Slices, and Maps

### Arrays

Arrays in Go have a fixed size. You rarely use them directly because slices are almost always better:

\`\`\`go
var numbers [5]int              // [0, 0, 0, 0, 0]
colors := [3]string{"red", "green", "blue"}
auto := [...]int{1, 2, 3, 4}   // Size inferred from values: [4]int
\`\`\`

Arrays are values in Go. Assigning or passing an array copies the entire thing. This is different from most languages.

### Slices

Slices are Go's workhorse data structure. They're dynamic, resizable views over arrays:

\`\`\`go
// Create a slice
names := []string{"Alice", "Bob", "Charlie"}

// Create with make (length 0, capacity 10)
scores := make([]int, 0, 10)

// Append elements
names = append(names, "Diana")
names = append(names, "Eve", "Frank")

// Length and capacity
fmt.Println(len(names))  // 6 (number of elements)
fmt.Println(cap(names))  // Capacity (underlying array size)
\`\`\`

**Slicing**: Create a sub-slice (shares the same underlying array):

\`\`\`go
nums := []int{0, 1, 2, 3, 4, 5}

a := nums[1:4]   // [1, 2, 3]: from index 1 up to (not including) 4
b := nums[:3]    // [0, 1, 2]: from start up to 3
c := nums[3:]    // [3, 4, 5]: from index 3 to end
d := nums[:]     // [0, 1, 2, 3, 4, 5]: full copy reference
\`\`\`

**Iterating over a slice:**

\`\`\`go
fruits := []string{"apple", "banana", "cherry"}

for i, fruit := range fruits {
    fmt.Printf("%d: %s\\n", i, fruit)
}
\`\`\`

**Common slice operations:**

\`\`\`go
// Check if empty
if len(mySlice) == 0 {
    fmt.Println("empty")
}

// Remove element at index i
slice = append(slice[:i], slice[i+1:]...)

// Copy a slice (independent copy, not a reference)
dst := make([]int, len(src))
copy(dst, src)

// Insert at index i
slice = append(slice[:i], append([]int{newVal}, slice[i:]...)...)
\`\`\`

### Maps

Maps are Go's hash table / dictionary. They store key-value pairs:

\`\`\`go
// Create a map
ages := map[string]int{
    "Alice": 30,
    "Bob":   25,
}

// Create with make
scores := make(map[string]int)

// Set a value
ages["Charlie"] = 35

// Get a value
age := ages["Alice"]  // 30

// Check if key exists (the "comma ok" idiom)
age, exists := ages["Unknown"]
if !exists {
    fmt.Println("Key not found")
}

// Delete a key
delete(ages, "Bob")

// Iterate (order is NOT guaranteed)
for name, age := range ages {
    fmt.Printf("%s is %d\\n", name, age)
}

// Length
fmt.Println(len(ages))
\`\`\`

**Important:** You must initialize a map before writing to it. Writing to a \`nil\` map panics:

\`\`\`go
var m map[string]int  // nil map
m["key"] = 1          // PANIC: assignment to entry in nil map

m = make(map[string]int)  // Initialize it first
m["key"] = 1              // Now it works
\`\`\`

**Using maps as sets**: Go has no built-in set type. Use a map with \`bool\` or empty struct values:

\`\`\`go
seen := map[string]bool{}
seen["apple"] = true

if seen["apple"] {
    fmt.Println("Already seen")
}

// Memory-efficient set using empty struct (0 bytes per value)
type void struct{}
set := map[string]void{}
set["apple"] = void{}
_, exists := set["apple"]
\`\`\`

### Standard Library Helpers (Go 1.21+)

Before Go 1.21, every project reimplemented the same slice and map helpers. The standard library now ships \`slices\` and \`maps\` packages that cover the common cases, so reach for them first before writing your own.

\`\`\`go
import (
    "slices"
    "maps"
)

nums := []int{3, 1, 4, 1, 5, 9, 2, 6}

// Search and membership
i := slices.Index(nums, 5)             // 4 (or -1 if absent)
ok := slices.Contains(nums, 9)         // true
min := slices.Min(nums)                // 1
max := slices.Max(nums)                // 9

// Ordering
slices.Sort(nums)                       // in-place ascending sort
slices.Reverse(nums)                    // in-place reverse
slices.IsSorted(nums)                   // true/false

// Mutation
nums = slices.Delete(nums, 2, 4)        // remove indices [2,4)
nums = slices.Insert(nums, 0, 10, 11)   // insert 10, 11 at index 0
nums = slices.Compact(nums)             // drop consecutive duplicates
nums = slices.Concat([]int{1,2}, []int{3,4})

// Copy and clone
cp := slices.Clone(nums)                // independent copy

// Predicate forms
has := slices.ContainsFunc(nums, func(n int) bool { return n > 100 })
idx := slices.IndexFunc(nums, func(n int) bool { return n%2 == 0 })
\`\`\`

For maps:

\`\`\`go
ages := map[string]int{"Alice": 30, "Bob": 25}

// Keys and values as slices (Go 1.23+ returns iter.Seq; use slices.Collect to materialize)
ks := slices.Collect(maps.Keys(ages))
vs := slices.Collect(maps.Values(ages))

// Copy, clone, equality, deletion by predicate
m2 := maps.Clone(ages)
same := maps.Equal(ages, m2)
maps.DeleteFunc(ages, func(k string, v int) bool { return v < 18 })
\`\`\`

**When to still hand-roll.** The \`slices\` package allocates a new slice for operations like \`Concat\` and \`Clone\`, which can dominate a hot loop if you already own a reusable buffer. Benchmark before replacing a well-tuned append loop. For maps, \`maps.Keys\` and \`maps.Values\` return iterators (Go 1.23+), so chain them with \`slices.Collect\` only if you actually need the materialized slice.

### The Slice Header in One Picture

The single most important thing to understand about Go slices is that a slice is not the underlying array. A slice is a three-word header (pointer, length, capacity) that points into a backing array. Two slices can share the same backing array, and a write through one is visible through the other. This is the source of nearly every "I don't understand what just happened" slice bug:

\`\`\`go
nums := []int{1, 2, 3, 4, 5}
a := nums[1:3]     // {2, 3}, len=2, cap=4 (shares storage with nums)
a[0] = 99
fmt.Println(nums)  // [1, 99, 3, 4, 5] — nums was mutated through a
\`\`\`

\`append\` is the bridge between "shared storage" and "independent storage". When \`append\` has capacity, it writes in place and the slice still aliases the original. When it does not, it allocates a new backing array, copies the elements, and returns a slice that no longer aliases. The decision is invisible at the call site, which is why this code is dangerous:

\`\`\`go
func process(s []int) []int {
    return append(s, 99)
}

original := make([]int, 2, 10)
result := process(original) // writes into original's backing array — silent aliasing
\`\`\`

The defensive idioms are: (1) accept a slice as input only if you will not append, (2) if you will append, document it or copy with \`slices.Clone(s)\` first, (3) when returning a slice that should be independent, build it with \`make\` and \`copy\` or with \`slices.Clone\`.

### Map Iteration Order Is Randomised

Go deliberately randomises the iteration order of maps so that callers cannot accidentally come to depend on it. The randomisation is per-process, not per-iteration, but it is enough to surface tests that secretly assumed alphabetical ordering. When you need a deterministic order (test snapshots, JSON output that diffs cleanly, debug logs), iterate over \`slices.Sorted(maps.Keys(m))\` rather than the map directly. This is the answer interviewers expect to "how do you iterate a map in sorted-key order?" and it is one of the easiest "language fluency" signals you can give.

### Slice and Map Capacity Mechanics

The performance characteristics of slices and maps are part of the language contract you should know cold:

- **\`append\` amortised growth.** When \`append\` needs to grow, it doubles capacity for slices smaller than a few hundred elements and grows by 25% for larger ones (the exact threshold has shifted across versions and is around 256 in Go 1.22+). Pre-allocating with \`make([]T, 0, knownSize)\` when you know the final size avoids the geometric copy chain entirely. For a slice you grow to 10,000 elements, the pre-allocation saves around 14 reallocations and a comparable number of memcopies.
- **Map preallocation.** \`make(map[K]V, hint)\` accepts a size hint that lets the runtime pre-size the bucket array. For maps you populate to a known size (e.g. building a lookup from a known-length input), the hint avoids rehashing during insertion. For unknown sizes, leave it out.
- **Map deletion does not shrink.** A map that grew to a million entries and was then deleted down to ten still holds buckets for the high-water mark. The fix is to copy the small remainder into a fresh map (\`m2 := maps.Clone(m)\` followed by \`m = m2\`) when memory is a concern. This is a recurring source of "my service slowly leaks memory" bug reports for long-lived caches.
- **Slice capacity is not freed by reslicing.** \`s = s[:0]\` keeps the backing array. To release the memory, write \`s = nil\` or build a new slice with \`make\`.

### Comparable Keys and Custom Hashing

Maps in Go require comparable keys. Strings, numbers, booleans, channels, pointers, interfaces (where the dynamic type is comparable), arrays of comparable types, and structs of comparable types all qualify. Slices, maps, and functions do not. There is no way to provide a custom hash or equality function the way you do in Java's \`equals\`/\`hashCode\` or Python's \`__hash__\`/\`__eq__\`. The Go workaround when you need a custom key (for example, hashing a slice's contents) is to encode the key into a comparable form first, usually a string built from the canonical representation.

For high-performance applications where Go's built-in map is the bottleneck, the alternatives are \`swiss.Map\` from third-party packages, \`sync.Map\` for concurrent read-heavy workloads (with sharp edges around iteration), and direct use of the \`container/list\` or hand-rolled open-addressing tables. Reach for those only when pprof says so.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer will flag in slice and map heavy code:

1. **Returning a sub-slice of a function-local buffer.** \`return buf[:n]\` returns a slice that aliases an array which the caller cannot see. If the caller appends and the underlying array is reused, weird mutations follow. The fix is to copy with \`append([]T(nil), buf[:n]...)\` or \`slices.Clone(buf[:n])\` at the boundary, or to document the aliasing explicitly. This is a top finding in production code review.
2. **Slice-of-pointers vs slice-of-values.** A \`[]*User\` and a \`[]User\` have different memory layouts, different iteration costs, and different garbage-collection behaviour. Slice-of-pointers is the right choice when the elements are large and mutated through the slice. Slice-of-values is the right choice for small, value-semantic types where the cache locality of a packed array matters. Hot-path code that has the wrong choice shows up in pprof as either excess heap allocations (slice-of-pointers when slice-of-values would do) or excess copies (slice-of-values when only a pointer should have been stored).
3. **Maps used where a struct would do.** \`map[string]any\` is the Go answer to "I do not know my schema yet". For configuration parsing or external JSON it is fine. For internal data flow it is a code smell. Promote it to a typed struct as soon as the schema stabilises, because the lack of compile-time field checks is exactly the bug surface the type system is supposed to remove.

### Migration Lens

Coming from Python, the most surprising thing is that there is no list comprehension. The Go equivalent is an explicit \`for\` loop with \`append\`. The verbosity is intentional. Coming from Java, the lack of \`ArrayList\`, \`LinkedList\`, \`HashMap\`, and \`TreeMap\` distinctions is initially uncomfortable. Slices replace \`ArrayList\` and (in most cases) \`LinkedList\`, and maps replace \`HashMap\`. There is no built-in tree map. When you need ordered iteration, you sort the keys at iteration time, or you reach for a third-party package like \`github.com/google/btree\`. Coming from JavaScript, the comparable-key restriction is a real change. JavaScript's \`Map\` accepts any value as a key. Go's map does not, and the workaround for "I want to key by a complex object" is to canonicalise to a string. Coming from Rust, slice aliasing rules are vastly more permissive in Go (no borrow checker), which is faster to write and easier to get subtly wrong. The defensive idioms above are how Go teams compensate for the lack of compiler-enforced aliasing rules.
`;
