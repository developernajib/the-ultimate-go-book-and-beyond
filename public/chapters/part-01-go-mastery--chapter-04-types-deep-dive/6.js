export default `## 4.5 Maps

Maps are Go's hash table implementation, providing O(1) average-case lookups.

### Map Basics

Maps are Go's built-in hash map type. They are initialized with \`make\` or a composite literal and provide O(1) average-case get, set, and delete operations. Maps are not safe for concurrent use without synchronization.

\`\`\`go
// Declaration (nil map, can read but not write)
var m map[string]int

// Initialization
m := make(map[string]int)
m := make(map[string]int, 100)  // Size hint
m := map[string]int{"a": 1, "b": 2}

// Operations
m["c"] = 3           // Set
v := m["a"]          // Get (0 if missing)
v, ok := m["a"]      // Get with existence check
delete(m, "a")       // Delete
len(m)               // Number of keys
clear(m)             // Delete all keys (Go 1.21+)
\`\`\`

### The Comma-Ok Idiom

Map lookups return two values: the value and a boolean indicating whether the key was present. This idiom distinguishes between a key that maps to the zero value and a key that is absent from the map.

\`\`\`go
m := map[string]int{"a": 1, "zero": 0}

// Without ok, you can't distinguish missing key from zero value
v := m["b"]  // v = 0 (but is "b" missing or actually 0?)
v := m["zero"]  // v = 0 (this one exists!)

// With ok
v, ok := m["a"]     // v = 1, ok = true
v, ok := m["b"]     // v = 0, ok = false
v, ok := m["zero"]  // v = 0, ok = true

// Common pattern
if v, ok := m["key"]; ok {
    // key exists, use v
} else {
    // key doesn't exist
}
\`\`\`

### Nil Maps

A \`var m map[K]V\` declaration produces a nil map. Reading a nil map returns the zero value without panicking, but writing to one causes a runtime panic. This asymmetry trips up newcomers, always initialize a map with \`make\` or a literal before storing values.

\`\`\`go
var m map[string]int  // nil

// Reading nil map returns zero value
v := m["key"]  // v = 0, no panic
_, ok := m["key"]  // ok = false

// Writing to nil map panics
m["key"] = 1  // panic: assignment to entry in nil map

// Always initialize before writing
m = make(map[string]int)
m["key"] = 1  // works
\`\`\`

### Map Iteration

Iterating over a map with \`range\` yields keys and values in a deliberately randomized order. Code must not depend on iteration order. Sort the keys explicitly if a deterministic order is required.

\`\`\`go
m := map[string]int{"a": 1, "b": 2, "c": 3}

// Keys and values
for k, v := range m {
    fmt.Println(k, v)
}

// Keys only
for k := range m {
    fmt.Println(k)
}

// Values only
for _, v := range m {
    fmt.Println(v)
}
\`\`\`

**Important**: Iteration order is randomized by design (prevents depending on order).

### Ordered Iteration

When deterministic output is needed, for tests, logs, or serialization, collect the keys into a slice, sort them, and iterate in that order.

\`\`\`go
m := map[string]int{"banana": 2, "apple": 1, "cherry": 3}

// Get sorted keys
keys := make([]string, 0, len(m))
for k := range m {
    keys = append(keys, k)
}
slices.Sort(keys)

// Iterate in order
for _, k := range keys {
    fmt.Printf("%s: %d\\n", k, m[k])
}
// apple: 1
// banana: 2
// cherry: 3
\`\`\`

### Map Keys

Map keys must satisfy Go's \`comparable\` constraint. Any type that supports \`==\` can be a key: basic types, pointers, arrays, structs with all comparable fields, channels, and interfaces. Slices, maps, and functions cannot be keys because they are not comparable.
- Basic types (int, string, bool, etc.)
- Pointers
- Arrays (but not slices)
- Structs (if all fields are comparable)
- Channels
- Interfaces (compared by dynamic type and value)

\`\`\`go
// Struct as key
type Point struct {
    X, Y int
}
points := make(map[Point]string)
points[Point{1, 2}] = "first"

// Array as key (not slice!)
type IPv4 [4]byte
hosts := make(map[IPv4]string)
hosts[IPv4{127, 0, 0, 1}] = "localhost"

// Can't use slice as key:
// var m map[[]int]string  // Compile error
\`\`\`

### Map Size Hints

If you know approximate size, provide a hint to avoid rehashing:

\`\`\`go
// Without hint: may resize multiple times during population
m := make(map[string]int)

// With hint: preallocates buckets
m := make(map[string]int, 1000)

// Benchmark difference for inserting 1000 items:
// Without hint: 89.6 µs/op, 41.8 KB/op, 10 allocs/op
// With hint:    45.2 µs/op, 41.8 KB/op,  1 allocs/op
\`\`\`

### Map Internals: Swiss Tables (Go 1.24+)

Go 1.24 replaced the original bucket-based map implementation with a Swiss Tables design, based on the hash table Google open-sourced in Abseil. The older implementation laid out entries in buckets of 8 slots chained through overflow pointers. The new implementation organizes entries in groups of 8 slots with a parallel 8-byte control word per group. Each control byte stores a 7-bit fingerprint of the hash plus a flag for empty, deleted, or full. A lookup hashes the key once, splits the hash into a group index (upper bits) and a 7-bit fingerprint (lower bits), and scans the control word for matching fingerprints. On amd64 this match step is a single SIMD compare, so the 8 slots are checked in parallel. Only fingerprint matches trigger a full key comparison.

The practical effects:

- Lookups and insertions are typically 30 to 60 percent faster on microbenchmarks, and iteration is roughly 50 percent faster.
- Memory overhead is lower because the control bytes are small and the bucket-plus-overflow pointer layout is gone.
- Cache behavior improves because one group fits in two cache lines.

Nothing about the language-level contract changed. Iteration order is still randomized, nil map reads still succeed, writes to nil maps still panic, maps are still unsafe for concurrent use without synchronization. Datadog reported saving hundreds of gigabytes of RSS across their Go services after the 1.24 upgrade with no code changes (verified 2026-04).

> **Senior track**: the Go runtime also uses extendible hashing across groups. When a group overflows, the table can grow only that region of the address space rather than rehashing the whole map. Combined with the SIMD fingerprint scan, this is why \`make(map[K]V, n)\` followed by many inserts is now close to the cost of the equivalent \`sync.Map\` or third-party hashmap library, and often cheaper.

### How Google Implements Caches

Google's groupcache uses maps with careful memory management:

\`\`\`go
// Simplified LRU cache pattern
type LRU struct {
    capacity int
    items    map[string]*entry
    head     *entry
    tail     *entry
    mu       sync.RWMutex
}

type entry struct {
    key   string
    value any
    prev  *entry
    next  *entry
}

func NewLRU(capacity int) *LRU {
    return &LRU{
        capacity: capacity,
        items:    make(map[string]*entry, capacity),
    }
}

func (c *LRU) Get(key string) (any, bool) {
    c.mu.RLock()
    e, ok := c.items[key]
    c.mu.RUnlock()

    if !ok {
        return nil, false
    }

    c.mu.Lock()
    c.moveToFront(e)
    c.mu.Unlock()

    return e.value, true
}

func (c *LRU) Set(key string, value any) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if e, ok := c.items[key]; ok {
        e.value = value
        c.moveToFront(e)
        return
    }

    // Add new entry
    e := &entry{key: key, value: value}
    c.items[key] = e
    c.addToFront(e)

    // Evict if over capacity
    if len(c.items) > c.capacity {
        oldest := c.tail
        c.removeFromList(oldest)
        delete(c.items, oldest.key)
    }
}
\`\`\`

### Concurrent Map Access

Go's built-in maps are not safe for concurrent reads and writes. The runtime detects concurrent access and crashes the program with a fatal error rather than silently corrupting data. Two options exist: \`sync.Map\` for read-heavy workloads, and a regular map protected by \`sync.RWMutex\` for write-heavy ones.

\`\`\`go
m := make(map[string]int)

// This will panic or corrupt data:
go func() {
    for {
        m["key"] = 1
    }
}()
go func() {
    for {
        _ = m["key"]
    }
}()
// fatal error: concurrent map read and map write
\`\`\`

**Option 1: sync.Map**

\`\`\`go
import "sync"

var m sync.Map

// Store
m.Store("key", "value")

// Load
v, ok := m.Load("key")

// Delete
m.Delete("key")

// LoadOrStore: load existing or store new
actual, loaded := m.LoadOrStore("key", "value")

// LoadAndDelete (Go 1.15+)
v, loaded := m.LoadAndDelete("key")

// Range
m.Range(func(k, v any) bool {
    fmt.Println(k, v)
    return true  // Continue iteration
})
\`\`\`

\`sync.Map\` is optimized for:
- Read-heavy workloads
- Keys written once but read many times
- Multiple goroutines accessing disjoint key sets

**Option 2: Regular map with mutex**

\`\`\`go
type SafeMap struct {
    mu sync.RWMutex
    m  map[string]int
}

func (s *SafeMap) Get(key string) (int, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    v, ok := s.m[key]
    return v, ok
}

func (s *SafeMap) Set(key string, value int) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.m[key] = value
}

// Often better than sync.Map for write-heavy workloads
\`\`\`

### Benchmark: sync.Map vs RWMutex

The following benchmark compares \`sync.Map\` and a \`map\` protected by \`sync.RWMutex\` across different read/write ratios. \`sync.Map\` excels when the key set is stable and reads dominate writes.

\`\`\`go
// Results vary by workload:
// Read-heavy (95% reads):
// sync.Map:    75 ns/op
// RWMutex:    120 ns/op

// Write-heavy (50% writes):
// sync.Map:   450 ns/op
// RWMutex:    180 ns/op

// Conclusion: Profile your specific use case!
\`\`\`

### maps Package (Go 1.21+)

The \`maps\` package introduced in Go 1.21 provides generic functions for common map operations: cloning, collecting keys, collecting values, and equality testing. These eliminate repetitive boilerplate.

\`\`\`go
import "maps"

m := map[string]int{"a": 1, "b": 2}

maps.Clone(m)              // Shallow copy
maps.Equal(m, other)       // Deep comparison
maps.Copy(dst, src)        // Copy src into dst
maps.DeleteFunc(m, func(k string, v int) bool {
    return v > 1           // Delete entries where v > 1
})

// Collect keys or values
keys := maps.Keys(m)       // Returns iterator (Go 1.23)
vals := maps.Values(m)     // Returns iterator (Go 1.23)
\`\`\`

### Long-Running Maps Do Not Shrink

A map that grew to a million entries and was then reduced to ten still holds buckets for the high-water mark. The \`delete\` builtin removes the entry but does not free the bucket memory. For caches, request-scoped maps that accumulate in long-lived goroutines, and any map whose size fluctuates dramatically, the fix is to periodically copy the small remainder into a fresh map:

\`\`\`go
if len(m) < initialSize/4 && initialSize > shrinkThreshold {
    m = maps.Clone(m) // allocates a new map sized to the current len
}
\`\`\`

This is the pattern for the "my service slowly leaks memory over weeks and pprof says map buckets" incident shape.

### Concurrent Map Access: When \`sync.Map\` Actually Wins

\`sync.Map\` is documented to be optimal for two access patterns: read-heavy workloads with a stable key set, and workloads where each goroutine operates on a disjoint subset of keys. In every other case, a regular map with a \`sync.RWMutex\` is faster and easier to reason about. The common mistake is reaching for \`sync.Map\` because "maps are not goroutine-safe", then paying its overhead for a workload it is not designed for. The profiling step is cheap: benchmark both. If the read/write ratio is less than 10:1, the mutex version wins more often than not.

### Map Internals Insight for Interviews

The Swiss Tables switch in Go 1.24 is worth knowing about as a senior-level trivia question, but the older bucket-based implementation is still widely discussed in interviews. Both implementations share these observable properties:

1. Hash collisions are handled by probing, not by chaining at the bucket level in the modern implementation.
2. The load factor is bounded, and the runtime grows the map (allocates a larger bucket array and rehashes) when it is exceeded.
3. Iteration starts from a random bucket and visits each bucket in order. This is where the iteration randomisation comes from.
4. Maps cannot shrink. This is a direct consequence of the hash-table design.

Knowing these four properties is usually sufficient for an interview. The Swiss Tables details are bonus material.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in map-heavy PRs:

1. **A map used where a struct would do.** \`map[string]any\` for internal data flow is a code smell. Promote to a struct when the schema is known. The type system catches bugs that string-keyed maps hide.
2. **A map without a size hint when the final size is known.** \`make(map[K]V)\` is fine for unknown sizes. \`make(map[K]V, n)\` avoids rehashing when populating to a known size. The missing hint shows up as \`runtime.mapassign\` in pprof for high-throughput services.
3. **A map iterated without sorting when the output must be deterministic.** Test snapshots, JSON that diffs cleanly, debug logs. If the output is compared for equality anywhere, the iteration must be sorted.

### Migration Lens

Coming from Python's \`dict\`, Go maps have similar behaviour but with stricter typing and randomised iteration order. Python 3.7+ guarantees insertion order on \`dict\` iteration, which a lot of code relies on. Go does not. Coming from Java's \`HashMap\`, Go maps are similar but simpler: no \`put\` vs \`putIfAbsent\` distinction (use the \`_, ok := m[k]\` pattern), no \`compute\` method family (do it explicitly), no \`Entry\` iteration (key-value pair is direct from \`range\`). Coming from Rust, Go maps trade Rust's borrow-checker guarantees for simplicity. The "concurrent access is a runtime panic" contract in Go is the price.

---
`;
