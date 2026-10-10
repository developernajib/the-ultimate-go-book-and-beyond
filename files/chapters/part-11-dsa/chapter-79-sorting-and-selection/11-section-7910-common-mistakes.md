## 79.10 Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| Sorting to get top-k | O(n log n) where O(n log k) was available | Bounded heap or quickselect |
| Relying on unstable ties | Order is unspecified and version-dependent | Tie-break explicitly, or use a stable sort |
| `a - b` as a comparator | Overflows for large or negative values | `cmp.Compare(a, b)` |
| `sort.Slice` on a hot path | Reflection and an indirect call per compare | `slices.Sort` / `slices.SortFunc` |
| `sort.SliceStable` with a total order | Paying ~4x for a redundant guarantee | `slices.SortFunc` |
| Binary search on unsorted data | Silent wrong answer, no panic | Assert `slices.IsSorted` in debug builds |
| Re-sorting unchanged data per request | O(n log n) repeated for no reason | Cache the sorted view or maintain order |
| Sorting whole records | Moves 30x more bytes than needed | Sort (key, offset) pairs |
| Radix sort "because it's O(n)" | Loses to pdqsort on cache behaviour | Measure, and check the preconditions |

### The Overflow Comparator

This is the most common bug in the table, and it survives code review because it looks correct:

```go
// WRONG: overflows. For a = math.MinInt, b = 1, a-b wraps to a positive
// number, so the comparator reports a > b and the sort silently produces
// garbage order. No panic, no error.
slices.SortFunc(nums, func(a, b int) int { return a - b })

// CORRECT
slices.SortFunc(nums, func(a, b int) int { return cmp.Compare(a, b) })

// Also correct for a plain ordered slice, and faster:
slices.Sort(nums)
```

The subtraction trick is inherited from C and from `qsort`, where it was equally wrong and equally common. It only works when you can prove the values are bounded well within the type's range. `cmp.Compare` is not slower in any way you can measure, so there is never a reason to take the risk.

### The Inconsistent Comparator

Sorting requires a **strict weak ordering**. If your comparison is inconsistent, meaning it says `a < b` and `b < a`, or claims equality is not transitive, the sort's behaviour is undefined. It may produce a wrong order, or it may panic with an index out of range from deep inside the sort package, because the algorithm's invariants have been violated.

```go
// WRONG: NaN breaks the ordering. Any comparison involving NaN is false,
// so this comparator claims NaN is neither less than, greater than, nor
// equal to anything, which is not a valid ordering.
slices.SortFunc(vals, func(a, b float64) int {
    if a < b { return -1 }
    if a > b { return 1 }
    return 0
})

// CORRECT: cmp.Compare defines a total order on floats by treating
// NaN as less than everything, including negative infinity.
slices.SortFunc(vals, cmp.Compare)
// or simply
slices.Sort(vals)
```

Float sorting with NaN present is the classic instance, and `cmp.Compare` handles it deliberately: it orders NaN before all other values so that the result is a genuine total order.

### Mutation Surprise

Every sort in Go sorts **in place** and returns nothing. This surprises people arriving from languages where `sorted(x)` returns a copy.

```go
func Report(data []int) []int {
    slices.Sort(data) // MUTATES the caller's slice
    return data[:10]
}
```

If the caller did not expect their slice reordered, you have introduced an action at a distance bug that will be found far from here. When a function receives a slice it does not own and needs it sorted, clone first:

```go
func Report(data []int) []int {
    sorted := slices.Clone(data)
    slices.Sort(sorted)
    return sorted[:10]
}
```

This is worth a doc comment either way. "Report sorts data in place" is a contract - leaving it unsaid is a bug waiting for a concurrent reader.

### Junior -> FAANG: The Two That Will Bite You

Of everything above, two mistakes account for most real damage.

**Sorting for top-k** costs you interview points every time, and it is pure reflex. Train the trigger: the words "top", "kth", "median", "most frequent" mean stop and consider a heap.

**Unstable ties** costs you production incidents. The output looks right in tests with 5 elements, because pdqsort uses insertion sort under 13 elements and insertion sort happens to be stable. Then a slice grows past 12 in production and the order changes. Break ties explicitly and the whole class disappears.

### Senior @ FAANG: Which of These a Linter Can Catch

Several of these are mechanically detectable, and turning review comments into tooling is the staff-level move. A `go/analysis` pass, per Chapter 7B, can flag a comparison function whose body is a bare subtraction of two integer expressions, which catches the overflow comparator with essentially no false positives. It can flag `sort.SliceStable` and cross-reference whether the comparator ends in a total-order tie-break, though that one needs judgement and belongs as a warning rather than an error. It can flag `sort.Slice` in packages annotated as latency-sensitive.

What tooling cannot catch is the architectural mistake, which is also the expensive one: the service that re-sorts unchanged data on every request. No linter sees that, because every individual call is correct. It shows up in a profile as a sort with suspiciously high cumulative time and stable input, and finding it is a matter of asking why the order is being recomputed rather than maintained. That is the review question, and it is worth asking whenever a sort appears anywhere near a request path.
