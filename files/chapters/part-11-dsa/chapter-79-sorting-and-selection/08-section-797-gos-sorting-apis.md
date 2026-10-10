## 79.7 Go's Sorting APIs

Go has two sorting packages and four ways to sort a slice. Knowing which to reach for, and why one is measurably faster than another, is the most immediately useful material in this chapter.

### The Modern Path: `slices`

Since Go 1.21 the `slices` package is the default answer.

```go
import "slices"

nums := []int{5, 2, 8, 1}
slices.Sort(nums)                    // any cmp.Ordered type

people := []Employee{...}
slices.SortFunc(people, func(a, b Employee) int {   // returns -1, 0, +1
    return cmp.Compare(a.Age, b.Age)
})
slices.SortStableFunc(people, cmpByAge)             // stable variant

slices.IsSorted(nums)                               // O(n) check
i, found := slices.BinarySearch(nums, 8)            // requires sorted input
```

Note the comparison function's shape. `slices.SortFunc` takes a **three-way** comparison returning a negative number, zero, or a positive number, not a boolean `less`. This is why `cmp.Compare` exists, and it is also overflow-safe: writing `func(a, b int) int { return a - b }` is a bug for large values, exactly the trap Chapter 65 covers.

### The Legacy Path: `sort`

```go
import "sort"

sort.Ints(nums)                                      // pre-generics helpers
sort.Slice(people, func(i, j int) bool {             // index-based less
    return people[i].Age < people[j].Age
})
sort.SliceStable(people, less)
sort.Sort(byAge(people))                             // sort.Interface
```

`sort.Interface` is still the right tool when the thing you are sorting is not a plain slice, or when you need to attach sorting behaviour to a named type:

```go
type byAge []Employee

func (a byAge) Len() int           { return len(a) }
func (a byAge) Less(i, j int) bool { return a[i].Age < a[j].Age }
func (a byAge) Swap(i, j int)      { a[i], a[j] = a[j], a[i] }
```

### Why `slices.Sort` Is Faster

Both `slices.Sort` and `sort.Slice` run pdqsort. The algorithm is identical. The difference is entirely in how they touch your data.

`sort.Slice` takes a `less` function over **indices** and must swap elements it knows nothing about, so it builds a swapper using reflection (`reflectlite.Swapper`). Every comparison is an indirect call through a function value, and every swap goes through that reflective swapper.

`slices.Sort` is generic. The element type is known at compile time, so the swap is a direct assignment of a known type and the comparison for ordered types can be inlined into the sort's inner loop. No reflection, no per-comparison indirect call.

The measured difference on one machine (Go 1.27.1, linux/amd64, 10,000 random `int`s, `go test -bench`):

```
BenchmarkSlicesSort-8          576383 ns/op
BenchmarkSortSlice-8           996109 ns/op
BenchmarkSortSliceStable-8    2368468 ns/op
```

`sort.Slice` costs about 1.7x `slices.Sort`, and `sort.SliceStable` about 4.1x. Treat these as representative of the shape, not as universal constants: the gap depends on element size, comparison cost, and machine. A slice of large structs with an expensive comparison narrows the relative gap because the comparison dominates. What does not change is the direction, and it is the same on every machine and every recent version, because it follows from reflection versus monomorphisation rather than from tuning.

### The Decision Table

| You have | Use |
|----------|-----|
| Slice of ordered type (int, string, float) | `slices.Sort` |
| Slice of structs, order fully determined | `slices.SortFunc` |
| Slice of structs, ties must keep input order | `slices.SortStableFunc` |
| Something that is not a slice | `sort.Sort` with `sort.Interface` |
| Legacy code already using `sort.Slice` | leave it unless it is hot |

### `sort.Search` and Sorted Invariants

Sorting exists to enable something, and usually that something is search. `sort.Search` and `slices.BinarySearch` both require sorted input and both silently return nonsense if that precondition is violated. There is no panic and no error.

```go
// slices.BinarySearch: for the common case.
i, found := slices.BinarySearch(nums, target)

// sort.Search: for any monotone predicate. See Chapter 77.
i := sort.Search(len(nums), func(i int) bool { return nums[i] >= target })
```

The precondition is a real hazard in a large codebase, because "this slice is sorted" is an invariant that lives in a comment or in nobody's head at all. When a function receives a slice it did not sort itself and binary searches it, that contract deserves to be in the signature or the doc comment, and in debug builds a `slices.IsSorted` assertion costs O(n) and buys certainty.

### Junior -> FAANG: The Question With a Precise Answer

"Why is `slices.Sort` faster than `sort.Slice` if they use the same algorithm?" is a Go interview question with an exact answer, and it is one of the highest-value facts in this chapter.

The answer: `sort.Slice` uses reflection for swaps and an indirect call per comparison, because it only receives a `less` function over indices and has no static knowledge of the element type. `slices.Sort` is generic, so the compiler knows the type, the swap is a direct move, and the comparison inlines. Same pdqsort, different overhead per operation. On this machine it is roughly 1.7x on 10k ints.

The follow-up habit: for new code sorting a plain slice, `slices.Sort` or `slices.SortFunc` is the default. Reaching for `sort.Slice` in 2026 is a mild code smell unless there is a reason.

### Senior @ FAANG: Migration Without Churn

`sort.Slice` appears in essentially every Go codebase written before 1.21, and a blanket migration is not automatically worth it. A sort of 20 elements on a cold path is not where your latency is, and the diff has a real review cost and a nonzero chance of introducing a comparison bug during translation from `less` to three-way compare.

The rule worth adopting: new code uses `slices` - existing `sort.Slice` migrates when it shows up in a profile or when the surrounding code is being touched anyway. That is opportunistic migration, and it is how you retire an old API across a large codebase without a flag day.

The one migration that is always worth doing on sight is `sort.SliceStable` where the comparison already yields a total order. At 4x the cost of `slices.Sort` in the benchmark above, you are paying substantially for a guarantee the comparison already provides. That is a mechanical win with no behaviour change, and it is exactly the kind of thing a `gopls` modernizer or a custom `go/analysis` pass, per Chapter 7B, can find for you across the whole repo.
