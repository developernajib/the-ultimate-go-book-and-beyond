## Complexity Comparison (30 seconds)
"Both are O(n log n) time.
- Two arrays: O(n) space for arrays
- Heap: O(n) worst case, but typically less

Heap is more intuitive. Two arrays is clever optimization."

---

### Junior → FAANG: Complexity Comparison as a Decision Signal

The statement "heap is more intuitive, two arrays is clever optimization" is useful as a starting position, but do not repeat it verbatim without context. "More intuitive" is subjective and interviewers sometimes push back. A more precise statement: "The heap approach directly models the room assignment process (pop the earliest-ending room, push the new meeting's end time). The two-array approach exploits the observation that you only need the count, not the assignment, so you can sort starts and ends independently. Both are O(n log n) time and O(n) space, and the two-array approach has a smaller constant factor."

When asked to compare two approaches in an interview, always structure the comparison as: same or different complexity, same or different correctness, practical performance difference, and which to prefer given the problem's requirements. This structure takes 30 seconds and is more useful than "both are O(n log n)."

### Senior @ FAANG: Constant-Factor Complexity and Cache Performance

Both approaches are O(n log n), but the two-array approach tends to win on constant factors. Its sweep walks two sorted arrays front to back, which is the access pattern hardware prefetchers are built for. Sift-up and sift-down instead jump between indices `i`, `2i+1`, and `(i-1)/2`, and once the heap outgrows cache those jumps become misses. Resist quoting a specific multiplier for this. The gap depends on n, element size, and the machine, and the only honest number is the one your own benchmark prints.

At the staff level, benchmarking both approaches on realistic inputs and documenting the results is part of the algorithm selection process. In Go, `testing.B` benchmarks provide this data. A staff engineer presenting the two-array approach to a scheduling system team would include a benchmark showing: input size, two-array throughput, heap throughput, and the n threshold where heap's O(1) average pop becomes relevant compared to two-array's O(1) array access. This data-driven approach to constant-factor analysis is the L6 standard.

Memory allocation is also a concern, and it is worth naming the actual cause rather than the folklore one. An `IntHeap` is a `[]int`, which contains no pointers, so the GC does not scan its elements at all. The allocation comes from somewhere else: `container/heap`'s API is `Push(x any)`, so every value crossing that boundary is boxed into an interface, and boxing an `int` that the runtime does not have a cached static for means an allocation per push. Benchmark it and the effect is unmissable. Pushing 16 large ints costs 18 allocations, while pushing 16 values below 256 costs 2, because the runtime keeps preallocated boxes for small integers and hands those out instead.

This is a good thing to know precisely, because the mitigation follows from the cause. `make(IntHeap, 0, n)` removes the slice regrowth but not the boxing, since the boxing is the interface conversion and has nothing to do with capacity. Avoiding `container/heap` in favour of a hand-written typed heap, or avoiding the heap entirely as the two-array approach does, is what removes it. For a latency-sensitive service this is a real reason to prefer the two-array sweep, though it is a constant-factor argument and deserves a benchmark rather than an assertion.

### Question 4: "Why does greedy fail for the 0/1 knapsack problem?"

**What Interviewers Look For:**
- Understanding of problem structure
- Ability to construct counterexamples
- Comparison with fractional knapsack
- When greedy choice property fails

**Strong Answer Framework:**

This question is really asking whether you can locate the exact hinge the proof turns on. Contrast the two knapsack variants, produce a counterexample, name the property that fails, then give the DP. The sections that follow do each in turn.

| Move | Budget | The point |
|------|--------|-----------|
| Fractional vs 0/1 | 30 seconds | Divisible items versus all-or-nothing |
| Counterexample | 45 seconds | A concrete instance where ratio-greedy loses |
| Why the property fails | 45 seconds | Taking an item is irrevocable and can strand capacity |
| DP solution | 30 seconds | The recurrence and its complexity |

Lead with the counterexample if you are short on time. "Greedy fails because the greedy choice property does not hold" is circular, and interviewers hear it constantly. A specific instance where ratio-greedy loses settles the question in one breath and cannot be argued with.
