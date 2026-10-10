## 83F.7 The Problem Progression System

Solving problems randomly is inefficient. This section provides a structured progression system that builds skills in the right order, uses spaced repetition to prevent forgetting, and tracks your speed improvement over time.

### Pattern-Based Practice (Not Random)

The core principle: practice by pattern, not by random selection. When you solve 5 two-pointer problems in a row, your brain builds the neural pathway for recognizing and applying the two-pointer pattern. When you solve 5 random problems, no pattern gets reinforced.

**Pattern progression order (follow this sequence):**

```
+-----------------------------------------------------------------------+
|              PATTERN PROGRESSION (RECOMMENDED ORDER)                  |
+-----------------------------------------------------------------------+
|                                                                       |
|  Phase 1: Fundamentals (Weeks 1-2)                                   |
|  1. Hash Map patterns                                                 |
|  2. Two Pointers (same direction)                                     |
|  3. Two Pointers (opposite direction)                                 |
|  4. Sliding Window (fixed size)                                       |
|  5. Sliding Window (variable size)                                    |
|                                                                       |
|  Phase 2: Core Structures (Weeks 3-4)                                |
|  6. Binary Search (standard)                                          |
|  7. Binary Search (on answer / boundary)                              |
|  8. Stack patterns                                                    |
|  9. BFS (trees)                                                       |
|  10. DFS (trees)                                                      |
|  11. Heap / Priority Queue                                            |
|                                                                       |
|  Phase 3: Advanced (Weeks 5-6)                                       |
|  12. Dynamic Programming (1D)                                         |
|  13. Dynamic Programming (2D)                                         |
|  14. Graph BFS/DFS                                                    |
|  15. Topological Sort                                                 |
|  16. Union-Find                                                       |
|  17. Backtracking                                                     |
|  18. Greedy                                                           |
|                                                                       |
|  Phase 4: Specialized (Weeks 7+, as needed)                          |
|  19. Trie                                                              |
|  20. Monotonic Stack/Queue                                            |
|  21. Bit Manipulation                                                 |
|  22. Interval problems                                                |
|  23. Prefix Sum / Difference Array                                    |
|  24. Binary Search on Answer                                          |
|                                                                       |
+-----------------------------------------------------------------------+
```

### Difficulty Ramp

For each pattern, follow this difficulty progression:

```
+-----------------------------------------------------------------------+
|              DIFFICULTY RAMP PER PATTERN                              |
+-----------------------------------------------------------------------+
|                                                                       |
|  Day 1: Learn the pattern                                             |
|  ├── Read the theory (this book's relevant chapter)                  |
|  ├── Study 2 solved examples                                         |
|  └── Solve 2 easy problems using the pattern                         |
|                                                                       |
|  Day 2: Apply the pattern                                             |
|  ├── Solve 3 easy problems (speed focus, <10 min each)              |
|  └── Solve 2 medium problems (20 min each)                           |
|                                                                       |
|  Day 3: Deepen the pattern                                            |
|  ├── Solve 3 medium problems (timed)                                 |
|  └── Attempt 1 hard problem (35 min limit)                           |
|                                                                       |
|  Day 4: Review and integrate                                          |
|  ├── Re-solve Day 1-3's hardest problems from memory                |
|  └── Solve 2 mixed problems (this pattern + earlier patterns)        |
|                                                                       |
+-----------------------------------------------------------------------+
```

### Spaced Repetition Schedule

The forgetting curve means you will lose 80% of what you learned within a week if you do not review. Use this spaced repetition schedule:

| Review Timing | What to Review | How |
|---------------|---------------|-----|
| Same day (evening) | All problems from today's session | Re-read your solutions, note key insights |
| Next day (morning) | Yesterday's hardest problem | Re-solve from scratch, without looking at notes |
| 3 days later | Hardest problem from each pattern last week | Re-solve, compare to original solution |
| 1 week later | All patterns from 1 week ago (quick quiz) | Read problem statement, write approach in 2 min, move on |
| 2 weeks later | Any problems you scored <3 on from 2 weeks ago | Full re-solve under time pressure |

### The "3 Attempts" Rule

When you encounter a hard problem:

**Attempt 1 (25-35 minutes):** Try to solve it independently. If stuck after 10 minutes with no approach, spend 5 minutes drawing examples and looking for patterns. If still stuck after 25-35 minutes total, stop.

**Review the solution:** Read the editorial or discussion. Do not just read the code - understand the intuition. Why does this approach work? What pattern does it follow? Write a 2-sentence explanation in your own words.

**Attempt 2 (next day):** Re-solve from memory. Solving it within 80% of the time target confirms retention. If not, review again.

**Attempt 3 (1 week later):** Re-solve cold. This is the true test. If you can solve it from scratch within the time target, the pattern is internalized. If not, add it to your weak-area list for additional review.

### Tracking Your Speed Over Time

Maintain a speed log. This is one of the most motivating tracking tools because you can see concrete improvement.

| Date | Problem | Difficulty | Pattern | Time (min) | Solved? | Notes |
|------|---------|------------|---------|------------|---------|-------|
| Week 1 | Two Sum | Easy | Hash map | 12 | Yes | Slow on initial approach |
| Week 3 | Two Sum | Easy | Hash map | 4 | Yes | Automatic now |
| Week 1 | 3Sum | Medium | Two pointers | 35 | Partial | Forgot to handle duplicates |
| Week 4 | 3Sum | Medium | Two pointers | 14 | Yes | Clean solution |

**Speed targets by difficulty and phase:**

| Difficulty | Weeks 1-4 | Weeks 5-8 | Weeks 9-12 |
|------------|-----------|-----------|------------|
| Easy | <15 min | <10 min | <7 min |
| Medium | <30 min | <22 min | <18 min |
| Hard | <45 min | <35 min | <30 min |

### Go-Specific Snippet Library

Build a personal snippet library in Go that you can write from memory during interviews. Practice writing each snippet without any reference until it is automatic.

**Essential snippets to memorize:**

1. **Min-heap and max-heap** (using `container/heap`)
2. **Union-Find** with path compression and union by rank
3. **BFS template** (queue-based, with visited tracking)
4. **DFS template** (recursive, with visited tracking)
5. **Binary search template** (left/right boundary variants)
6. **Backtracking template** (with state management)
7. **Trie** (insert, search, prefix search)
8. **Topological sort** (BFS/Kahn's algorithm)
9. **Sliding window** (variable size template)
10. **Custom sort** (using `slices.SortFunc`)

Reference: Chapter 78b (Coding Interview Patterns) for Go implementations of each.


### Junior → FAANG: Problem Progression for Coding Practice

A problem progression system structures your coding practice to build skills systematically rather than randomly. The recommended progression: start with easy problems in each pattern area to build pattern recognition, move to medium problems for each pattern to develop implementation fluency, and then practice medium-to-hard problems under timed conditions. Track your performance per pattern area (arrays, trees, graphs, DP, etc.) to identify where additional practice is needed. The common mistake is spending too much time on hard problems too early before the easy and medium patterns are solid.

### Senior @ FAANG: Problem Progression as a Competency-Building Infrastructure

Senior candidates using the problem progression system should add a second axis to the progression: problem quality over problem quantity. For an L6 candidate, the value of coding practice is not in solving more problems but in increasing the depth of discussion around each problem: can you articulate three approaches with their trade-offs, implement the optimal approach cleanly, and defend your complexity analysis under probing? Practicing 5 problems at this depth is more valuable than practicing 20 problems at surface level. The senior-level problem progression system also includes a review step: for each problem, after arriving at a solution, look at the top community solutions and identify whether any approach is meaningfully better and why. This external calibration prevents the trap of becoming fluent in a sub-optimal approach.

---
