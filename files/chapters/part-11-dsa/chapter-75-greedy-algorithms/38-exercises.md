## Exercises

### Exercise 1: Queue Reconstruction by Height
Reconstruct queue based on height and count of taller people in front.

### Exercise 2: Reorganize String
Rearrange string so no two adjacent characters are same.

### Exercise 3: Boats to Save People
Find minimum boats to carry people (boat capacity 2, weight limit).

### Exercise 4: Maximum Units on a Truck
Load truck with boxes to maximize units (limited truck size).

---

### Junior → FAANG: Approaching Exercise Sets Strategically

These four exercises span the key greedy sub-patterns: queue reconstruction (greedy insertion), string reorganization (max-heap greedy), two-pointer greedy (boats), and ratio-based greedy (truck units). Working through all four in sequence builds pattern coverage faster than working through ten problems of the same type.

For Queue Reconstruction specifically, the approach is to sort by height descending and, for people of equal height, by k ascending, then insert each person at index k. Do not skip the tie-break: it is not a detail, it is load-bearing. Among people of the same height, everyone already placed counts toward each other's k, so inserting the smaller k first is what keeps the index meaningful. Sort ties the other way and the reconstruction is wrong.

Trace it by hand before coding. Sorting `[[7,0],[4,4],[7,1],[5,0],[6,1],[5,2]]` gives the order `[7,0],[7,1],[6,1],[5,0],[5,2],[4,4]`, and inserting each at its k yields the answer. The invariant that makes insertion-at-k correct: everyone already in the list is at least as tall as the person being inserted, so all of them are exactly the people who count toward that person's k, and index k is precisely where they belong. Shorter people inserted later never disturb the count, because they are invisible to it.

For Reorganize String, understand when the answer is impossible: if any character appears more than `(n+1)/2` times, it cannot be placed without adjacent duplicates. This is a necessary and sufficient condition. If you forget this check, your heap-based solution will produce an incorrect result or an infinite loop on impossible inputs.

### Senior @ FAANG: Exercise Design as a Team Investment

Exercise sets like this one are not just interview preparation tools. They are the raw material for team onboarding curricula, coding interview rubrics, and algorithmic competency assessments. A staff engineer designing an onboarding program for a scheduling team would select these four exercises with specific learning objectives for each.

Queue Reconstruction teaches: greedy insertion order, the invariant that makes insertion-at-k correct, and the O(n^2) cost of repeated list insertions. The staff engineer would pair this exercise with a follow-up discussion of how to reduce the insertion cost to O(n log n) using a Fenwick tree, and when that optimization matters in production (n > 10^5 with tight latency requirements).

Boats to Save People teaches: two-pointer greedy, the exchange argument for pairing the heaviest with the lightest, and the correctness proof. The staff engineer would extend this to: how does the algorithm change if the boat capacity is variable per boat? (It becomes a matching problem, no longer solvable with the simple greedy.) This extension tests whether engineers understand the greedy choice property or just memorized the two-pointer pattern.

The goal of these exercises in a team context is not to filter engineers but to calibrate competency levels and identify targeted areas for growth. A senior engineer who can correctly solve all four but cannot articulate the greedy choice property for any of them needs different coaching than one who can prove correctness but writes buggy Go code.
