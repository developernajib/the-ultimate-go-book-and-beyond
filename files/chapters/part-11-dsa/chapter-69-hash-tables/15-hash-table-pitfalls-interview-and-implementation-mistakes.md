## Hash Table Pitfalls: Interview and Implementation Mistakes

### Pitfall 1: Using Unhashable Types as Map Keys

**Interview Mistake**: Trying to use slices, maps, or functions as map keys in Go.

```go
// WRONG: Slices cannot be map keys
func groupBySliceBad(items [][]int) map[string]int {
    // result := make(map[[]int]int)  // Compile error!
    // Slices are not comparable and cannot be used as map keys
    return nil
}

// CORRECT: Convert to comparable type
func groupBySlice(items [][]int) map[string]int {
    result := make(map[string]int)
    for _, item := range items {
        // Convert slice to string key
        key := sliceToKey(item)
        result[key]++
    }
    return result
}

func sliceToKey(s []int) string {
    // Option 1: String representation
    var builder strings.Builder
    for i, v := range s {
        if i > 0 {
            builder.WriteByte(',')
        }
        builder.WriteString(strconv.Itoa(v))
    }
    return builder.String()
}

// Alternative: Use [N]int array if size is fixed
func groupByArray(items [][3]int) map[[3]int]int {
    result := make(map[[3]int]int)  // Arrays ARE comparable
    for _, item := range items {
        result[item]++
    }
    return result
}

// For custom structs, ensure all fields are comparable
type Point struct {
    X, Y int  // int is comparable, so Point is hashable
}

type BadPoint struct {
    Coords []int  // Contains slice, NOT hashable
}
```

### Pitfall 2: Inserting Into a Map During Iteration

**Interview Mistake**: Believing deletion during iteration is unsafe, and not realizing insertion is the case that actually bites.

The Go specification separates these two operations, and only one is a hazard. A removed entry that the loop has not yet reached is guaranteed not to be produced, which makes delete-during-range fully defined. A created entry "may be produced during the iteration or may be skipped."

```go
// FINE: deleting during iteration is defined by the spec.
// This is idiomatic Go and needs no second pass.
func removeOdds(m map[int]string) {
    for k := range m {
        if k%2 == 1 {
            delete(m, k)
        }
    }
}

// WRONG: Adding during iteration
func duplicateKeys(m map[int]string) {
    for k, v := range m {
        m[k*10] = v  // May or may not be visited by this same loop
    }
}

// CORRECT: Buffer the additions, merge after the loop
func duplicateKeysCorrect(m map[int]string) {
    additions := make(map[int]string, len(m))
    for k, v := range m {
        additions[k*10] = v
    }
    maps.Copy(m, additions)
}

// ALSO FINE: build a new map instead of mutating in place.
// Prefer this when the caller should not observe a partially pruned map.
func removeOddsNewMap(m map[int]string) map[int]string {
    result := make(map[int]string)
    for k, v := range m {
        if k%2 == 0 {
            result[k] = v
        }
    }
    return result
}
```

### Pitfall 3: Assuming Map Order

**Interview Mistake**: Relying on map iteration order, which is deliberately randomized in Go.

```go
// WRONG: Expecting consistent order
func getFirstKey(m map[int]string) int {
    for k := range m {
        return k  // Different key each run!
    }
    return 0
}

// WRONG: Expecting insertion order
func printInOrder(m map[int]string) {
    // Adding 1, 2, 3 doesn't mean iteration will be 1, 2, 3
    for k, v := range m {
        fmt.Println(k, v)  // Random order each time
    }
}

// CORRECT: Sort keys explicitly
func printInOrderCorrect(m map[int]string) {
    keys := make([]int, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    slices.Sort(keys)

    for _, k := range keys {
        fmt.Println(k, m[k])
    }
}

// CORRECT: Use ordered data structure if order matters
type OrderedMap struct {
    keys   []string
    values map[string]int
}

func (om *OrderedMap) Set(key string, value int) {
    if _, exists := om.values[key]; !exists {
        om.keys = append(om.keys, key)
    }
    om.values[key] = value
}

func (om *OrderedMap) Iterate(fn func(string, int)) {
    for _, k := range om.keys {
        fn(k, om.values[k])
    }
}
```

### Pitfall 4: Zero Value Confusion

**Interview Mistake**: Confusing "key not found" with "value is zero".

```go
// WRONG: Can't distinguish missing from zero
func getCount(counts map[string]int, key string) {
    val := counts[key]
    if val == 0 {
        // Is key missing, or is count actually 0?
        fmt.Println("Not found or zero")
    }
}

// CORRECT: Use comma-ok idiom
func getCountCorrect(counts map[string]int, key string) (int, bool) {
    val, exists := counts[key]
    return val, exists
}

// Common pattern: increment with default
func incrementCount(counts map[string]int, key string) {
    // This works because zero value of int is 0
    counts[key]++  // If missing, 0++ = 1
}

// But be careful with pointers
func getUser(users map[string]*User, id string) *User {
    user := users[id]
    // user is nil if not found
    // But user could also be explicitly set to nil!

    // Better:
    user, exists := users[id]
    if !exists {
        return nil  // Definitely not found
    }
    return user  // Found (might still be nil if stored as nil)
}
```

### Pitfall 5: Hash Collision Attack Awareness

**Interview Mistake**: Not knowing that carefully crafted inputs can cause O(n²) behavior.

```go
// WRONG: Assuming O(1) always
func countItems(items []string) map[string]int {
    counts := make(map[string]int)
    for _, item := range items {
        counts[item]++
    }
    return counts
}
// If attacker provides strings that all hash to same bucket,
// this becomes O(n²) instead of O(n)

// Go's defense: a randomly seeded hash, with a fresh seed per map.
// The runtime also reseeds a map that shows adversarial collision pressure.
// Be aware in interviews that the worst case is still O(n) per operation.

// CORRECT: Acknowledge in interview
/*
Interview answer:
"Hash map operations are O(1) average case and O(n) worst case.
The worst case occurs when many keys hash to the same bucket,
which could happen with adversarial input or a poor hash function.
Go mitigates this by using a randomized hash seed, making it
difficult for attackers to craft collision attacks.
In practice, we can assume O(1) for random inputs."
*/

// For security-critical code, consider:
// 1. hash/maphash for your own structures (same seeded primitive the
//    runtime uses). Note Go's map does NOT use SipHash: it uses an
//    AES-NI backed hash where the CPU supports it, and a wyhash-derived
//    fallback elsewhere. Neither is a cryptographic MAC.
// 2. Rate limiting inputs
// 3. Input validation (bound key count and key length)
```

### Quick Reference: Hash Table Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Unhashable keys | Compile error | Convert to string or use arrays |
| Insert during iteration | New keys seen unpredictably | Buffer additions, merge after (delete is safe) |
| Assuming order | Inconsistent results | Sort keys explicitly |
| Zero value confusion | Logic errors | Use comma-ok idiom |
| Collision attacks | O(n²) performance | Validate inputs, use Go's built-in |

### Junior -> FAANG: Pitfalls as Interview Preparation Checklist

Before any coding interview involving hash tables, run through these five pitfalls as a 5-minute mental checklist:

1. "Is my key type comparable?" If you need a slice, struct with slice fields, or map as a key, convert to string or use a fixed-size array.
2. "Am I inserting into the map while ranging over it?" If yes, buffer the additions and merge after the loop. Deleting while ranging is fine and needs no workaround.
3. "Am I assuming iteration order?" If you need ordered output from a map, collect keys into a slice and sort explicitly.
4. "Am I using `m[key]` when I should use `v, ok := m[key]`?" If the zero value of your value type is a valid result, always use the two-value form.
5. "Have I considered the hash flooding worst case in my complexity analysis?" The correct answer in an interview is "O(1) average, O(n) worst case, with Go's randomized seed making worst case practically unreachable."

Running this checklist takes 30 seconds and eliminates the five most common hash-map interview mistakes.

### Senior @ FAANG: Pitfalls as Platform Risk Assessment

At the staff level, these pitfalls translate into platform-level risk categories that require systemic solutions rather than per-engineer discipline.

Hash flooding (pitfall 5) is a systemic risk that requires defense in depth: input length limits at the API layer, request rate limiting, and Go's runtime seed randomization. If any of these three defenses is absent, the attack surface exists. A security review of any service that accepts user-controlled string inputs and stores them in maps should verify all three defenses are present. This belongs in the security runbook, not in individual code reviews.

Zero-value confusion (pitfall 4) is a systemic API design problem. If your team's internal map wrapper frequently causes bugs because callers forget the comma-ok idiom, the solution is to change the API: return `(V, bool)` from all accessor methods rather than just `V`, making the absence of a key explicit in the type signature rather than hidden in a Go language detail. This is the kind of "make the pit of success wider" design decision that staff engineers own.

The collision attack awareness pitfall (pitfall 5 in the table) is often treated as academic but becomes concrete for services that build routing tables, frequency counters, or session indexes from user-controlled input without input validation. Including "does this map receive user-controlled keys?" as a standard security checklist question for new service components is a staff-level process contribution.

---
