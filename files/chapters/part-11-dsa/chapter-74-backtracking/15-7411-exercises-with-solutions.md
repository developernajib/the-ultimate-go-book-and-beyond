## 74.13 Exercises with Solutions

### Exercise 1: Combination Sum

Combination Sum (LeetCode 39) allows reusing candidates, so the recursive call passes `i` (not `i+1`) as the next start index. This permits picking the same element multiple times while still preventing out-of-order duplicates. Pruning happens by checking `candidates[i] <= remaining` before recursing: a candidate bigger than what is left cannot appear in this branch, so it is skipped.

Note that this skips only that one candidate and makes no assumption about ordering, which is why the function is correct on unsorted input: `combinationSum([]int{7, 3, 2}, 7)` returns `[7]` and `[3 2 2]` just fine. The stronger move, sorting first and replacing the skip with a `break`, is a separate upgrade, and the two go together or not at all. A `break` on unsorted candidates would abandon the whole rest of the list because of one large element that happened to be first. The result is collected only when `remaining` reaches exactly zero, guaranteeing every recorded combination sums to the target.

```go
func combinationSum(candidates []int, target int) [][]int {
    var results [][]int
    var current []int

    var backtrack func(start, remaining int)
    backtrack = func(start, remaining int) {
        if remaining == 0 {
            temp := make([]int, len(current))
            copy(temp, current)
            results = append(results, temp)
            return
        }

        for i := start; i < len(candidates); i++ {
            if candidates[i] <= remaining {
                current = append(current, candidates[i])
                backtrack(i, remaining-candidates[i])
                current = current[:len(current)-1]
            }
        }
    }

    backtrack(0, target)
    return results
}
```

### Junior → FAANG: Combination Sum as the Template Exercise

The combination sum solution above is the cleanest possible expression of the backtracking template for "enumeration with reuse." Study this solution until you can reproduce it from memory in under 5 minutes:

1. Variable-size result (collect when remaining == 0).
2. Start-index parameter to avoid order-duplicates.
3. Pass `i` (not `i+1`) to allow element reuse.
4. `if candidates[i] <= remaining` before recursing (prune over-budget choices).
5. Copy before appending to result.

Each of these five points corresponds to a common mistake that trips up candidates. The start-index parameter prevents [3,2] and [2,3] from both appearing as results. The `i` vs `i+1` distinction enables reuse. The <= check prevents exploring branches that cannot lead to a valid solution.

A useful follow-up to practice: after implementing this, convert it to Combination Sum II (each number used once, no duplicates in result). This requires three changes: sort the candidates, change the recursive call from `backtrack(i, ...)` to `backtrack(i+1, ...)`, and add the duplicate-sibling guard `if i > start && candidates[i] == candidates[i-1] { continue }`. Practicing the conversion between these two variants builds the habit of recognizing which constraints to apply.

### Senior @ FAANG: Combination Sum as a Code Quality Benchmark

The combination sum implementation is a good benchmark for code quality reviews. A senior engineer's version should include: a guard for empty candidates (return nil or error immediately), sorted candidates to enable the `break` optimization (not just `continue`), and a function signature that returns `([][]int, error)` in production code (not just `[][]int`).

The sorted-and-break optimization deserves emphasis, and so does its precondition. If candidates are sorted and `candidates[i] > remaining`, then every candidate from index i onward is also too large, so `break` exits the loop instead of testing each one, cutting the inner loop from O(n) to O(k) where k is the number of candidates that fit. As `remaining` shrinks deep in the tree, k drops toward zero and the saving compounds across every node.

The precondition is load-bearing and is the thing to say out loud: the `break` is a wrong-answer bug without the sort, not merely a slower one. On `[7, 3, 2]` with target 7 it would quit at the 7 and never find `[3, 2, 2]`.

Production enumeration functions like this should also accept a context parameter (`ctx context.Context`) to enable cancellation. If the search is running in a goroutine and the caller times out or cancels the request, the backtracking should check `ctx.Err() != nil` periodically and return early. Without this, a long-running backtracking search holds resources indefinitely and cannot be canceled without killing the goroutine.

### Junior → FAANG: Combination Sum as the Template Certification Problem

After studying the backtracking template, implement combination sum from memory without looking at any reference. If you can produce a correct, pruned solution in under 10 minutes, you have certified your template knowledge. If you cannot, identify exactly which step failed (base case condition? copy discipline? start index? pruning condition?) and practice that step in isolation before trying again.

The five properties of a correct combination sum implementation (listed in the junior section above: variable-size result, start-index parameter, i not i+1 for reuse, <= check for pruning, copy before appending) are a certification checklist. Review your implementation against all five before calling it complete. A correct implementation that passes the checklist is the foundation for all more complex backtracking problems.

One useful extension: after implementing the basic version, implement the `break` optimization by sorting the candidates first. Measure the speedup for a large input (candidates = [1, 2, 5, 10, 20, 50], target = 100). The `break` optimization reduces the inner loop iterations dramatically for large targets by exiting early when the remaining budget is small.

### Senior @ FAANG: Context-Aware Backtracking as a Production Interface Standard

The `context.Context` extension mentioned in the senior section above deserves a full treatment as a production interface standard. Every production backtracking function should have this signature pattern:

```go
func FindCombinations(ctx context.Context, candidates []int, target int) ([][]int, error)
```

The function returns early with `ctx.Err()` as the error when the context is canceled, and returns the full result with `nil` error on success. The implementation checks `ctx.Err()` at the top of each recursive call rather than inside the inner loop. That means one atomic load per search-tree node, which is cheap next to the work each node already does, and it bounds cancellation latency to a single node's work rather than to the whole search. Checking inside the inner loop instead buys nothing and puts a load in the hottest path in the function.

This interface design makes the backtracking function safe to call from HTTP handlers, gRPC service methods, and any other context-aware caller. It also makes the function testable with context cancellation: use `context.WithTimeout` in the test to verify that the function returns promptly when the deadline expires, without blocking indefinitely.

---
