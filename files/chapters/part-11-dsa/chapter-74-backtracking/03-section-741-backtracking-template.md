## 74.1 Backtracking Template

Backtracking is a systematic search strategy that builds a solution incrementally, abandoning a partial solution ("pruning") as soon as it violates the constraints. The generic template maintains a mutable path, iterates over available choices at each recursion level, and reverses each choice after the recursive call to restore state. This undo step is what distinguishes backtracking from plain DFS.

```go
package backtracking

// General backtracking template
//
// func backtrack(path, choices) {
//     if isComplete(path) {
//         addToResult(path)
//         return
//     }
//
//     for choice in choices {
//         if isValid(choice) {
//             makeChoice(path, choice)
//             backtrack(path, remainingChoices)
//             undoChoice(path, choice)  // backtrack
//         }
//     }
// }

// BacktrackTemplate demonstrates the general structure
func BacktrackTemplate(nums []int) [][]int {
    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        // Base case: when to add to result
        // (varies by problem)
        result = append(result, append([]int{}, path...))

        // Try each choice
        for i := start; i < len(nums); i++ {
            // Make choice
            path = append(path, nums[i])

            // Recurse
            backtrack(i + 1)

            // Undo choice (backtrack)
            path = path[:len(path)-1]
        }
    }

    backtrack(0)
    return result
}
```

### Junior → FAANG: Memorizing the Template Deeply

The template above has four mandatory components: the base case (when to collect the result), the loop over choices, the make-choice step, and the unmake-choice step. A fifth implicit component is the copy-when-collecting step, which appears inside the base case for slice results.

The template should be your starting point for every backtracking problem. Write it out before adapting it. The adaptation consists of three decisions: what is the base case condition (path length equals target, start index equals array length, sum reaches target, all cells filled)? What are the choices (iterate from `start`, iterate all indices with `used[]`, iterate digits 1-9)? What is the pruning condition (candidate exceeds remaining, duplicate sibling, constraint violation)?

Go-specific template detail: the closure `backtrack = func(start int) { ... }` captures `result` and `path` from the enclosing scope. This is idiomatic Go for recursive backtracking and avoids parameter passing overhead. The `var backtrack func(start int)` declaration on a separate line from the assignment is required because the function body references itself.

A common confusion: `append([]int{}, path...)` creates a new slice with the same length and contents as `path`. This is the correct copy pattern. `path[:]` does not copy. It creates a new slice header pointing at the same underlying array, which is exactly the bug you were trying to avoid, wearing a disguise.

### Senior @ FAANG: Template Generalization and Production Adaptation

The generic template above adapts to production contexts in predictable ways. For enumeration-only backtracking (N-Queens, Sudoku), the result is collected at the base case and the function returns void. For search backtracking (word search, finding any valid assignment), the function returns a boolean and short-circuits on the first success. For optimization backtracking (finding the maximum-value subset satisfying a constraint), the result collection is replaced by a comparison against the current best.

A production concern not visible in the template: the `path` slice is shared across all recursive calls via closure capture. If the backtracking is parallelized across goroutines (e.g., exploring different starting points in parallel for a large grid), each goroutine needs its own copy of `path`. Forgetting this produces data races that are difficult to reproduce because they depend on goroutine scheduling. Before adding concurrency to a backtracking implementation, verify that all mutable state is either goroutine-local or properly synchronized.

The template also assumes that the choices at each level are independent of each other given the current state. This assumption breaks down for problems with global constraints that span multiple levels (e.g., "the total sum of all chosen elements must be exactly k across all levels of the tree, not just at the current level"). For such problems, the constraint must be passed as a parameter rather than computed locally, and pruning must consider the constraint globally, which is a common source of bugs when adapting the template.

### Junior → FAANG: The Template as a Muscle Memory Drill

The backtracking template has exactly three moving parts: the base case, the for loop over choices, and the make/recurse/unmake triple. Memorize the Go-specific implementation of all three, and practice writing them without looking at this file. The goal is 2 minutes from blank page to a correct template in Go. Time yourself.

The `var backtrack func(start int)` declaration pattern is Go-specific and required. You must declare the variable before defining it because the function body references itself. If you write `backtrack := func(start int) { ... }` and call `backtrack(...)` inside the body, Go will give you a "undefined: backtrack" compile error. The two-step pattern (declare, then assign) is the correct idiom.

The `append([]int{}, path...)` copy pattern is your safety net. Every time you add to the result, write this expression. Never write `result = append(result, path)` directly. If you forget this rule once in an interview and the interviewer asks why all your results are the same, it will take 5 minutes to diagnose the bug. If you have the copy as a reflex, the bug never occurs.

### Senior @ FAANG: Template Correctness Under Concurrent Extension

The production version of the backtracking template requires two extensions that the interview version omits. First, context cancellation: the backtrack function should accept a `context.Context` and check `ctx.Err() != nil` at the top of each call. When the context is canceled (client timeout, explicit cancellation), the function returns immediately with the best partial result accumulated so far. This prevents goroutine leaks in web service contexts.

Second, result channel instead of result slice: for large result sets (e.g., all permutations of n=12 elements), materializing all 479 million results in a slice before returning is impractical. Instead, pass a result channel and send each found result on the channel. The caller can process results as they arrive and cancel the context when it has seen enough. This transforms the backtracking function from a batch operation to a streaming generator, enabling the caller to implement early termination, pagination, and per-result processing without buffering the full result set.

Both extensions require changing the function signature, which means they should be designed upfront rather than retrofitted. The ADR for any production backtracking system should specify whether the system uses batch or streaming semantics and document the rationale.
