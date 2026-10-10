## Edge Cases
"Empty input, single activity, all overlapping, none overlapping."

---

### Junior → FAANG: Building a Complete Edge Case Checklist

"Empty input, single activity, all overlapping, none overlapping" is a good starting list, but not complete for activity selection. Add two more: (1) activities with the same end time (which one is chosen? the sort is stable in Go if you use `slices.SortStableFunc`, but `sort.Slice` is not stable). (2) Activities where the greedy second choice has the same start time as the first choice's end time (boundary case for `>=` versus `>`).

Build a general edge case checklist for all greedy problems: empty input, single element, all elements identical, minimum and maximum element values, the case where greedy picks the globally wrong element but is saved by a later choice, and the case where the problem is trivially solvable (n=1 always returns 1).

In Go specifically, test with nil slices (not just empty slices). `var activities [][]int` is nil, and `len(activities) == 0` is true for both nil and empty slices. The function should handle both correctly.

### Senior @ FAANG: Edge Cases as Specification Gaps

At the staff level, edge cases are not just testing concerns. They are specification gaps that need to be resolved before implementation, not after. The question "what happens when two activities have the same end time?" is a specification question, and the answer determines the algorithm's behavior on a valid class of inputs.

If the specification is "any valid selection is acceptable when there are ties," the implementation can use any stable or unstable sort. If the specification is "among all optimal selections, return the one that selects activities with the smallest index in the original array when there is a tie," the implementation must use a stable sort with a secondary comparator. Getting the specification right upfront saves a production bug report three months later when a user inputs activities with identical end times.

Staff engineers formalize edge case handling in the API contract, not just in the tests. The contract for activity selection in a production library might state: "When multiple optimal selections exist, the algorithm returns the lexicographically smallest set of indices. This behavior is guaranteed by the stable sort on end time with index as a tiebreaker." This makes the edge case behavior explicit, versioned, and verifiable.

### Question 2: "How do you decide when to use greedy vs dynamic programming?"

**What Interviewers Look For:**
- Deep understanding of both paradigms
- Ability to analyze problem structure
- Practical decision-making
- Examples

**Strong Answer Framework:**

Answer this one in four moves. State the difference between the two paradigms, give the questions you actually ask yourself, ground it in examples on both sides of the line, and finish with how you handle the case where you cannot tell. The sections that follow work through each move.

| Move | Budget | The point |
|------|--------|-----------|
| Key difference | 30 seconds | Both need optimal substructure. Only greedy needs the greedy choice property |
| Decision framework | 60 seconds | The questions that separate the two cases |
| Concrete examples | 45 seconds | Problems where greedy works, and the near-identical ones where it does not |
| Interview strategy | 30 seconds | What to do when you cannot decide in the time available |

The last move is the one candidates skip, and it is the most revealing. "Try greedy, fail to prove it, fall back to DP" is a legitimate strategy, and saying so is more convincing than pretending you always know on sight.
