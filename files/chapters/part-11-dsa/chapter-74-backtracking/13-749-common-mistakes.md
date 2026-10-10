## 74.11 Common Mistakes

### Mistake 1: Not Making Copy for Results

In Go, appending a slice to a `[][]int` result stores the slice header, not a snapshot of the underlying data. The backtracking then keeps writing through that shared array, and the stored "results" change underneath you.

What it actually produces is worth seeing, because the folklore version of this bug ("every entry comes out identical") is wrong, and the truth is nastier. Running `subsetsBad([]int{1, 2, 3})` gives:

```
[[] [1] [1 2] [3 3 3] [3 3] [3] [3 3] [3]]
```

against the correct `[[] [1] [1 2] [1 2 3] [1 3] [2] [2 3] [3]]`. Look at what happened. The first three entries are perfectly correct. The rest are garbage, and not even uniform garbage. The reason is capacity: `append` allocates a new backing array when it outgrows the old one, so early entries got frozen onto arrays that were later abandoned, while everything after the last reallocation shares one array that ends up holding `3`s. The entry count is right, the lengths are right, and the corruption starts partway through.

That is the real danger. A bug that made every entry identical would be caught by the first glance at the output. This one hands back a result whose beginning looks correct, so a spot check of `result[0]` and `result[1]` passes, and it is capacity-dependent, so it can behave differently on a bigger input. There is no partial credit for the first three subsets.

```go
// ❌ BAD: Storing reference to mutable slice
func subsetsBad(nums []int) [][]int {
    var results [][]int
    var current []int

    var backtrack func(int)
    backtrack = func(start int) {
        results = append(results, current)  // Wrong: stores reference!

        for i := start; i < len(nums); i++ {
            current = append(current, nums[i])
            backtrack(i + 1)
            current = current[:len(current)-1]
        }
    }

    backtrack(0)
    // Entries written since the last append() reallocation all alias one
    // array, so they read back as whatever the path held at the end.
    return results
}

// ✅ GOOD: Make a copy
func subsetsGoodFixed(nums []int) [][]int {
    var results [][]int
    var current []int

    var backtrack func(int)
    backtrack = func(start int) {
        // Make a copy!
        temp := make([]int, len(current))
        copy(temp, current)
        results = append(results, temp)

        for i := start; i < len(nums); i++ {
            current = append(current, nums[i])
            backtrack(i + 1)
            current = current[:len(current)-1]
        }
    }

    backtrack(0)
    return results
}
```

### Junior → FAANG: The One Mistake That Kills Most Backtracking Solutions

The slice-reference bug documented above is the single most common reason a backtracking solution produces wrong output in an interview. The symptom is *not* always the same, which is why it survives casual checking: you may see repeated identical slices, or a result whose first few entries are right and whose tail is nonsense, depending on where `append` happened to reallocate. The fix is always the same: copy before storing.

Develop the copy discipline as a non-negotiable reflex. Every time you write `result = append(result, path)`, immediately ask: "am I copying or referencing?" The answer should always be "copying," which means rewriting as `result = append(result, append([]int{}, path...))` or using `copy(dst, src)` with a pre-allocated destination.

A useful self-test: after writing a backtracking solution, print the whole result for a 3-element input and compare it against what you worked out by hand. Do not spot-check the first entry, since that is exactly the one most likely to be accidentally correct. The airtight check is to compare against a known-good expected list, or to count distinct backing arrays: if two entries with nonzero length share `&entry[0]`, a copy is missing.

The `append([]int{}, path...)` pattern is idiomatic Go and should be recognized immediately by interviewers. If you use `copy` instead, make sure to allocate the destination with `make([]int, len(path))` first. `copy` into a nil or zero-length slice copies nothing and produces a silent bug.

### Senior @ FAANG: Systematic Prevention in Production Code

The slice reference mistake is not just an interview pitfall. It is a class of bugs called "aliasing bugs" that appear in production Go code whenever slices or maps are stored by reference rather than by value. The principle applies beyond backtracking: any function that returns a slice from an internal data structure must document whether the returned slice is a live view into the internal structure or a snapshot copy.

A production Go library that returns a live view allows callers to accidentally mutate internal state, which is a correctness and thread-safety risk. The Go convention for functions that must return snapshots is to document "the returned slice is a copy and safe to modify" or "the returned slice shares memory with the receiver." The `append([]int{}, source...)` pattern is the idiomatic way to create the copy.

For backtracking systems that are performance-critical (e.g., puzzle generators that must produce millions of solutions per second), the copy overhead can be reduced by using a pool of pre-allocated slices (`sync.Pool`) and returning them to the pool after the caller is done. This eliminates GC pressure from millions of small slice allocations while maintaining correct ownership semantics. The trade-off is that callers must explicitly return slices to the pool, which requires a disciplined API design (usually a callback interface rather than returning a slice).

### Junior → FAANG: The Slice Reference Bug as a Self-Test

The slice reference bug is so common that it is worth having a dedicated self-test for it. After implementing any backtracking function, run this test manually: create an input with at least 3 elements, run your function, and print each element of the result slice separately. If any two result elements are identical when they should not be, you have the slice reference bug.

In Go, you can also detect the bug by printing the pointer to the underlying array for each result element. If two results share the same array pointer, the copy is missing. Guard the index, because `&result[i][0]` panics on a zero-length entry, and in any subsets problem `result[0]` is the empty subset:

```go
for i, r := range result {
    if len(r) == 0 {
        continue // empty subset has no element to point at
    }
    fmt.Printf("%d: %v backing=%p\n", i, r, &r[0])
}
```

The fix is always the same: wherever you write `result = append(result, path)`, change it to `result = append(result, append([]int{}, path...))`. For string results, strings in Go are immutable, so the bug does not apply. For byte slice results, the same copy discipline applies.

### Senior @ FAANG: Aliasing Bugs as a Class of Production Correctness Issues

The slice reference bug is a specific instance of the aliasing bug class that appears throughout production Go code. Beyond backtracking, aliasing bugs occur when: a cache returns a live reference to its internal state (callers that modify the returned slice corrupt the cache), a concurrent reader and writer share a map without synchronization (data race), or a function returns a sub-slice of a larger array (modifications to the sub-slice affect the original).

The production mitigation is a convention that all functions returning slices must document whether the returned slice is a live view or a snapshot copy. Adopting this convention as a team standard, enforced by code review and occasionally by static analysis (tools like `go-critic` detect some aliasing patterns), prevents a class of correctness bugs that are difficult to reproduce and diagnose in production because they depend on the exact order of operations.

For high-performance backtracking systems, the `sync.Pool` approach is worth investing in when profiling shows that GC pauses from slice allocations are contributing to latency. The pool allocation pattern requires a callback-style API: instead of `results [][]int`, the function signature becomes `func(path []int)` called for each result. The pool provides the path slice, the callback processes it, and the slice is returned to the pool after the callback returns. This zero-copy result delivery is the pattern used in high-throughput event processing systems.

---
