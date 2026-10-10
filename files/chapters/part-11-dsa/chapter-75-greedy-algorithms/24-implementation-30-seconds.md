## Implementation (30 seconds)

```go
func maxActivities(activities [][]int) int {
    // Required: count starts at 1 and lastEnd reads activities[0],
    // so an empty input would panic without this guard.
    if len(activities) == 0 {
        return 0
    }

    slices.SortFunc(activities, func(a, b []int) int {
        return cmp.Compare(a[1], b[1])
    })

    count := 1
    lastEnd := activities[0][1]

    for i := 1; i < len(activities); i++ {
        // >= means back-to-back activities are compatible: one may start
        // exactly when the previous ends.
        if activities[i][0] >= lastEnd {
            count++
            lastEnd = activities[i][1]
        }
    }
    return count
}
```
Time: O(n log n) for sorting, O(n) for selection.
Space: O(log n) for the sort's stack, sorting the input in place."

### Junior → FAANG: Writing Clean Greedy Code in 30 Seconds

The 8-line activity selection implementation is the ideal: a single sort, a single scan, a single running variable (`lastEnd`), and a clear condition. This is what clean greedy code looks like. If your implementation is significantly longer than 8 lines for this problem, you are probably overcomplicating it.

Habits for writing clean greedy code in interviews: initialize running variables before the loop (not inside it), use the most descriptive variable names available (`lastEnd` not `prev` or `e`), and avoid nested loops (greedy algorithms are almost always O(n) after the sort, with no nested scanning). If you find yourself writing a nested loop, stop and reconsider whether you have the right algorithm.

The space question is a useful interview talking point, and worth getting exactly right rather than roughly right. "O(1)" is the common answer and it is slightly wrong: sorting in place still costs O(log n) stack for the recursion. Offer the interviewer the trade-off explicitly: "Sorting in place gives O(log n) auxiliary space. If the caller's slice must be preserved, I would clone it first, which makes it O(n)." Note also that the guard against empty input is not decoration. `count := 1` presumes an activity exists, and `activities[0][1]` reads one, so the function has already assumed a non-empty input twice before the loop starts.

### Senior @ FAANG: Implementation Quality as a Code Review Standard

At the staff level, implementation quality is evaluated not just on correctness but on readability, testability, and maintainability. The 8-line activity selection is readable. Adding a comment explaining the greedy choice (not what the code does, but why the sort criterion is correct) makes it maintainable. Adding a test with the canonical counterexample makes it resilient to future modification.

In a production codebase, this function would be accompanied by: a package-level comment explaining what problem it solves, a function-level comment explaining the greedy choice property and its preconditions, a table-driven test with at least one of each case (empty input, single activity, all overlapping, all disjoint, the activity that would be chosen by a wrong sort criterion but not the right one), and a benchmark that validates the O(n log n) complexity on inputs of size 10^4 and 10^5.

Writing these accompaniments is not overhead: it is what makes the difference between code that works once and code that stays correct as the system evolves. Staff engineers hold this standard in code reviews by asking: "Does this PR include the counterexample test? Does the comment explain why this sort criterion is correct?" The counterexample test earns its place specifically because it fails loudly if someone later 'simplifies' the sort key, which is the one change most likely to look harmless and be fatal.
