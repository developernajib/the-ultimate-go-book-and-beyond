## 75.10 Interview Tips

### Greedy Pattern Recognition

Recognizing when a problem is greedy-solvable is a crucial interview skill. Certain keywords in the problem statement are strong hints: "maximum number of," "minimum number of," "earliest," and "non-overlapping" often point to greedy. Before coding, you should verify that the greedy choice property holds by trying the exchange argument: if you swap any non-greedy choice for the greedy one, the solution should not get worse. If you can find a counterexample where greedy fails, switch to dynamic programming instead.

```
┌─────────────────────────────────────────────────────────────────┐
│              WHEN TO USE GREEDY                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Keywords indicating greedy might work:                         │
│  • "Maximum/Minimum number of..."                               │
│  • "Earliest/Latest..."                                         │
│  • "Non-overlapping..."                                         │
│  • "Optimal ordering/scheduling..."                             │
│                                                                 │
│  Common greedy strategies:                                      │
│  • Sort by end time (interval problems)                         │
│  • Sort by ratio (fractional optimization)                      │
│  • Two-pass (candy, trapping rain water)                        │
│  • Always pick locally best option                              │
│                                                                 │
│  Verify greedy works by:                                        │
│  1. Greedy choice property: local optimal → global optimal      │
│  2. Optimal substructure: optimal has optimal subproblems       │
│  3. Try counterexamples                                         │
│                                                                 │
│  Common mistakes:                                               │
│  • Assuming greedy works without proof                          │
│  • Wrong sorting criteria                                       │
│  • Not handling edge cases                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Complexity Summary

The table below summarizes the time complexity and greedy strategy for each major problem covered in this chapter. Notice that most greedy algorithms run in O(n log n) due to an initial sort, with the greedy scan itself being O(n). Problems that avoid sorting entirely (like Jump Game and Gas Station) achieve pure O(n) runtime because they exploit the natural left-to-right ordering of the input.

| Problem | Strategy | Time |
|---------|----------|------|
| Activity Selection | Sort by end time | O(n log n) |
| Meeting Rooms II | Sort + heap | O(n log n) |
| Jump Game | Track max reach | O(n) |
| Candy | Two-pass | O(n) |
| Gas Station | One pass with reset | O(n) |
| Task Scheduler | Math formula | O(n) |
| Huffman Coding | Priority queue | O(n log n) |

### Junior → FAANG: Using Pattern Recognition Without Becoming Pattern-Dependent

The keyword list and complexity table in this section are useful as starting points, but they can become a crutch. Interviewers at FAANG are aware that candidates memorize keyword patterns, so they often phrase greedy problems without the telltale keywords. "Find the minimum number of platforms required for a railway station" does not use "non-overlapping" or "earliest" but is structurally identical to Meeting Rooms II.

Build the habit of extracting the underlying structure, not just scanning for keywords. Ask: what is the optimization goal? What are the constraints? Can I make a locally optimal choice without information about future elements? If the answer to the last question is yes and you can state why, greedy is likely correct.

For complexity, the table above is the right mental reference. Most greedy problems are O(n log n) because of an initial sort. The O(n) entries (Jump Game, Candy, Gas Station, Task Scheduler) avoid the sort for one of two reasons: either the array's existing left-to-right order is the order the algorithm needs (Jump Game, Candy, Gas Station), or the answer comes from counting rather than ordering (Task Scheduler, whose frequency table is a fixed 26 buckets). Recognizing which case you are in tells you the complexity before you write a line.

### Senior @ FAANG: Pattern Libraries and Greedy Algorithm Governance

At the platform level, pattern recognition is formalized into algorithm libraries with documented applicability conditions. A staff engineer does not rely on keyword matching: they maintain a decision tree that maps problem characteristics (objective type, constraint type, input structure) to algorithm families, with correctness conditions explicitly stated for each.

**Algorithm libraries in large codebases.** A well-run internal algorithm library ships the applicability contract next to the implementation, not just the implementation. For a greedy interval scheduler, the contract might be: "Input intervals must have integer endpoints. Intervals must be non-degenerate (start < end). The algorithm is correct for the activity selection objective but not for the weighted interval scheduling objective. For weighted intervals, use the DP variant in the same package." This contract is enforced by the type system where possible (accepting `Interval` not `[]int`) and by documentation where not.

**Complexity as a system property.** The complexity table above describes algorithmic complexity, but production systems have additional complexity dimensions: network round trips, database query counts, cache miss rates, and garbage collection pressure. A staff engineer reviewing a greedy algorithm for production deployment asks: is the O(n log n) sort dominated by the O(1) cache lookups in the main loop? If the sort is over network-fetched data, the network latency dominates and the algorithmic complexity is irrelevant. The correct analysis level depends on which cost is dominant in the actual system, not in the theoretical model.

**Greedy pattern governance.** When a new greedy algorithm is proposed for a shared infrastructure component, the review process at staff level includes: (1) a formal statement of the greedy choice property with a proof sketch or citation, (2) a counterexample test that would catch a correctness regression if the algorithm is modified, (3) a performance benchmark showing the sort cost relative to the main loop cost on realistic input sizes, and (4) documentation of the input invariants that must be maintained by callers. This governance prevents the common failure mode where a correct greedy algorithm becomes incorrect after a seemingly minor input format change.
