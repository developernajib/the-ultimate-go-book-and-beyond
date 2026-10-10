## 69.10 Common Mistakes

### Mistake 1: Using Unhashable Types as Keys

Go's map key type must satisfy the `comparable` constraint, which excludes slices, maps, and functions. When a composite key is needed, encode it as a string using `fmt.Sprintf` or use a fixed-size array, which is comparable and can serve directly as a map key.

```go
// ❌ BAD: Slices are not hashable
func badMapKey() {
    m := make(map[[]int]string)  // Compile error!
}

// ✅ GOOD: Convert to hashable type
func goodMapKey() {
    // Use string representation
    m := make(map[string]string)
    key := fmt.Sprintf("%v", []int{1, 2, 3})
    m[key] = "value"

    // Or use array (fixed size)
    m2 := make(map[[3]int]string)
    m2[[3]int{1, 2, 3}] = "value"
}
```

### Mistake 2: Concurrent Map Access Without Synchronization

A concurrent map write is a genuine data race. The runtime carries a best-effort check that usually catches it and aborts with `fatal error: concurrent map writes`, which `recover` cannot intercept, so the process dies. Treat that check as a backstop rather than a guarantee, and use `go test -race` to find these before production does. Wrapping the map in a `sync.RWMutex` is the idiomatic fix: use `RLock` for reads to allow multiple concurrent readers and `Lock` only for writes.

```go
// ❌ BAD: Race condition
var unsafeMap = make(map[string]int)

func badConcurrent() {
    go func() { unsafeMap["key"] = 1 }()
    go func() { _ = unsafeMap["key"] }()  // RACE!
}

// ✅ GOOD: Use sync.RWMutex or sync.Map
type SafeMap struct {
    data map[string]int
    mu   sync.RWMutex
}

func (m *SafeMap) Set(key string, value int) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.data[key] = value
}

func (m *SafeMap) Get(key string) (int, bool) {
    m.mu.RLock()
    defer m.mu.RUnlock()
    v, ok := m.data[key]
    return v, ok
}
```

### Mistake 3: Not Checking Map Key Existence

Reading a missing key from a Go map returns the zero value of the value type rather than an error, silently producing incorrect results when the zero value is a valid sentinel. Always use the two-value form `value, ok := m[key]` to distinguish between an explicit zero and an absent key.

```go
// ❌ BAD: Assumes key exists
func badCheck(m map[string]int, key string) int {
    return m[key]  // Returns 0 if key doesn't exist
}

// ✅ GOOD: Always check existence
func goodCheck(m map[string]int, key string) (int, bool) {
    value, exists := m[key]
    return value, exists
}

// Or use in conditional
func handleKey(m map[string]int, key string) {
    if value, exists := m[key]; exists {
        // Key exists
        fmt.Println(value)
    } else {
        // Key doesn't exist
        fmt.Println("not found")
    }
}
```

### Mistake 4: Inserting Into a Map During Iteration

This one is worth stating carefully, because the folk wisdom gets it backwards. The Go specification defines both cases, and they differ:

> If a map entry that has not yet been reached is removed during iteration, the corresponding iteration value will not be produced. If a map entry is created during iteration, that entry may be produced during the iteration or may be skipped. The choice may vary for each entry created and from one iteration to the next.

So **deleting during `range` is well-defined and safe**. A deleted entry you have not reached yet simply will not be produced. Deleting the current key is ordinary, idiomatic Go and needs no workaround. **Inserting during `range` is the unspecified case**: a new entry may or may not be visited, so the loop's trip count is not predictable, and an insert that keeps feeding the map can even keep the loop running.

```go
// ✅ FINE: deleting during range is defined by the spec
func pruneInPlace(m map[string]int) {
    for k, v := range m {
        if v < 0 {
            delete(m, k) // safe, no second pass needed
        }
    }
}

// ❌ BAD: inserting during range is unspecified
func badGrow(m map[string]int) {
    for k := range m {
        m[k+"_copy"] = 1 // may or may not be visited by this same loop
    }
}

// ✅ GOOD: collect first, then insert after the loop
func goodGrow(m map[string]int) {
    additions := make(map[string]int, len(m))
    for k := range m {
        additions[k+"_copy"] = 1
    }
    maps.Copy(m, additions)
}
```

The one caveat on delete-during-range: it is only safe from the *same* goroutine that is ranging. A delete from another goroutine is a concurrent write, which is mistake 2, not this one.

### Mistake 5: Map as Pointer Receiver Confusion

Maps are already reference types in Go, so passing a map to a function allows the callee to modify its contents without a pointer. A pointer to a map is only needed when the function must replace the map itself (i.e., reassign the variable) rather than just modify its entries.

```go
// ❌ BAD: Map is already a reference type
func badPointer(m *map[string]int) {
    (*m)["key"] = 1  // Works but unnecessary
}

// ✅ GOOD: Pass map directly
func goodDirect(m map[string]int) {
    m["key"] = 1  // Modifies the original map
}

// But pointer is needed to reassign
func reassignMap(m *map[string]int) {
    *m = make(map[string]int)  // Creates new map
}
```

### Junior -> FAANG: Turning Mistakes into Interview Confidence

Each mistake listed here is a real interview failure mode. Reviewing them before an interview is not paranoia. It is preparation. The most commonly observed errors in live coding interviews, ranked by frequency:

1. Concurrent map access without synchronization. If your solution involves goroutines and a shared map, immediately add a mutex or switch to `sync.Map`. Never submit concurrent map code without it.
2. Not using the comma-ok idiom. Get into the habit of always writing `v, ok := m[key]` rather than `v := m[key]`. The zero-value confusion mistake (mistake 3) is completely eliminated by this single habit.
3. Inserting during iteration. Pruning with `delete` while ranging is defined and safe, so do not let a reviewer talk you into a needless second pass. Adding entries mid-range is the unspecified one: buffer them and merge after the loop.
4. Using a slice as a map key. This produces a compile error that is embarrassing under interview time pressure. Know the rule: only `comparable` types can be map keys.
5. Pointer-to-map confusion. Maps are already reference types. Wrapping them in a pointer is almost never correct and signals confusion about Go's value semantics.

### Senior @ FAANG: Common Mistakes as Code Review Criteria

These five mistake categories are the checklist items a senior reviewer uses when reviewing any PR that introduces a map-based data structure.

Concurrent access is the highest-severity issue: it aborts the process non-deterministically, is difficult to reproduce, and can go undetected for months in staging. Running the race detector in CI turns this from a production incident into a failing test, which is why it belongs in the pipeline rather than in a reviewer's memory. The standard code review question for any map declaration is: "Which goroutines access this map, and is access synchronized?" If the answer requires reading several files to determine, the synchronization contract should be documented in a comment at the declaration site.

The pointer receiver confusion (mistake 5) is subtler in team codebases because it sometimes emerges from refactoring: a struct originally using a map value was changed to use a pointer to the struct, and the map value inside was unnecessarily double-wrapped. Catching this requires understanding Go's value vs. reference type semantics at a level that many mid-level engineers do not have. Including "is this map wrapped in an unnecessary pointer?" as a review checklist item is the kind of team-level investment that prevents a class of bugs before they reach code review.

---
